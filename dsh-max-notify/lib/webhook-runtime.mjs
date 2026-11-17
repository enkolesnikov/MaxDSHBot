/**
 * MAX webhook transport lifecycle (extracted from index.js, no behavior change).
 *
 * MAX POSTs every subscribed update to a public HTTPS endpoint. The handler
 * verifies the secret and hands the update to `acceptWebhookUpdate`, which
 * persists it durably BEFORE the HTTP 200 is written; processing happens after
 * the response through an idempotent queue drain. The runtime owns:
 *
 *  - route registration/replacement on the DSH `webServer` service (a stale
 *    route left by an HMR generation is replaced, never double-registered);
 *  - the durable accept path (dedupe key, count/byte caps, save-before-200);
 *  - the drain loop with a poison-update dead-letter fence (3 attempts);
 *  - the subscription generation guard (late API results from a previous
 *    generation are ignored);
 *  - start (drain + subscribe + 30 s retry timer) and stop/dispose.
 *
 * index.js keeps the host wiring only: rc.2 `ctx.inject` ordering, the 15 s
 * polling-fallback timer and the Cordis teardown call.
 */
import {
  createWebhookHandler,
  ensureWebhookSubscription,
  removeWebhookSubscription,
  WEBHOOK_BODY_BYTES_MAX,
} from './webhook.mjs'

/** Register a disposer with the owning Cordis fiber (when effect support exists). */
export function ownRoute(webCtx, dispose) {
  if (typeof webCtx?.effect === 'function' && typeof dispose === 'function') {
    try {
      webCtx.effect(() => () => {
        try {
          dispose()
        } catch {
          // already disposed
        }
      })
    } catch {
      // effect support is optional in minimal contexts
    }
  }
  return dispose
}

/** Register a named route; replace a stale route left by an HMR generation. */
export function registerRoute(webServer, route, logger) {
  const table = route.kind === 'exact' ? webServer.exact : webServer.prefixes
  if (table instanceof Map && table.has(route.path)) {
    logger?.warn?.('replacing stale webServer route %s', route.path)
    table.delete(route.path)
  }
  const dispose = webServer.register(route)
  return () => {
    try {
      if (table instanceof Map && table.get(route.path) !== route) return
    } catch {
      // fall through to the stock disposer
    }
    try {
      dispose()
    } catch {
      // already disposed
    }
  }
}

/**
 * @param {object} deps
 * @param {object} deps.state - durable state (webhook queue API).
 * @param {object} deps.health - health snapshot (`update`/`fail`).
 * @param {object} deps.logger - redacting logger.
 * @param {object} deps.audit - audit trail (`write`).
 * @param {object} deps.bot - remote-control bot (`updateKey`, `applyUpdate`,
 *   `stopPolling`).
 * @param {object} deps.config - normalized (mutable) plugin config.
 * @param {object} deps.client - MAX client (guarded proxy from index.js).
 * @param {(name: string) => any} [deps.getService] - host service accessor.
 * @param {() => boolean} [deps.isDisposed] - plugin disposed getter.
 * @param {(update: object) => string} [deps.redactUpdate] - redacted copy of an
 *   update for the dead-letter audit trail.
 * @param {object} [deps.context] - Cordis context used by the legacy
 *   `setupWebhook()` path.
 * @param {() => void} [deps.writeHeartbeat] - heartbeat writer (index.js).
 * @param {() => void} [deps.clearFallbackTimer] - clear the index-owned 15 s
 *   polling-fallback timer after the route is registered.
 */
