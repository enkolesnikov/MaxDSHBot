/**
 * Regression tests for the 1.9.0 split of index.js.
 *
 * The extraction targets are `lib/webhook-runtime.mjs` (route/runtime lifecycle,
 * save-before-200 durability, subscription guard) and `lib/deliver.mjs` (final
 * reply pipeline). These tests pin the contracts that are easy to break while
 * moving code and are not covered by the broad index.test.mjs scenarios:
 *
 *  1. a webhook update is persisted to disk BEFORE the HTTP 200 is written, the
 *     route is really registered through the fake `webServer`, a failed durable
 *     save answers 503 (so MAX retries) and a replayed update is deduped;
 *  2. `deliver()` under `dryRun` formats/chunks and returns without a single
 *     send/upload/outbox call;
 *  3. the preferred `/new` workspace lives in a single store: `/workspace N`
 *     writes it through the bot runtime and `/new` reads it back through the
 *     runtime getter used by createSession.
 *
 * Everything is faked: no network, no live DSH host, no real MAX bot.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createState } from '../lib/state.mjs'
import { createHealth } from '../lib/health.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { createWebhookRuntime } from '../lib/webhook-runtime.mjs'
import { createDeliver } from '../lib/deliver.mjs'
import { splitText, MAX_TEXT_LIMIT } from '../lib/transport.mjs'
import { formatNotification } from '../lib/format.mjs'
import { buildTableFiles } from '../lib/tables.mjs'
import { shouldSpeak, synthesizeSpeech } from '../lib/tts.mjs'
import { createFakeClient, createFakeCtx, createFakeWebServer, tick, waitFor } from './helpers/fakes.mjs'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-max-notify-split-'))
// The plugin half of this file resolves its durable defaults under DSH_HOME.
process.env.DSH_HOME = TEST_HOME

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

const WEBHOOK_SECRET = 'split-regression-0123456789abcdef0123456789'

function silentLogger() {
  const logs = []
  const log = (level) => (...args) => logs.push([level, ...args])
  return { logs, error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') }
}

/** MINIMAL MAX update the webhook handler expects (secret is checked first). */
function messageUpdate(text, mid) {
  return {
    update_type: 'message_created',
    chat_id: 1,
    message: {
      sender: { user_id: 7001 },
      recipient: { chat_id: 1 },
      body: { text, mid },
    },
  }
}

function webhookRequest({ secret, update, method = 'POST' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = secret === undefined ? {} : { 'x-max-bot-api-secret': secret }
  req.destroy = () => {}
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(update)))
    req.emit('end')
  })
  return req
}

/** Response double; `onEnd` runs exactly when the handler writes the answer. */
function webhookResponse(onEnd) {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(value) {
      this.body = String(value ?? '')
      onEnd?.(this)
    },
  }
}

/** Fresh webhook runtime over a real durable state file and a fake webServer. */
function createWebhookHarness({ stateFile, bot }) {
  const logger = silentLogger()
  const health = createHealth({ version: 'test' })
  const audit = { writes: [], write(entry) { this.writes.push(entry) } }
  const state = createState({ file: stateFile, logger, chatId: '1' })
  const config = normalizeConfig({
    botToken: 't',
    chatId: '1',
    allowedChatIds: ['1'],
    transport: 'webhook',
    webhookSecret: WEBHOOK_SECRET,
    webhookAutoSubscribe: false,
    stateFile,
  })
  const webServer = createFakeWebServer()
  const fake = createFakeCtx()
  const runtime = createWebhookRuntime({
    state,
    health,
    logger,
    audit,
    bot,
    config,
    client: createFakeClient(),
    getService: () => webServer,
    isDisposed: () => false,
    redactUpdate: () => '[redacted update]',
    context: fake.ctx,
    writeHeartbeat: () => {},
    clearFallbackTimer: () => {},
  })
  return { runtime, state, health, audit, logger, config, webServer, fake, stateFile }
}

