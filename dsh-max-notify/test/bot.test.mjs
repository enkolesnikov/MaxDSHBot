import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'
import { createBot } from '../lib/bot.mjs'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(stepMs)
  }
  return predicate()
}

function createFakeClient() {
  const sent = []
  const callbacks = []
  const commands = []
  return {
    sent,
    callbacks,
    commands,
    async sendMessage(params) {
      sent.push(params)
      return { message: { body: { mid: `mid-${sent.length}` } } }
    },
    async answerCallback(callbackId, body) {
      callbacks.push({ callbackId, body })
    },
    async setCommands(list) {
      commands.push(list)
    },
    async getUpdates() {
      return { updates: [], marker: 1 }
    },
  }
}

function createMemoryState(initial = {}) {
  const sessions = { ...(initial.sessions ?? {}) }
  const processed = new Set(initial.processed ?? [])
  const messageSessions = { ...(initial.messageSessions ?? {}) }
  return {
    marker: initial.marker,
    sessions,
    messageSessions,
    findSessionByMid(mid) {
      return messageSessions[String(mid)]
    },
    mapMessage(sessionId, mid) {
      messageSessions[String(mid)] = String(sessionId)
    },
    processed,
    hasProcessed(key) {
      return processed.has(String(key))
    },
    markProcessed(key) {
      processed.add(String(key))
    },
    setMarker(value) {
      this.marker = value
    },
    sessionFor(chatId) {
      return sessions[String(chatId)]
    },
    setSession(chatId, sessionId) {
      sessions[String(chatId)] = String(sessionId)
    },
    forgetSession(chatId) {
      delete sessions[String(chatId)]
    },
  }
}

function config(overrides = {}) {
  return normalizeConfig({
    botToken: 'token',
    chatId: '123456789',
    allowedUserIds: ['987654321'],
    greeting: false,
    greetOnStart: false,
    ...overrides,
  })
}

function runtimeStub(overrides = {}) {
  const sessions = [
    { sessionId: 'session-aaaaaaaa', running: true, cwd: '/work/app', updatedAt: 2, title: 'Рабочая' },
    { sessionId: 'session-bbbbbbbb', running: false, cwd: '/work/lib', updatedAt: 1, title: 'Старая' },
  ]
  const calls = { prompts: [], cancels: [], incoming: [] }
  return {
    calls,
    runtime: {
      listSessions: async () => sessions,
      statusInfo: async (sessionId) => ({
        sessionId,
        title: sessionId === 'session-aaaaaaaa' ? 'Рабочая' : 'Старая',
        running: sessionId === 'session-aaaaaaaa',
        agentStatus: sessionId === 'session-aaaaaaaa' ? 'busy' : 'idle',
        model: 'deepseek-flash',
        provider: 'deepseek',
        cwd: '/work/app',
        updatedAt: 2,
      }),
      promptSession: async (sessionId, text) => {
        calls.prompts.push({ sessionId, text })
        return true
      },
      cancelSession: async (sessionId) => {
        calls.cancels.push(sessionId)
        return true
      },
      titleFor: (id) => (String(id) === 'session-aaaaaaaa' ? 'Рабочая' : 'Старая'),
      createSession: async (sessionId, sessionArg) => {
        calls.created = calls.created ?? []
        calls.created.push({ sessionId, sessionArg })
        return { ok: true, sessionId: 'session-created', cwd: '/work/app/max' }
      },
      saveIncoming: async (attachments, sessionId) => {
        calls.incoming.push({ attachments, sessionId })
        return {
          saved: [{ path: '/work/app/max-inbox/2026-10-27-1-report.pdf', name: 'report.pdf', type: 'file', bytes: 42 }],
          errors: [],
          dir: '/work/app/max-inbox',
          promptText: 'Пользователь прислал файлы из MAX:\n• /work/app/max-inbox/report.pdf',
        }
      },
      ...overrides,
    },
  }
}

function makeBot(overrides = {}) {
  const client = createFakeClient()
  const state = createMemoryState(overrides.state)
  const { runtime: baseRuntime, calls } = runtimeStub()
  const runtime = { ...baseRuntime, ...(overrides.runtime ?? {}) }
  const bot = createBot({
    client,
    config: config(overrides.config),
    logger: { info() {}, warn() {}, debug() {} },
    state,
    interactions: overrides.interactions,
    runtime,
    policy: overrides.policy,
    observer: overrides.observer,
    health: overrides.health,
    version: overrides.version,
    outbox: overrides.outbox,
    limiter: overrides.limiter,
    audit: overrides.audit,
  })
  return { bot, client, state, runtime, calls }
}

