import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep test state away from the live plugin state file.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-max-notify-test-home-'))

const { apply, normalizeConfig, isTopLevelSession } = await import('../index.js')

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeCtx({ sessionTitle } = {}) {
  const listeners = new Map()
  const logs = []
  const ctx = {
    get: (name) => (name === 'sessionTitle' && sessionTitle !== undefined ? { get: () => ({ title: sessionTitle }) } : undefined),
    logger: () => ({
      error: (...args) => logs.push(['error', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    }),
    on: (name, fn) => {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
  }
  return {
    ctx,
    logs,
    emit: (name, ...args) => {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    listenerCount: (name) => (listeners.get(name) ?? []).length,
  }
}

function createFakeClient({ getChat } = {}) {
  const sent = []
  const uploads = []
  return {
    sent,
    uploads,
    getChat: getChat ?? (async () => {
      throw new Error('getChat was not expected in this test')
    }),
    uploadTypeFor(filePath) {
      return /\.(png|jpe?g|gif|webp)$/i.test(String(filePath)) ? 'image' : 'file'
    },
    async uploadMedia({ filePath, type }) {
      uploads.push({ filePath, type })
      return { token: `tok-${uploads.length}`, type }
    },
    async sendMessage(params) {
      sent.push(params)
      return { message: { body: { mid: `mid-${sent.length}` } } }
    },
  }
}

function session(id = 'session-1', header = { cwd: '/path/to/MaxBot' }) {
  return { id, header }
}

/** Session events are enveloped as { type, seq, time, data }. */
let seq = 0
function evt(type, data) {
  seq += 1
  return { type, seq, time: Date.now(), data }
}

function assistantEvent(turn, step, text) {
  return evt('assistant/message', {
    turn,
    step,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

test('normalizeConfig applies defaults, env fallbacks and clamps', () => {
  const previous = { token: process.env.MAX_BOT_TOKEN, chat: process.env.MAX_CHAT_ID }
  delete process.env.MAX_BOT_TOKEN
  delete process.env.MAX_CHAT_ID
  try {
    const config = normalizeConfig({ botToken: 't', chatId: 123, maxChars: 99999, format: 'HTML' })
    assert.equal(config.botToken, 't')
    assert.equal(config.chatId, '123')
    assert.equal(config.maxChars, 4000)
    assert.equal(config.format, 'html')
    assert.equal(config.notify, true)
    assert.equal(config.dryRun, false)

    process.env.MAX_BOT_TOKEN = 'env-token'
    process.env.MAX_CHAT_ID = '42'
    const fromEnv = normalizeConfig({})
    assert.equal(fromEnv.botToken, 'env-token')
    assert.equal(fromEnv.chatId, '42')
  } finally {
    if (previous.token === undefined) delete process.env.MAX_BOT_TOKEN
    else process.env.MAX_BOT_TOKEN = previous.token
    if (previous.chat === undefined) delete process.env.MAX_CHAT_ID
    else process.env.MAX_CHAT_ID = previous.chat
  }
})

test('isTopLevelSession filters subagent children', () => {
  assert.equal(isTopLevelSession(session(undefined, {})), true)
  assert.equal(isTopLevelSession(session(undefined, { origin: 'subagent' })), false)
  assert.equal(isTopLevelSession(session(undefined, { delegationDepth: 2 })), false)
  assert.equal(isTopLevelSession(session(undefined, { delegationDepth: 0 })), true)
})

test('forwards exactly one message per completed turn with the last assistant text', async () => {
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '123456789' }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'Промежуточный шаг'))
  emit('session/event', s, assistantEvent(1, 2, 'Финальный ответ'))
  assert.equal(client.sent.length, 0)
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].chatId, '123456789')
  assert.match(client.sent[0].text, /Финальный ответ$/)
  assert.match(client.sent[0].text, /^\*\*DSH\*\* · \d\d:\d\d:\d\d · MaxBot\n\n/)
})

test('does not forward when no assistant text was seen or the turn number does not match', async () => {
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1' }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()
  assert.equal(client.sent.length, 0)

  emit('session/event', s, evt('turn/start', { turn: 2 }))
  emit('session/event', s, assistantEvent(2, 1, 'hello'))
  emit('session/event', s, evt('turn/end', { turn: 3, reason: { kind: 'completed' } }))
  await tick()
  assert.equal(client.sent.length, 0)
})

test('skips subagent sessions by default and forwards them when enabled', async () => {
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1' }, { createClient: () => client })
  const child = session('session-child', { origin: 'subagent', delegationDepth: 1 })

  emit('session/event', child, evt('turn/start', { turn: 1 }))
  emit('session/event', child, assistantEvent(1, 1, 'child result'))
  emit('session/event', child, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()
  assert.equal(client.sent.length, 0)

  const second = createFakeCtx()
  const secondClient = createFakeClient()
  apply(second.ctx, { botToken: 't', chatId: '1', includeSubagents: true }, { createClient: () => secondClient })
  second.emit('session/event', child, evt('turn/start', { turn: 2 }))
  second.emit('session/event', child, assistantEvent(2, 1, 'child result'))
  second.emit('session/event', child, evt('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await tick()
  assert.equal(secondClient.sent.length, 1)
})

test('dry-run logs instead of sending and abnormal reasons are marked in the header', async () => {
  const { ctx, emit, logs } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1', dryRun: true }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'partial'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'user' } }))
  await tick()

  assert.equal(client.sent.length, 0)
  assert.ok(logs.some(([level, message]) => level === 'info' && String(message).includes('[dry-run]')))
})

test('missing credentials leave the plugin inert instead of throwing', () => {
  const { ctx, logs, listenerCount } = createFakeCtx()
  assert.doesNotThrow(() => apply(ctx, { enabled: false }))
  assert.equal(listenerCount('session/event'), 0)
  assert.ok(logs.some(([level]) => level === 'info'))

  const second = createFakeCtx()
  assert.doesNotThrow(() => apply(second.ctx, {}))
  assert.equal(second.listenerCount('session/event'), 0)
  assert.ok(second.logs.some(([level, message]) => level === 'warn' && String(message).includes('token')))
})

test('transport errors are logged and do not break the event pipeline', async () => {
  const { ctx, emit, logs } = createFakeCtx()
  const failing = {
    async sendMessage() {
      throw new Error('network is down')
    },
  }
  apply(ctx, { botToken: 't', chatId: '1' }, { createClient: () => failing })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'reply'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.ok(
    logs.some(
      ([level, ...args]) => level === 'warn' && args.some((arg) => String(arg).includes('network is down')),
    ),
  )
})

test('skips interrupted/forked turn endings by default (stale restore closers)', async () => {
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1' }, { createClient: () => client })
  const s = session()

  for (const kind of ['interrupted', 'forked']) {
    emit('session/event', s, evt('turn/start', { turn: 1 }))
    emit('session/event', s, assistantEvent(1, 1, 'stale text'))
    emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind } }))
  }
  await tick()
  assert.equal(client.sent.length, 0)

  emit('session/event', s, evt('turn/start', { turn: 2 }))
  emit('session/event', s, assistantEvent(2, 1, 'fresh text'))
  emit('session/event', s, evt('turn/end', { turn: 2, reason: { kind: 'completed' } }))
  await tick()
  assert.equal(client.sent.length, 1)
})

test('uses the session title in the header when the title service is available', async () => {
  const { ctx, emit } = createFakeCtx({ sessionTitle: 'Настройка MAX' })
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1' }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'done'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 1)
  assert.match(client.sent[0].text, /^\*\*DSH\*\* · \d\d:\d\d:\d\d · Настройка MAX\n\ndone$/)
})

test('allowlist lets a dialog with the allowed user through and sends once', async () => {
  const { ctx, emit } = createFakeCtx()
  const calls = []
  const client = createFakeClient({
    getChat: async (chatId) => {
      calls.push(chatId)
      return { type: 'dialog', chat_id: 123456789, dialog_with_user: { user_id: 987654321 } }
    },
  })
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['987654321'] }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'allowed reply'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 1)
  assert.deepEqual(calls, ['123456789'])
})