/**
 * A bot double whose `applyUpdate` blocks on a gate. It keeps the drain loop
 * parked so the test can inspect the exact moment the HTTP 200 is written.
 */
function createGatedBot() {
  const applied = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let parked = false
  const applyUpdate = async (update) => {
    applied.push(update)
    if (!parked) {
      parked = true
      await gate
    }
    if (update?.id !== undefined) stateRef.markProcessed(`id:${update.id}`)
    return true
  }
  // `markProcessed` must be visible to applyUpdate: wired after the state exists.
  let stateRef
  return {
    bot: {
      updateKey: (update) => (update?.id === undefined ? undefined : `id:${update.id}`),
      applyUpdate,
      stopPolling: () => {},
    },
    applied,
    release: () => release(),
    bindState: (state) => { stateRef = state },
  }
}

test('webhook accept is durable: save happens before 200, route is registered, replays are deduped', async () => {
  const stateFile = join(TEST_HOME, 'durable-state.json')
  const gated = createGatedBot()
  const harness = createWebhookHarness({ stateFile, bot: gated.bot })
  gated.bindState(harness.state)
  const { runtime, state, webServer, fake, config } = harness

  try {
    assert.equal(runtime.active, false)
    assert.equal(runtime.registerWebhook(webServer, fake.ctx), true)
    assert.equal(runtime.active, true)
    assert.equal(config.polling, false, 'a registered webhook must disable long polling')
    const route = webServer.exact.get(config.webhookPath)
    assert.ok(route, 'the fake webServer must hold the exact webhook route')
    assert.equal(route.kind, 'exact')
    assert.equal(webServer.registered.filter((item) => item.path === config.webhookPath).length, 1)
    // A second registration on the same generation is a no-op success.
    assert.equal(runtime.registerWebhook(webServer, fake.ctx), true)
    assert.equal(webServer.registered.filter((item) => item.path === config.webhookPath).length, 1)

    // Record the order of the durable write vs. the HTTP answer.
    const events = []
    const realSave = state.save.bind(state)
    state.save = () => {
      events.push('save')
      return realSave()
    }

    const update = { id: 1, update_type: 'message_created' }
    const first = webhookResponse((res) => {
      events.push('respond')
      try {
        res.queueOnDisk = JSON.parse(readFileSync(stateFile, 'utf8')).webhookQueue
      } catch (error) {
        res.queueOnDisk = error
      }
    })
    await route.handler(webhookRequest({ secret: WEBHOOK_SECRET, update }), first)

    assert.equal(first.statusCode, 200)
    assert.deepEqual(events, ['save', 'respond'], 'the durable save must run before the 200 is written')
    assert.ok(Array.isArray(first.queueOnDisk), 'the state file must exist when the 200 is written')
    assert.equal(first.queueOnDisk.length, 1, 'the accepted update must already be on disk at response time')
    assert.equal(first.queueOnDisk[0].update.id, 1)

    // The drain loop is parked in applyUpdate: a replay while the update is
    // still queued must not enqueue it twice.
    const whileQueued = webhookResponse()
    await route.handler(webhookRequest({ secret: WEBHOOK_SECRET, update }), whileQueued)
    assert.equal(whileQueued.statusCode, 200)
    assert.equal(state.getWebhookQueue().length, 1)
    assert.deepEqual(events, ['save', 'respond'], 'a duplicate in the queue must not cause another save')

    // Let the parked drain finish: the queue is persisted empty and processed.
    gated.release()
    await waitFor(() => state.getWebhookQueue().length === 0 && gated.applied.length === 1, {
      label: 'webhook queue drain',
    })
    assert.equal(gated.applied.length, 1)

    // Replay after processing is skipped by the durable processed-key set.
    const afterProcessed = webhookResponse()
    await route.handler(webhookRequest({ secret: WEBHOOK_SECRET, update }), afterProcessed)
    assert.equal(afterProcessed.statusCode, 200)
    await tick(20)
    assert.equal(gated.applied.length, 1, 'a processed update must never be applied twice')
    assert.equal(state.getWebhookQueue().length, 0)
  } finally {
    runtime.dispose()
    await fake.disposeEffects()
    state.dispose()
  }
})