function messageUpdate({ text, userId = 987654321, chatId = 123456789, isBot = false } = {}) {
  return {
    update_type: 'message_created',
    chat_id: chatId,
    message: {
      sender: { user_id: userId, is_bot: isBot },
      recipient: { chat_id: chatId },
      body: { text, attachments: [], mid: `mid-${text}-${userId}-${chatId}` },
    },
  }
}

test('plain MAX text is injected into the active session and confirmed', async () => {
  const { bot, client, calls } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: 'сделай ревью' }))
  assert.deepEqual(calls.prompts, [{ sessionId: 'session-aaaaaaaa', text: 'сделай ревью' }])
  assert.equal(client.sent.length, 1)
  assert.match(client.sent[0].text, /Отправлено в «Рабочая»/)
})

test('/help and unknown commands answer with the command list', async () => {
  const { bot, client } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: '/help' }))
  assert.match(client.sent[0].text, /Пульт DSH/)
  assert.match(client.sent[0].text, /\/status/)
  await bot.handleUpdate(messageUpdate({ text: '/nope' }))
  assert.match(client.sent[1].text, /Неизвестная команда/)
})

test('/status shows the active session, model and state', async () => {
  const { bot, client } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: '/status' }))
  assert.match(client.sent[0].text, /Статус/)
  assert.match(client.sent[0].text, /Рабочая/)
  assert.match(client.sent[0].text, /deepseek\/deepseek-flash/)
  assert.match(client.sent[0].text, /работает/)
})

test('/sessions lists sessions and /use switches the active one', async () => {
  const { bot, client, state } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: '/sessions' }))
  assert.match(client.sent[0].text, /Сессии/)
  assert.match(client.sent[0].text, /1\) «Рабочая»/)
  assert.match(client.sent[0].text, /2\) «Старая»/)

  await bot.handleUpdate(messageUpdate({ text: '/use 2' }))
  assert.equal(state.sessionFor(123456789), 'session-bbbbbbbb')
  assert.match(client.sent[1].text, /Активная сессия/)

  await bot.handleUpdate(messageUpdate({ text: '/use 9' }))
  assert.match(client.sent[2].text, /Укажи номер/)
})

test('/stop cancels the active session', async () => {
  const { bot, client, calls } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: '/stop' }))
  assert.deepEqual(calls.cancels, ['session-aaaaaaaa'])
  assert.match(client.sent[0].text, /Остановлено/)
})

test('messages from a non-allowlisted user are ignored', async () => {
  const { bot, client, calls } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: 'привет', userId: 111 }))
  assert.equal(calls.prompts.length, 0)
  assert.equal(client.sent.length, 0)
})

test('bot messages are ignored', async () => {
  const { bot, calls } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: 'эхо', isBot: true }))
  assert.equal(calls.prompts.length, 0)
})

test('quick-action callbacks continue and stop a session', async () => {
  const { bot, client, calls } = makeBot()
  await bot.handleUpdate({
    update_type: 'message_callback',
    callback: {
      callback_id: 'cb-cont',
      payload: JSON.stringify({ t: 'qa', a: 'cont', s: 'session-aaaaaaaa' }),
      user: { user_id: 987654321 },
    },
    message: { recipient: { chat_id: 123456789 }, sender: { user_id: 1 } },
  })
  assert.equal(client.callbacks[0].callbackId, 'cb-cont')
  assert.deepEqual(calls.prompts, [{ sessionId: 'session-aaaaaaaa', text: 'продолжай' }])

  await bot.handleUpdate({
    update_type: 'message_callback',
    callback: {
      callback_id: 'cb-stop',
      payload: JSON.stringify({ t: 'qa', a: 'stop', s: 'session-aaaaaaaa' }),
      user: { user_id: 987654321 },
    },
    message: { recipient: { chat_id: 123456789 } },
  })
  assert.deepEqual(calls.cancels, ['session-aaaaaaaa'])
})

