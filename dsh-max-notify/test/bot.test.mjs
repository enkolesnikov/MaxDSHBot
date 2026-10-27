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
  return {
    marker: initial.marker,
    sessions,
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
  const calls = { prompts: [], cancels: [] }
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
      ...overrides,
    },
  }
}

function makeBot(overrides = {}) {
  const client = createFakeClient()
  const state = createMemoryState()
  const { runtime, calls } = runtimeStub()
  const bot = createBot({
    client,
    config: config(overrides.config),
    logger: { info() {}, warn() {}, debug() {} },
    state,
    interactions: overrides.interactions,
    runtime,
    policy: overrides.policy,
    observer: overrides.observer,
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
      body: { text, attachments: [] },
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
  assert.deepEqual(primed, { primed: true, count: 0 })
  assert.equal(state.marker, 555)

  updateBatch = [messageUpdate({ text: 'из поллинга' })]
  const next = await bot.pollOnce()
  assert.deepEqual(next, { primed: false, count: 1 })
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