test('webhook accept answers 503 when the durable save fails, so MAX retries', async () => {
  const stateFile = join(TEST_HOME, 'failed-save-state.json')
  const gated = createGatedBot()
  const harness = createWebhookHarness({ stateFile, bot: gated.bot })
  gated.bindState(harness.state)
  const { runtime, state, webServer, fake, config } = harness

  try {
    assert.equal(runtime.registerWebhook(webServer, fake.ctx), true)
    const route = webServer.exact.get(config.webhookPath)
    const realSave = state.save.bind(state)
    state.save = () => {
      throw new Error('disk full')
    }
    const response = webhookResponse()
    await route.handler(webhookRequest({ secret: WEBHOOK_SECRET, update: { id: 2, update_type: 'message_created' } }), response)
    assert.equal(response.statusCode, 503, 'MAX must retry an update that could not be persisted')
    assert.equal(gated.applied.length, 0, 'an unsaved update must not be processed')
    state.save = realSave
  } finally {
    runtime.dispose()
    await fake.disposeEffects()
    state.dispose()
  }
})

test('deliver under dryRun formats and chunks but never sends, uploads or queues', async () => {
  const logger = silentLogger()
  const client = createFakeClient()
  const calls = { keyboard: 0, images: 0, outbox: 0, anchors: 0 }
  const config = normalizeConfig({
    botToken: 't',
    chatId: '1',
    dryRun: true,
    buttons: false,
    tableFiles: false,
    forwardImages: false,
    threads: false,
    voiceTts: false,
  })
  const deliver = createDeliver({
    client,
    config,
    logger,
    state: {
      getAnchor: () => {
        calls.anchors += 1
        return undefined
      },
      mapMessage: () => {},
      setAnchor: () => {},
    },
    policy: { decide: () => ({ send: true, notify: true }) },
    ensureTargetAllowed: async () => true,
    resolveTitle: () => 'split-test',
    formatNotification,
    splitText,
    maxTextLimit: MAX_TEXT_LIMIT,
    buildTableFiles,
    finalKeyboard: () => {
      calls.keyboard += 1
      return undefined
    },
    collectFinalImages: async () => {
      calls.images += 1
      return []
    },
    outbox: {
      deliverNow: async () => {
        calls.outbox += 1
        return { queued: true }
      },
    },
    shouldSpeak,
    synthesizeSpeech,
    uploadAndSendAudio: async () => {
      throw new Error('TTS must not run in dry-run')
    },
    noteSession: () => {},
  })

  const session = { id: 'session-dry', header: { cwd: '/tmp/split-work' } }
  await deliver(session, 'готовый ответ', { kind: 'completed' }, { role: 'assistant', content: [] }, [], 1, 1)

  assert.equal(client.sent.length, 0, 'dryRun must never call sendMessage')
  assert.equal(client.uploads.length, 0, 'dryRun must never upload media')
  assert.equal(calls.outbox, 0, 'dryRun must never touch the outbox')
  assert.equal(calls.keyboard, 0, 'dryRun returns before the inline keyboard is built')
  assert.equal(calls.images, 0, 'dryRun returns before image collection')
  assert.equal(calls.anchors, 0, 'dryRun returns before threading state is read')
  const dryRunLogs = logger.logs.filter(([level, message]) => level === 'info' && String(message).includes('[dry-run] would send'))
  assert.equal(dryRunLogs.length, 1, 'the dry-run log line must prove the pipeline actually ran')
  assert.equal(dryRunLogs[0][1], '[dry-run] would send %d chunk(s) to MAX: %s')
  assert.equal(dryRunLogs[0][2], 1, 'a short answer must be a single chunk')
  assert.ok(String(dryRunLogs[0][3]).startsWith('🕒 '), 'the dry-run log must show the formatted payload prefix')
})