test('callbacks from a non-allowlisted user are rejected', async () => {
  const { bot, client, calls } = makeBot()
  await bot.handleUpdate({
    update_type: 'message_callback',
    callback: { callback_id: 'cb-x', payload: '{}', user: { user_id: 111 } },
    message: { recipient: { chat_id: 123456789 } },
  })
  assert.equal(client.callbacks[0].body.notification, 'Нет доступа.')
  assert.equal(calls.prompts.length, 0)
})

test('pollOnce primes the marker first and then processes new updates', async () => {
  const client = createFakeClient()
  const state = createMemoryState()
  const { runtime } = runtimeStub()
  let updateBatch = []
  client.getUpdates = async (params) => {
    if (params.marker === undefined) return { updates: [], marker: 555 }
    return { updates: updateBatch, marker: 777 }
  }
  const bot = createBot({
    client,
    config: config(),
    logger: { info() {}, warn() {}, debug() {} },
    state,
    runtime,
  })

  const primed = await bot.pollOnce()
  assert.deepEqual(primed, { primed: true, count: 0, handled: 0 })
  assert.equal(state.marker, 555)

  updateBatch = [messageUpdate({ text: 'из поллинга' })]
  const next = await bot.pollOnce()
  assert.deepEqual(next, { primed: false, count: 1, handled: 1 })
  assert.equal(state.marker, 777)
})

test('bot registers the command menu', async () => {
  const { bot, client } = makeBot()
  await bot.registerCommands()
  assert.equal(client.commands.length, 1)
  assert.ok(client.commands[0].some((command) => command.name === 'status'))
})

function fakePolicy(initial = 'all') {
  let mode = initial
  const calls = []
  return {
    calls,
    setMode(next, durationMs) {
      mode = next
      calls.push({ mode: next, durationMs })
      return true
    },
    describe() {
      return `POLICY:${mode}`
    },
  }
}

test('/mode shows and switches the notification mode', async () => {
  const policy = fakePolicy()
  const { bot, client } = makeBot({ policy })
  await bot.handleUpdate(messageUpdate({ text: '/mode' }))
  assert.match(client.sent[0].text, /POLICY:all/)
  await bot.handleUpdate(messageUpdate({ text: '/mode errors' }))
  assert.deepEqual(policy.calls.at(-1), { mode: 'errors', durationMs: undefined })
  assert.match(client.sent[1].text, /POLICY:errors/)
})

test('/mute uses the requested duration and /unmute restores notifications', async () => {
  const policy = fakePolicy()
  const { bot, client } = makeBot({ policy })
  await bot.handleUpdate(messageUpdate({ text: '/mute 30m' }))
  assert.deepEqual(policy.calls.at(-1), { mode: 'mute', durationMs: 30 * 60 * 1000 })
  await bot.handleUpdate(messageUpdate({ text: '/mute' }))
  assert.deepEqual(policy.calls.at(-1), { mode: 'mute', durationMs: 2 * 60 * 60 * 1000 })
  await bot.handleUpdate(messageUpdate({ text: '/unmute' }))
  assert.deepEqual(policy.calls.at(-1), { mode: 'all', durationMs: undefined })
})

test('/digest triggers the observer digest', async () => {
  let calls = 0
  const observer = { sendDigest: async () => { calls += 1 } }
  const { bot, client } = makeBot({ observer })
  await bot.handleUpdate(messageUpdate({ text: '/digest' }))
  assert.equal(calls, 1)
  assert.match(client.sent[0].text, /Дайджест отправлен/)
})

test('incoming MAX attachments are saved and handed to the agent', async () => {
  const { bot, client, calls } = makeBot()
  await bot.handleUpdate({
    update_type: 'message_created',
    chat_id: 123456789,
    message: {
      sender: { user_id: 987654321, is_bot: false },
      recipient: { chat_id: 123456789 },
      body: {
        text: 'посмотри отчёт',
        attachments: [{ type: 'file', filename: 'report.pdf', size: 42, payload: { url: 'https://iu.oneme.ru/f' } }],
      },
    },
  })
  assert.equal(calls.incoming.length, 1)
  assert.equal(calls.incoming[0].sessionId, 'session-aaaaaaaa')
  assert.equal(calls.prompts.length, 1)
  assert.match(calls.prompts[0].text, /посмотри отчёт/)
  assert.match(calls.prompts[0].text, /report\.pdf/)
  assert.match(client.sent[0].text, /Сохранено: 1/)
  assert.match(client.sent[0].text, /Передано агенту/)
})