export function createWebhookRuntime({
  state,
  health,
  logger,
  audit,
  bot,
  config,
  client,
  getService,
  isDisposed = () => false,
  redactUpdate = () => '[redacted update]',
  context,
  writeHeartbeat = () => {},
  clearFallbackTimer = () => {},
} = {}) {
  let routeDispose
  // Survives the route disposer so `webhookRemoveOnStop` still knows this
  // generation owned the route (the disposer clears `active` first).
  let everRegistered = false
  let active = false
  let draining = false
  // Bumped on every HMR generation / unsubscribe so late async results are ignored.
  let subscriptionGeneration = 0
  let retryTimer
  let subscribed = false
  let subscriptionError
  let runtimeStarted = false

  async function drainWebhookQueue() {
    if (draining || !active) return
    draining = true
    try {
      for (;;) {
        if (isDisposed()) break
        const queue = state.getWebhookQueue()
        if (queue.length === 0) break
        const entry = queue[0]
        try {
          await bot.applyUpdate(entry.update)
        } catch (error) {
          logger.warn('cannot process a webhook update: %s', error?.message || String(error))
          health.fail(error)
          const attempts = state.bumpWebhookHeadAttempts()
          if (attempts >= 3) {
            state.shiftWebhookQueue()
            state.save()
            audit.write({
              kind: 'webhook',
              action: 'dead-letter',
              attempts,
              error: error?.message || String(error),
              update: redactUpdate(entry.update),
            })
            logger.error?.('dropping poison webhook update after %d attempts: %s', attempts, error?.message || String(error))
            continue
          }
          break
        }
        const nextLength = state.shiftWebhookQueue()
        health.update({
          webhookQueueDepth: nextLength,
          webhookQueueBytes: state.getWebhookQueueBytes?.(),
          webhookLastProcessedAt: Date.now(),
        })
      }
    } finally {
      draining = false
      const queueStats = state.getWebhookQueueStats?.() ?? { depth: state.getWebhookQueue().length, bytes: undefined }
      health.update({ webhookQueueDepth: queueStats.depth, webhookQueueBytes: queueStats.bytes })
    }
  }

  /** Persist one MAX update durably, then answer 200; processing follows. */
  async function acceptWebhookUpdate(update) {
    if (isDisposed() || config.dryRun) return
    const key = bot.updateKey?.(update)
    if (key && state.hasProcessed(key)) return
    const queue = state.getWebhookQueue()
    if (key && queue.some((entry) => entry.key === key)) return
    if (queue.length >= config.webhookQueueMax) throw new Error('webhook queue is full')
    const result = state.pushWebhookQueue(
      { key, update, at: Date.now() },
      config.webhookQueueMax,
      config.webhookQueueBytesMax,
      config.webhookEntryBytesMax,
    )
    if (result.rejected) {
      // The HTTP layer already caps bodies; this is a second fence for direct
      // calls. Answering 200 avoids endless MAX retries for an unparkable update.
      logger.warn('dropped an oversized MAX webhook update (%s)', result.reason ?? 'bytes')
      audit.write({ kind: 'webhook', action: 'drop', reason: result.reason, bytes: result.bytes })
      health.update({ webhookLastDropAt: Date.now(), webhookQueueBytes: result.bytes })
      return
    }
    // Durability contract: the 200 must not be sent until the update is on disk.
    state.save()
    health.update({
      webhookLastAt: Date.now(),
      webhookQueueDepth: result.depth,
      webhookQueueBytes: result.bytes,
    })
    void drainWebhookQueue()
  }

  function registerWebhook(webServer, ownerCtx) {
    if (active) return true
    if (config.transport !== 'webhook') return false
    if (!config.interactive) {
      logger.info('webhook transport skipped: interactive remote control is off')
      return false
    }
    if (!config.webhookSecret) {
      logger.warn(
        config.webhookSecretInvalid
          ? 'webhook secret must be 32-256 chars [A-Za-z0-9_-]; falling back to long polling'
          : 'webhook transport requested without webhookSecret; falling back to long polling',
      )
      return false
    }
    if (!webServer?.register) {
      logger.warn('webhook transport requested but the DSH webServer service is unavailable; falling back to long polling')
      return false
    }
    try {
      const handler = createWebhookHandler({
        secret: config.webhookSecret,
        accept: acceptWebhookUpdate,
        logger,
        maxBytes: config.webhookEntryBytesMax ?? WEBHOOK_BODY_BYTES_MAX,
      })
      const disposeRoute = registerRoute(webServer, { kind: 'exact', path: config.webhookPath, handler }, logger)
      routeDispose = () => {
        try {
          disposeRoute()
        } finally {
          active = false
          runtimeStarted = false
          routeDispose = undefined
          if (retryTimer) {
            clearInterval(retryTimer)
            retryTimer = undefined
          }
        }
      }
      ownRoute(ownerCtx, routeDispose)
      everRegistered = true
      active = true
      config.polling = false
      // A polling fallback may already have started before the webServer service
      // became available; stop it so both transports never consume updates.
      try {
        bot.stopPolling?.()
      } catch {
        // best effort during early startup
      }
      health.update({ transport: 'webhook', webhookPath: config.webhookPath, webhookActive: true, webhookSetupError: undefined })
      clearFallbackTimer()
      logger.info('MAX webhook route registered: %s', config.webhookPath)
      writeHeartbeat()
      startWebhookRuntime()
      return true
    } catch (error) {
      logger.warn('cannot register the MAX webhook route %s: %s; falling back to long polling', config.webhookPath, error?.message || String(error))
      config.polling = true
      return false
    }
  }

  /** Legacy synchronous path for minimal test contexts without ctx.inject. */
  function setupWebhook(ownerCtx = context) {
    const ok = registerWebhook(getService?.('webServer'), ownerCtx)
    if (!ok) config.polling = true
    return ok
  }

  function startWebhookRuntime() {
    if (!active || runtimeStarted) return
    runtimeStarted = true
    void drainWebhookQueue()
    void startWebhookSubscription()
    retryTimer = setInterval(() => {
      void drainWebhookQueue()
    }, 30_000)
    retryTimer.unref?.()
  }

  async function startWebhookSubscription() {
    if (isDisposed() || !active || !config.webhookAutoSubscribe) return
    const generation = ++subscriptionGeneration
    const result = await ensureWebhookSubscription({
      client,
      url: config.webhookPublicUrl,
      secret: config.webhookSecret,
      updateTypes: config.webhookUpdateTypes,
      logger,
    })
    // HMR may have swapped generations while the API call was in flight.
    if (isDisposed() || generation !== subscriptionGeneration) return
    subscribed = result.ok === true
    subscriptionError = result.ok ? undefined : result.reason
    health.update({ webhookSubscribed: subscribed, webhookSubscriptionError: subscriptionError })
  }

  /**
   * Stop the runtime: invalidate in-flight subscription results, clear the retry
   * timer, dispose the route (which clears `active`) and, when configured,
   * remove the MAX subscription. Mirrors the historical teardown ordering of
   * index.js; the unsubscribe call is best-effort and generation-guarded.
   */
  function dispose() {
    subscriptionGeneration += 1
    if (retryTimer) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
    // Capture ownership before the route disposer clears `active`, otherwise
    // webhookRemoveOnStop could never fire.
    const ownedRoute = active || routeDispose !== undefined || everRegistered
    if (routeDispose) {
      try {
        routeDispose()
      } catch {
        // already disposed
      }
    }
    if (ownedRoute && config.webhookRemoveOnStop && config.webhookPublicUrl) {
      const generation = subscriptionGeneration
      void removeWebhookSubscription({ client, url: config.webhookPublicUrl, logger })
        .then?.((result) => {
          if (generation !== subscriptionGeneration) {
            logger.debug('ignoring stale webhook unsubscribe result after HMR')
          }
          return result
        })
        .catch?.((error) => {
          logger.warn('cannot remove MAX webhook subscription on stop: %s', error?.message || String(error))
        })
    }
  }

  return {
    registerWebhook,
    setupWebhook,
    acceptWebhookUpdate,
    drainWebhookQueue,
    start: startWebhookRuntime,
    dispose,
    /** True while this generation owns the webhook route. */
    get active() {
      return active
    },
    /** Whether the MAX subscription API confirmed the webhook. */
    get subscribed() {
      return subscribed
    },
    /** Last subscription failure (redacted by health on write). */
    get subscriptionError() {
      return subscriptionError
    },
  }
}