test('allowlist blocks a dialog with another user (fail closed)', async () => {
  const { ctx, emit, logs } = createFakeCtx()
  const client = createFakeClient({
    getChat: async () => ({ type: 'dialog', dialog_with_user: { user_id: 999 } }),
  })
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['987654321'] }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'secret'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 0)
  assert.ok(logs.some(([level, ...args]) => level === 'warn' && args.some((a) => String(a).includes('not in allowedUserIds'))))
})

test('an explicitly allowlisted chat skips chat resolution', async () => {
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient({
    getChat: async () => {
      throw new Error('getChat must not be called for an allowlisted chat')
    },
  })
  apply(ctx, { botToken: 't', chatId: '123456789', allowedChatIds: ['123456789'] }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'chat-allowed'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 1)
})

test('userId target must be in allowedUserIds', async () => {
  const makeTurn = (config) => {
    const fake = createFakeCtx()
    const client = createFakeClient()
    apply(fake.ctx, { botToken: 't', allowedUserIds: ['987654321'], ...config }, { createClient: () => client })
    const s = session()
    fake.emit('session/event', s, evt('turn/start', { turn: 1 }))
    fake.emit('session/event', s, assistantEvent(1, 1, 'text'))
    fake.emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    return { client, fake }
  }

  const allowed = makeTurn({ userId: '987654321' })
  await tick()
  assert.equal(allowed.client.sent.length, 1)

  const denied = makeTurn({ userId: '1' })
  await tick()
  assert.equal(denied.client.sent.length, 0)
  assert.ok(denied.fake.logs.some(([, ...args]) => args.some((a) => String(a).includes('not in allowedUserIds'))))
})