test('incoming files are refused when receiveFiles is off', async () => {
  const { bot, client, calls } = makeBot({ config: { receiveFiles: false } })
  await bot.handleUpdate({
    update_type: 'message_created',
    chat_id: 123456789,
    message: {
      sender: { user_id: 987654321, is_bot: false },
      recipient: { chat_id: 123456789 },
      body: { attachments: [{ type: 'file', filename: 'a.pdf', payload: { url: 'https://x' } }] },
    },
  })
  assert.equal(calls.incoming.length, 0)
  assert.match(client.sent[0].text, /Приём файлов отключён/)
})

test('/new creates a session in the active folder and makes it active', async () => {
  const { bot, client, state, calls } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: '/new' }))
  assert.deepEqual(calls.created, [{ sessionId: 'session-aaaaaaaa', sessionArg: undefined }])
  assert.equal(state.sessionFor(123456789), 'session-created')
  assert.match(client.sent[0].text, /Сессия создана/)
  assert.match(client.sent[0].text, /\/work\/app\/max/)
})

test('/new max creates a session in a subfolder', async () => {
  const { bot, calls } = makeBot()
  await bot.handleUpdate(messageUpdate({ text: '/new max' }))
  assert.deepEqual(calls.created, [{ sessionId: 'session-aaaaaaaa', sessionArg: 'max' }])
})

test('/sessions includes the active blank session', async () => {
  const { bot, client, state } = makeBot()
  state.setSession(123456789, 'session-blank')
  await bot.handleUpdate(messageUpdate({ text: '/sessions' }))
  assert.match(client.sent[0].text, /Сессии/)
  assert.match(client.sent[0].text, /▶️ 1\)/)
})


test('a redelivered batch does not duplicate prompts (update dedupe)', async () => {
  const client = createFakeClient()
  const state = createMemoryState()
  const { runtime, calls } = runtimeStub()
  const update = messageUpdate({ text: 'только один раз' })
  client.getUpdates = async (params) =>
    params.marker === undefined ? { updates: [], marker: 10 } : { updates: [update], marker: 11 }
  const bot = createBot({ client, config: config(), logger: { info() {}, warn() {}, debug() {} }, state, runtime })

  await bot.pollOnce()
  await bot.pollOnce()
  await bot.pollOnce()
  assert.deepEqual(calls.prompts, [{ sessionId: 'session-aaaaaaaa', text: 'только один раз' }])
})

test('a failed handler keeps the marker and redelivers unhandled updates', async () => {
  const client = createFakeClient()
  const state = createMemoryState()
  let failures = 1
  const { runtime, calls } = runtimeStub()
  const originalPrompt = runtime.promptSession
  runtime.promptSession = async (sessionId, text) => {
    if (failures > 0) {
      failures -= 1
      throw new Error('prompt failed')
    }
    return originalPrompt(sessionId, text)
  }
  const updates = [messageUpdate({ text: 'первый' }), messageUpdate({ text: 'второй' })]
  client.getUpdates = async (params) =>
    params.marker === undefined ? { updates: [], marker: 20 } : { updates, marker: 21 }
  const bot = createBot({ client, config: config(), logger: { info() {}, warn() {}, debug() {} }, state, runtime })

  await bot.pollOnce()
  await assert.rejects(bot.pollOnce(), /prompt failed/)
  assert.equal(state.marker, 20)
  const retry = await bot.pollOnce()
  assert.equal(retry.handled, 2)
  assert.equal(state.marker, 21)
  assert.deepEqual(calls.prompts.map((entry) => entry.text), ['первый', 'второй'])
})

test('/health, /version and /ping answer with runtime data', async () => {
  const health = {
    snapshot: () => ({
      uptimeMs: 65_000,
      lastPollAt: Date.now() - 5_000,
      lastUpdateAt: Date.now() - 1_000,
      pollStopped: false,
    }),
  }
  const outbox = { snapshot: () => ({ pending: 2, sent: 10, failed: 1 }) }
  const limiter = { snapshot: () => ({ queueDepth: 0, waits: 3 }) }
  const { bot, client } = makeBot({ health, outbox, limiter, version: '0.6.0' })
  await bot.handleUpdate(messageUpdate({ text: '/health' }))
  assert.match(client.sent[0].text, /dsh-max-notify.*0\.6\.0/s)
  assert.match(client.sent[0].text, /outbox: 2/)
  await bot.handleUpdate(messageUpdate({ text: '/version' }))
  assert.match(client.sent[1].text, /v0\.6\.0/)
  await bot.handleUpdate(messageUpdate({ text: '/ping' }))
  assert.match(client.sent[2].text, /pong/)
})

