/**
 * Shared, dependency-free test doubles.
 *
 * `createFakeClient` mirrors the MAX transport surface used by the plugin,
 * `createFakeCtx` mimics the small Cordis subset the plugin needs (events,
 * services, `logger()` and `effect()`), and `createFakeWebServer` models the
 * `webServer` route registry. Nothing here touches the network, the real DSH
 * host or the filesystem, so the fakes are safe in every test file.
 *
 * These are test-only doubles, not a spec of the real APIs: they record calls
 * and return plausible values so teardown/lifecycle tests can assert what the
 * plugin did without depending on a live MAX bot.
 */

/** Resolve after one event-loop turn (or the given delay). */
export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll `predicate` until it returns truthy.
 * @param {() => unknown} predicate
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await tick(intervalMs)
  }
}

/**
 * Await `promise` while keeping the event loop referenced until it settles.
 *
 * The plugin deliberately calls `unref()` on its approval timeout timer (a
 * forgotten approval card must not keep the host process alive), and
 * `AbortSignal.timeout()` is unref'd by Node as well. On Node 20/22 a test that
 * awaits a promise settling only through such a timer lets the event loop drain,
 * and the test runner cancels the still-pending test
 * (`Promise resolution is still pending but the event loop has already resolved`).
 * Polling with referenced `tick()` timers keeps the test process alive for the
 * exact window the test needs, instead of a file-wide keepalive hack.
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 * @returns {Promise<T>}
 */
export async function awaitSettled(promise, { timeoutMs = 5000, intervalMs = 10, label = 'promise' } = {}) {
  let state = 'pending'
  let value
  let failure
  const tracked = Promise.resolve(promise).then(
    (result) => {
      value = result
      state = 'fulfilled'
    },
    (error) => {
      failure = error
      state = 'rejected'
    },
  )
  const deadline = Date.now() + timeoutMs
  while (state === 'pending') {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} to settle`)
    await tick(intervalMs)
  }
  await tracked
  if (state === 'rejected') throw failure
  return value
}

/** Default `uploadTypeFor`: image extensions are images, everything else is a file. */
const defaultUploadTypeFor = (filePath) => (/\.(png|jpe?g|gif|webp)$/i.test(String(filePath)) ? 'image' : 'file')

/**
 * Minimal Cordis-like context.
 *
 * `effect(fn)` runs `fn` immediately and remembers the disposer it returns,
 * exactly like Cordis does. `disposeEffects()` runs them in reverse registration
 * order (the Cordis unload order). The returned wrapper is deliberately not
 * memoized: Cordis calls a disposer once, but the plugin itself must survive a
 * second call during HMR, so tests may invoke it twice and assert no throw.
 *
 * @param {{services?: Record<string, unknown>}} [options]
 */
export function createFakeCtx({ services = {} } = {}) {
  const listeners = new Map()
  const logs = []
  const effects = []
  const log = (level) => (...args) => logs.push([level, ...args])
  const logger = {
    error: log('error'),
    warn: log('warn'),
    info: log('info'),
    debug: log('debug'),
  }
  const ctx = {
    get: (name) => services[name],
    logger: () => logger,
    on: (name, fn) => {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect: (fn) => {
      const disposer = fn()
      const dispose = async () => {
        await disposer?.()
      }
      effects.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    logs,
    effects,
    listenerCount: (name) => (listeners.get(name) ?? []).length,
    emit: (name, ...args) => {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
    },
    /** Run every captured effect disposer (latest first), like a Cordis fiber unload. */
    disposeEffects: async () => {
      for (const dispose of [...effects].reverse()) await dispose()
    },
  }
}

/**
 * MAX transport double. Every method resolves; sends/uploads/edits/answers are
 * recorded in the arrays below so each test can assert in its own vocabulary.
 *
 * Recording arrays:
 *  - `sent` (alias `sends`): params of every `sendMessage`/`sendText`/`sendWithAttachments`;
 *  - `uploads`: params of every `uploadMedia`;
 *  - `edits`: params of every `editMessage`;
 *  - `answers`: `{callbackId, body}` of every `answerCallback`;
 *  - `deleted`: message ids passed to `deleteMessage`;
 *  - `actions`: `{chatId, action}` of every positional `sendAction(chatId, action)`;
 *  - `calls`: flat `[name, ...args]` log for the remaining endpoints.
 *
 * Pass `overrides` to replace individual methods (e.g. a failing `uploadMedia`);
 * because those overrides are copied onto the returned client, replacing a method
 * later (`client.uploadMedia = ...`) keeps working as well.
 *
 * @param {Record<string, unknown>} [overrides]
 */
export function createFakeClient(overrides = {}) {
  const sent = []
  const uploads = []
  const calls = []
  const edits = []
  const answers = []
  const deleted = []
  const actions = []
  const record = (name, ...args) => calls.push([name, ...args])
  const client = {
    sent,
    sends: sent,
    uploads,
    calls,
    edits,
    answers,
    deleted,
    actions,
    getMe: async () => {
      record('getMe')
      return { user_id: 7001, username: 'fake_bot', name: 'Fake Bot' }
    },
    getChat: async (chatId) => {
      record('getChat', chatId)
      return { chat_id: String(chatId), type: 'dialog', dialog_with_user: { user_id: 7001 } }
    },
    getUpdates: async (params = {}) => {
      record('getUpdates', params)
      return { updates: [], marker: 0 }
    },
    getSubscriptions: async () => ({ subscriptions: [] }),
    subscribeWebhook: async (params) => {
      record('subscribeWebhook', params)
      return { ok: true }
    },
    unsubscribeWebhook: async (url) => {
      record('unsubscribeWebhook', url)
      return { ok: true }
    },
    setCommands: async (commands) => {
      record('setCommands', commands)
      return { ok: true }
    },
    sendMessage: async (params) => {
      sent.push(params)
      return { message: { body: { mid: `mid-${sent.length}` } } }
    },
    sendText: async (params) => client.sendMessage(params),
    sendWithAttachments: async (params) => client.sendMessage(params),
    editMessage: async (params) => {
      edits.push(params)
      record('editMessage', params)
      return { ok: true }
    },
    deleteMessage: async (messageId) => {
      deleted.push(messageId)
      record('deleteMessage', messageId)
      return { ok: true }
    },
    answerCallback: async (callbackId, payload) => {
      answers.push({ callbackId, body: payload })
      record('answerCallback', callbackId, payload)
      return { ok: true }
    },
    sendAction: async (chatId, action) => {
      actions.push({ chatId, action })
      record('sendAction', chatId, action)
      return { ok: true }
    },
    uploadMedia: async (params = {}) => {
      uploads.push(params)
      const type =
        params.type ??
        defaultUploadTypeFor(params.filePath ?? params.filename ?? '')
      return { token: `token-${type}`, type, name: params.filename }
    },
    uploadTypeFor: defaultUploadTypeFor,
    ...overrides,
  }
  return client
}

/**
 * Minimal `webServer` service: the exact/prefix route tables and a `register()`
 * that returns an idempotent disposer, so tests can observe route teardown.
 */
export function createFakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  const registered = []
  const disposed = []
  const webServer = {
    exact,
    prefixes,
    registered,
    disposed,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
      registered.push(route)
      let done = false
      return () => {
        if (done) return
        done = true
        if (table.get(route.path) === route) table.delete(route.path)
        disposed.push(route)
      }
    },
  }
  return webServer
}