test('chat verification failure blocks sending (fail closed)', async () => {
  const { ctx, emit, logs } = createFakeCtx()
  const client = createFakeClient({
    getChat: async () => {
      throw new Error('network down')
    },
  })
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['987654321'] }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'text'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 0)
  assert.ok(logs.some(([level, ...args]) => level === 'warn' && args.some((a) => String(a).includes('cannot verify chat'))))
})

test('numeric allowedUserIds from YAML are accepted (numbers, not just strings)', async () => {
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient({
    getChat: async () => ({ type: 'dialog', dialog_with_user: { user_id: 987654321 } }),
  })
  const config = normalizeConfig({ botToken: 't', chatId: 123456789, allowedUserIds: [987654321] })
  assert.deepEqual(config.allowedUserIds, ['987654321'])
  assert.deepEqual(config.allowedChatIds, [])
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: [987654321] }, { createClient: () => client })
  const s = session()

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'numeric allowlist'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick()

  assert.equal(client.sent.length, 1)
})

test('images referenced in the final answer are attached to the MAX message', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-final-image-'))
  const png = join(workspace, 'plot.png')
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1', forwardImages: true, buttons: false }, { createClient: () => client })
  const s = session('session-image', { cwd: workspace })

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, `Готово:\n\n![график](${png})`))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick(60)

  assert.equal(client.sent.length, 1)
  assert.deepEqual(client.uploads, [{ filePath: png, type: 'image' }])
  const attachments = client.sent[0].attachments ?? []
  assert.ok(
    attachments.some((item) => item.type === 'image' && item.payload?.token === 'tok-1'),
    'image attachment expected',
  )
})

test('images inside code fences are not forwarded', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-final-image-code-'))
  const png = join(workspace, 'plot.png')
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
  const { ctx, emit } = createFakeCtx()
  const client = createFakeClient()
  apply(ctx, { botToken: 't', chatId: '1', forwardImages: true, buttons: false }, { createClient: () => client })
  const s = session('session-image-code', { cwd: workspace })

  emit('session/event', s, evt('turn/start', { turn: 1 }))
  emit('session/event', s, assistantEvent(1, 1, 'пример кода:\n\n```\n![x](plot.png)\n```'))
  emit('session/event', s, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  await tick(60)

  assert.equal(client.sent.length, 1)
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sent[0].attachments, undefined)
})