test('incoming flood protection answers once per warning window', async () => {
  const { bot, client, calls } = makeBot({ config: { incomingPerMinute: 1, incomingBurst: 1 } })
  await bot.handleUpdate(messageUpdate({ text: 'раз' }))
  await bot.handleUpdate(messageUpdate({ text: 'два' }))
  await bot.handleUpdate(messageUpdate({ text: 'три' }))
  assert.equal(calls.prompts.length, 1)
  const warnings = client.sent.filter((item) => /Слишком часто/.test(item.text))
  assert.equal(warnings.length, 1)
})

function v07Runtime(extra = {}) {
  const calls = { prompts: [], models: [], selected: [], renamed: [], forked: [], commands: [], plans: [], searches: [], archived: [], pinned: [] }
  const runtime = {
    ...runtimeStub().runtime,
    promptSession: async (sessionId, text) => {
      calls.prompts.push({ sessionId, text })
      return true
    },
    listModels: async () => ({
      items: [
        { provider: 'deepseek', model: 'deepseek-flash', name: 'Flash' },
        { provider: 'deepseek', model: 'deepseek-pro', name: 'Pro' },
      ],
      failures: [],
    }),
    currentModel: async () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    selectModel: async (sessionId, selection) => {
      calls.selected.push({ sessionId, ...selection })
      return { ok: true, selection }
    },
    renameSession: async (sessionId, title) => {
      calls.renamed.push({ sessionId, title })
      return { ok: true, title }
    },
    forkSession: async (sessionId) => {
      calls.forked.push(sessionId)
      return { ok: true, sessionId: 'session-forked' }
    },
    runCommand: async (sessionId, line) => {
      calls.commands.push({ sessionId, line })
      return { ok: true, text: 'Сжато 12 элементов, сохранено ~2k токенов.' }
    },
    setPlanMode: async (sessionId, active) => {
      calls.plans.push({ sessionId, active })
      return { ok: true, state: 'committed', active, pending: false }
    },
    planState: async () => ({ ok: true, active: true, pending: false }),
    searchSessions: async (query) => {
      calls.searches.push(query)
      return { ok: true, items: [{ sessionId: 'session-search', snippet: 'нашлось вот это', title: 'Найденная' }] }
    },
    archiveSession: async (sessionId) => {
      calls.archived.push(sessionId)
      return { ok: true }
    },
    pinSession: async (sessionId, pinned) => {
      calls.pinned.push({ sessionId, pinned })
      return { ok: true }
    },
    listWorkspaces: async () => [
      { id: 'w1', path: '/work/app', title: 'app' },
      { id: 'w2', path: '/work/lib', title: 'lib' },
    ],
    createWorkspace: async (path) => ({ ok: true, path, title: path.split('/').pop() }),
    setPreferredWorkspace: (path) => calls.pinned.push({ preferred: path }),
    getApprovalPolicy: async () => ({ ok: true, policy: 'ask', override: false }),
    setApprovalPolicy: async (sessionId, policy) => {
      calls.selected.push({ policySet: policy })
      return { ok: true, policy }
    },
    ...extra,
  }
  return { runtime, calls }
}

test('/model lists models and switches by number', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/model' }))
  assert.match(client.sent[0].text, /Модели/)
  assert.match(client.sent[0].text, /deepseek\/deepseek-flash/)
  await bot.handleUpdate(messageUpdate({ text: '/model 2' }))
  assert.deepEqual(calls.selected, [{ sessionId: 'session-aaaaaaaa', provider: 'deepseek', model: 'deepseek-pro' }])
  assert.match(client.sent[1].text, /deepseek\/deepseek-pro/)
})