test('preferred workspace: /workspace N writes the single store and /new reads it via the runtime getter', async () => {
  // Dynamic import: the plugin snapshots DSH_HOME when apply() runs.
  const { apply } = await import('../index.js')
  const workspaceDir = mkdtempSync(join(TEST_HOME, 'workspace-'))
  const webServer = createFakeWebServer()
  const created = []
  const services = {
    webServer,
    workspaceRegistry: {
      list: () => [{ id: 'ws-1', path: workspaceDir, title: 'Split workspace' }],
    },
    sessionController: {
      async list() {
        return { items: [] }
      },
      async create({ cwd }) {
        created.push(cwd)
        return { sessionId: 'session-split-new' }
      },
    },
  }
  const fake = createFakeCtx({ services })
  const client = createFakeClient()
  apply(
    fake.ctx,
    {
      botToken: 't',
      chatId: '1',
      allowedChatIds: ['1'],
      transport: 'webhook',
      webhookSecret: WEBHOOK_SECRET,
      webhookAutoSubscribe: false,
      stateFile: join(TEST_HOME, 'workspace-state.json'),
      outboxFile: join(TEST_HOME, 'workspace-outbox.json'),
      auditFile: join(TEST_HOME, 'workspace-audit.jsonl'),
    },
    { createClient: () => client },
  )

  try {
    const route = webServer.exact.get('/max/webhook')
    assert.ok(route, 'the sync setup path must register the webhook route')

    const sendCommand = async (text, mid) => {
      const before = client.sent.length
      const response = webhookResponse()
      await route.handler(webhookRequest({ secret: WEBHOOK_SECRET, update: messageUpdate(text, mid) }), response)
      assert.equal(response.statusCode, 200)
      await waitFor(() => client.sent.length > before, { label: `MAX reply to ${text}` })
      return client.sent.at(-1)
    }

    const picked = await sendCommand('/workspace 1', 'split-mid-workspace')
    assert.match(picked.text, /Новые сессии \(\/new\)/)
    assert.ok(picked.text.includes(workspaceDir), 'the selection reply must mention the workspace path')

    const newSession = await sendCommand('/new', 'split-mid-new')
    assert.deepEqual(created, [workspaceDir], '/new must use the workspace stored by /workspace through the runtime getter')
    assert.ok(newSession.text.includes(workspaceDir), 'the created-session reply must show the preferred cwd')
  } finally {
    await fake.disposeEffects()
  }
})

test('webhookRemoveOnStop unsubscribes even though the route disposer clears active', async () => {
  const { apply } = await import('../index.js')
  const webServer = createFakeWebServer()
  const unsubscribed = []
  const client = createFakeClient({
    unsubscribeWebhook: async (url) => {
      unsubscribed.push(url)
      return { ok: true }
    },
  })
  const fake = createFakeCtx({ services: { webServer } })
  apply(
    fake.ctx,
    {
      botToken: 't',
      chatId: '42',
      allowedUserIds: ['42'],
      transport: 'webhook',
      webhookSecret: WEBHOOK_SECRET,
      webhookPublicUrl: 'https://example.test/max/webhook',
      webhookRemoveOnStop: true,
      webhookAutoSubscribe: false,
      notifyOnStart: false,
      stateFile: join(TEST_HOME, 'remove-on-stop-state.json'),
      outboxFile: join(TEST_HOME, 'remove-on-stop-outbox.json'),
      auditFile: join(TEST_HOME, 'remove-on-stop-audit.jsonl'),
    },
    { createClient: () => client },
  )
  try {
    assert.ok(webServer.exact.get('/max/webhook'), 'the webhook route must be registered first')
    await fake.disposeEffects()
    await waitFor(() => unsubscribed.length === 1, { label: 'unsubscribe on stop' })
    assert.deepEqual(unsubscribed, ['https://example.test/max/webhook'])
  } finally {
    await fake.disposeEffects()
  }
})