test('/rename, /fork and /compact drive the session', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client, state } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/rename Новое имя' }))
  assert.deepEqual(calls.renamed, [{ sessionId: 'session-aaaaaaaa', title: 'Новое имя' }])
  assert.match(client.sent[0].text, /Новое имя/)

  await bot.handleUpdate(messageUpdate({ text: '/fork' }))
  assert.deepEqual(calls.forked, ['session-aaaaaaaa'])
  assert.equal(state.sessionFor(123456789), 'session-forked')

  await bot.handleUpdate(messageUpdate({ text: '/compact' }))
  assert.deepEqual(calls.commands, [{ sessionId: 'session-forked', line: '/compact' }])
  assert.match(client.sent[2].text, /Сжато/)
})

test('/plan toggles plan mode and shows status', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/plan' }))
  assert.deepEqual(calls.plans, [{ sessionId: 'session-aaaaaaaa', active: true }])
  assert.match(client.sent[0].text, /включён/)
  await bot.handleUpdate(messageUpdate({ text: '/plan off' }))
  assert.deepEqual(calls.plans.at(-1), { sessionId: 'session-aaaaaaaa', active: false })
  await bot.handleUpdate(messageUpdate({ text: '/plan status' }))
  assert.match(client.sent[2].text, /Режим плана/)
})

test('/search stores results for /use and /use switches to a found session', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client, state } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/search нашлось' }))
  assert.deepEqual(calls.searches, ['нашлось'])
  assert.match(client.sent[0].text, /Поиск/)
  await bot.handleUpdate(messageUpdate({ text: '/use 1' }))
  assert.equal(state.sessionFor(123456789), 'session-search')
})

test('/archive archives the active session and switches to the next one', async () => {
  const sessions = [
    { sessionId: 'session-aaaaaaaa', running: false, cwd: '/work/app', updatedAt: 2, title: 'Первая' },
    { sessionId: 'session-bbbbbbbb', running: false, cwd: '/work/lib', updatedAt: 1, title: 'Вторая' },
  ]
  const removed = []
  const { runtime } = v07Runtime({
    listSessions: async () => sessions.filter((item) => !removed.includes(item.sessionId)),
    archiveSession: async (sessionId) => {
      removed.push(sessionId)
      return { ok: true }
    },
  })
  const { bot, client, state } = makeBot({ runtime })
  state.setSession(123456789, 'session-aaaaaaaa')
  await bot.handleUpdate(messageUpdate({ text: '/archive' }))
  assert.deepEqual(removed, ['session-aaaaaaaa'])
  assert.equal(state.sessionFor(123456789), 'session-bbbbbbbb')
  assert.match(client.sent[0].text, /в архиве/)
})

test('/pin and /unpin call the registry', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/pin' }))
  await bot.handleUpdate(messageUpdate({ text: '/unpin' }))
  assert.deepEqual(calls.pinned, [
    { sessionId: 'session-aaaaaaaa', pinned: true },
    { sessionId: 'session-aaaaaaaa', pinned: false },
  ])
})

test('/workspace lists folders, selects one and adds a new one', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/workspace' }))
  assert.match(client.sent[0].text, /Рабочие папки/)
  await bot.handleUpdate(messageUpdate({ text: '/workspace 2' }))
  assert.deepEqual(calls.pinned.at(-1), { preferred: '/work/lib' })
  await bot.handleUpdate(messageUpdate({ text: '/workspace add /work/new' }))
  assert.match(client.sent[2].text, /\/work\/new/)
})

test('/approve requires a confirmation before changing the policy', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/approve' }))
  assert.match(client.sent[0].text, /Политика подтверждений/)
  await bot.handleUpdate(messageUpdate({ text: '/approve never' }))
  assert.match(client.sent[1].text, /Подтверди/)
  assert.equal(calls.selected.length, 0)
  await bot.handleUpdate(messageUpdate({ text: '/approve never confirm' }))
  assert.deepEqual(calls.selected, [{ policySet: 'never' }])
  assert.match(client.sent[2].text, /never/)
})

test('preset buttons prompt the session with the configured text', async () => {
  const { runtime, calls } = v07Runtime()
  const { bot, client } = makeBot({
    runtime,
    config: { buttonsPresets: [{ label: 'Ещё вариант', prompt: 'дай ещё вариант' }] },
  })
  await bot.handleUpdate({
    update_type: 'message_callback',
    callback: {
      callback_id: 'cb-preset',
      payload: JSON.stringify({ t: 'qa', a: 'preset', s: 'session-aaaaaaaa', i: 0 }),
      user: { user_id: 987654321 },
    },
    message: { recipient: { chat_id: 123456789 } },
  })
  assert.deepEqual(calls.prompts, [{ sessionId: 'session-aaaaaaaa', text: 'дай ещё вариант' }])
  assert.equal(client.callbacks.at(-1).body.notification, '📨 Ещё вариант')
})

test('/budget shows budget and spend, /status includes the cost line', async () => {
  const snapshot = {
    available: true,
    currency: { code: 'CNY', symbol: '¥', decimals: 2 },
    today: { date: '2026-11-09', amount: 5 },
    month: { start: '2026-11-01', amount: 15 },
    total: { amount: 15 },
    budget: {
      enabled: true,
      amount: 100,
      spent: 15,
      remaining: 85,
      percent: 15,
      period: 'month',
      periodKey: '2026-11',
      start: '2026-11-01',
      end: '2026-11-09',
    },
  }
  const { bot, client } = makeBot({
    runtime: {
      budgetStatus: async () => ({ available: true, ...snapshot }),
      costSnapshot: async () => snapshot,
      costForSession: async () => 5,
    },
  })
  await bot.handleUpdate(messageUpdate({ text: '/budget' }))
  assert.match(client.sent[0].text, /Бюджет/)
  assert.match(client.sent[0].text, /¥15\.00 из ¥100\.00/)
  await bot.handleUpdate(messageUpdate({ text: '/status' }))
  assert.match(client.sent[1].text, /Сегодня ¥5\.00/)
  assert.match(client.sent[1].text, /сессия ¥5\.00/)
})

test('a MAX reply is routed to the session that produced the quoted message', async () => {
  const { bot, calls, state } = makeBot({
    state: { messageSessions: { 'quoted-mid': 'session-bbbbbbbb' } },
  })
  await bot.handleUpdate({
    update_type: 'message_created',
    chat_id: 123456789,
    message: {
      sender: { user_id: 987654321 },
      recipient: { chat_id: 123456789 },
      link: { type: 'reply', mid: 'quoted-mid' },
      body: { text: 'продолжай эту ветку', mid: 'reply-mid', attachments: [] },
    },
  })
  assert.equal(state.sessionFor(123456789), 'session-bbbbbbbb')
  assert.deepEqual(calls.prompts, [{ sessionId: 'session-bbbbbbbb', text: 'продолжай эту ветку' }])
})

test('a forwarded MAX message is unwrapped and passed to the agent', async () => {
  const { bot, calls } = makeBot()
  await bot.handleUpdate({
    update_type: 'message_created',
    chat_id: 123456789,
    message: {
      sender: { user_id: 987654321 },
      recipient: { chat_id: 123456789 },
      link: {
        type: 'forward',
        message: {
          body: { text: 'текст пересланного', attachments: [] },
        },
      },
      body: { text: '', mid: 'forward-mid', attachments: [] },
    },
  })
  assert.equal(calls.prompts.length, 1)
  assert.match(calls.prompts[0].text, /текст пересланного/)
})

test('/schedules lists tasks and pauses/resumes/cancels with confirmation', async () => {
  const schedule = {
    items: [
      { id: 'job-1', kind: 'daily', title: 'Деплой', prompt: 'задеплой', scheduledAt: '2026-11-10T06:00:00Z', status: 'active', target: { kind: 'session' }, updatedAt: '2026-11-09T00:00:00Z' },
      { id: 'job-2', kind: 'after', title: 'Напомнить', prompt: 'напомни', scheduledAt: '2026-11-09T12:00:00Z', status: 'active', target: { kind: 'new' }, updatedAt: '2026-11-09T01:00:00Z' },
    ],
    total: 2,
  }
  const edits = []
  const runtime = {
    scheduleService: () => ({
      async list() {
        return schedule
      },
      async edit(request) {
        edits.push(request)
        if (request.action === 'delete') return { id: request.id, deleted: true }
        return { ...schedule.items.find((item) => item.id === request.id), status: request.patch.active ? 'active' : 'paused' }
      },
    }),
  }
  const { bot, client } = makeBot({ runtime })
  await bot.handleUpdate(messageUpdate({ text: '/schedules' }))
  assert.match(client.sent[0].text, /Запланированные задачи/)
  assert.match(client.sent[0].text, /Деплой/)

  await bot.handleUpdate(messageUpdate({ text: '/schedules pause 1' }))
  assert.deepEqual(edits[0], { id: 'job-1', action: 'update', patch: { active: false }, expectedUpdatedAt: '2026-11-09T00:00:00Z' })
  assert.match(client.sent[1].text, /паузу/)

  await bot.handleUpdate(messageUpdate({ text: '/schedules cancel 2' }))
  assert.match(client.sent[2].text, /Подтверди/)
  assert.equal(edits.length, 1)
  await bot.handleUpdate(messageUpdate({ text: '/schedules cancel 2 confirm' }))
  assert.equal(edits.at(-1).action, 'delete')
  assert.match(client.sent[3].text, /удалена/)
})

test('/settings renders effective settings', async () => {
  const { bot, client } = makeBot({
    runtime: {
      settingsSummary: () => ({
        version: '1.0.0',
        transport: 'webhook',
        interactive: true,
        allowlist: { users: 1, chats: 0 },
        mode: 'all',
        digest: '21:00',
        threads: true,
        tableFiles: true,
        approvalTimeoutMs: 120000,
        receiveFiles: true,
        outboxEnabled: true,
        costMeterEnabled: true,
        budgetAlertEnabled: true,
        buttonsPresets: 2,
      }),
    },
  })
  await bot.handleUpdate(messageUpdate({ text: '/settings' }))
  assert.match(client.sent[0].text, /Настройки dsh-max-notify/)
  assert.match(client.sent[0].text, /webhook/)
  assert.match(client.sent[0].text, /reply-ветки: вкл/)
  assert.match(client.sent[0].text, /пресетов: 2/)
})

test('an incoming image is passed through promptIncoming', async () => {
  const promptIncomingCalls = []
  const { bot, client } = makeBot({
    runtime: {
      saveIncoming: async () => ({
        saved: [{ path: '/work/max-inbox/shot.png', name: 'shot.png', type: 'image', bytes: 100 }],
        errors: [],
        dir: '/work/max-inbox',
        promptText: 'Пользователь прислал файлы из MAX:\n• /work/max-inbox/shot.png (image, 100 B)',
      }),
      promptIncoming: async (sessionId, text, files) => {
        promptIncomingCalls.push({ sessionId, text, files })
        return true
      },
    },
  })
  await bot.handleUpdate({
    update_type: 'message_created',
    chat_id: 123456789,
    message: {
      sender: { user_id: 987654321 },
      recipient: { chat_id: 123456789 },
      body: { text: 'что на картинке?', mid: 'img-mid', attachments: [{ type: 'image', payload: { url: 'https://example.test/i.png' } }] },
    },
  })
  assert.equal(promptIncomingCalls.length, 1)
  assert.equal(promptIncomingCalls[0].files[0].path, '/work/max-inbox/shot.png')
  assert.match(client.sent.at(-1).text, /Передано агенту/)
})

test('/say, /diff and /send call their runtime helpers', async () => {
  const calls = { say: [], diff: [], send: [] }
  const { bot, client } = makeBot({
    runtime: {
      say: async (text) => {
        calls.say.push(text)
        return { ok: true }
      },
      diffSession: async (sessionId, options) => {
        calls.diff.push({ sessionId, options })
        return { ok: true, bytes: 42, truncated: false }
      },
      sendFileFromSession: async (sessionId, arg) => {
        calls.send.push({ sessionId, arg })
        return { ok: true, name: 'report.pdf', bytes: 5 }
      },
    },
  })
  await bot.handleUpdate(messageUpdate({ text: '/say привет' }))
  await bot.handleUpdate(messageUpdate({ text: '/diff --staged src' }))
  await bot.handleUpdate(messageUpdate({ text: '/send report.pdf' }))
  assert.deepEqual(calls.say, ['привет'])
  assert.deepEqual(calls.diff, [{ sessionId: 'session-aaaaaaaa', options: { staged: true, path: 'src' } }])
  assert.deepEqual(calls.send, [{ sessionId: 'session-aaaaaaaa', arg: 'report.pdf' }])
  assert.match(client.sent.at(-3).text, /Озвучено/)
  assert.match(client.sent.at(-2).text, /Diff/)
  assert.match(client.sent.at(-1).text, /Отправлено/)
})
