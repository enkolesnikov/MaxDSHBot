import test from 'node:test'
import assert from 'node:assert/strict'
import { createObserver } from '../lib/observer.mjs'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 1600, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(stepMs)
  }
  return predicate()
}

function createFakeClient() {
  const sent = []
  return {
    sent,
    async sendMessage(params) {
      sent.push(params)
      return { message: { body: { mid: `mid-${sent.length}` } } }
    },
  }
}

function baseConfig(overrides = {}) {
  return {
    format: 'markdown',
    notify: true,
    notifySubagents: true,
    notifyJobs: true,
    notifyAwaitedJobs: false,
    notifyGoals: true,
    notifyErrors: true,
    todoProgress: true,
    digestEnabled: false,
    digestTime: '09:00',
    ...overrides,
  }
}

function makeObserver({ config = {}, policy, runtime, state } = {}) {
  const client = createFakeClient()
  const observer = createObserver({
    client,
    config: baseConfig(config),
    logger: { info() {}, warn() {}, debug() {} },
    target: { chatId: '123456789' },
    policy: policy ?? { decide: () => ({ send: true, notify: true, reason: 'normal' }) },
    runtime: runtime ?? {
      titleFor: (value) => (String(value) === 'session-1' ? 'Моя сессия' : undefined),
      listSessions: async () => [
        { sessionId: 'session-1', title: 'Моя сессия', running: true, updatedAt: Date.now() },
        { sessionId: 'session-old', title: 'Старая', running: false, updatedAt: Date.now() - 2 * 24 * 3600 * 1000 },
      ],
    },
    state: state ?? { getDigestDate: () => undefined, setDigestDate: () => {} },
  })
  return { client, observer }
}

const session = (id = 'session-1', header = { cwd: '/work' }) => ({ id, header })

test('subagent completion notifies with its final message', async () => {
  const { client, observer } = makeObserver()
  observer.onSubagentEnd({
    id: 'session-child',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'дочерний итог' }],
  })
  assert.ok(await waitFor(() => client.sent.length === 1))
  assert.match(client.sent[0].text, /Дочерний агент завершён/)
  assert.match(client.sent[0].text, /дочерний итог/)
  assert.match(client.sent[0].text, /session-child/)
})

test('settled unawaited jobs notify; awaited ones are skipped by default', async () => {
  const first = makeObserver()
  first.observer.onJobEvent({ type: 'settled', awaited: false, job: { id: 'bash-abc', kind: 'bash', label: 'pnpm test', status: 'completed', detail: 'exit code: 0' } })
  assert.ok(await waitFor(() => first.client.sent.length === 1))
  assert.match(first.client.sent[0].text, /Фоновая задача: completed/)
  assert.match(first.client.sent[0].text, /pnpm test/)

  const second = makeObserver()
  second.observer.onJobEvent({ type: 'settled', awaited: true, job: { id: 'bash-def', kind: 'bash', label: 'awaited', status: 'completed' } })
  await tick(50)
  assert.equal(second.client.sent.length, 0)
})

test('awaited jobs notify when notifyAwaitedJobs is on', async () => {
  const { client, observer } = makeObserver({ config: { notifyAwaitedJobs: true } })
  observer.onJobEvent({ type: 'settled', awaited: true, job: { id: 'bash-x', status: 'failed', label: 'x' } })
  assert.ok(await waitFor(() => client.sent.length === 1))
})

test('agent errors always notify (critical)', async () => {
  const { client, observer } = makeObserver()
  observer.onAgentError({ agent: { session: session() }, turn: 3, step: 1, error: new Error('boom') })
  assert.ok(await waitFor(() => client.sent.length === 1))
  assert.match(client.sent[0].text, /Ошибка агента/)
  assert.match(client.sent[0].text, /boom/)
})

test('goal lifecycle changes notify, edits are ignored', async () => {
  const { client, observer } = makeObserver()
  observer.onGoalChanged({
    agent: { session: session() },
    change: { operation: 'complete', goal: { phase: 'complete', objective: 'Сделать фичу', maxGoalRounds: 5, roundsStarted: 3 } },
  })
  assert.ok(await waitFor(() => client.sent.length === 1))
  assert.match(client.sent[0].text, /Цель: complete/)
  assert.match(client.sent[0].text, /Сделать фичу/)

  observer.onGoalChanged({ agent: { session: session() }, change: { operation: 'edit', goal: { phase: 'active', objective: 'x' } } })
  await tick(120)
  assert.equal(client.sent.length, 1)
})

test('TODO progress notifies only when the completed count advances', async () => {
  const { client, observer } = makeObserver()
  const event = (todos) => ({ type: 'todo/write', data: { todos } })
  observer.onSessionEvent(session(), event([
    { content: 'первое', status: 'completed' },
    { content: 'второе', status: 'pending' },
  ]))
  assert.ok(await waitFor(() => client.sent.length === 1))
  assert.match(client.sent[0].text, /TODO: 1\/2/)

  observer.onSessionEvent(session(), event([
    { content: 'первое', status: 'completed' },
    { content: 'второе', status: 'pending' },
  ]))
  await tick(120)
  assert.equal(client.sent.length, 1)

  observer.onSessionEvent(session(), event([
    { content: 'первое', status: 'completed' },
    { content: 'второе', status: 'completed' },
  ]))
  assert.ok(await waitFor(() => client.sent.length === 2, { timeoutMs: 2000 }))
  assert.match(client.sent[1].text, /TODO: 2\/2/)
})

test('subagent sessions do not report TODO progress', async () => {
  const { client, observer } = makeObserver()
  observer.onSessionEvent(session('session-child', { origin: 'subagent', delegationDepth: 1 }), {
    type: 'todo/write',
    data: { todos: [{ content: 'x', status: 'completed' }] },
  })
  await tick(80)
  assert.equal(client.sent.length, 0)
})

test('policy suppression blocks a notification', async () => {
  const policy = { decide: () => ({ send: false, notify: false, reason: 'mute' }) }
  const { client, observer } = makeObserver({ policy })
  observer.onSubagentEnd({ id: 'session-child', stopReason: 'completed' })
  await tick(120)
  assert.equal(client.sent.length, 0)
})

test('digest contains sessions, live token usage and persists the day', async () => {
  const digestDates = []
  const state = { getDigestDate: () => undefined, setDigestDate: (value) => digestDates.push(value) }
  const { client, observer } = makeObserver({ state })
  observer.onSessionEvent(session(), {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
  })
  await observer.sendDigest()
  assert.ok(await waitFor(() => client.sent.length === 1))
  assert.match(client.sent[0].text, /Дайджест DSH/)
  assert.match(client.sent[0].text, /Активных сессий за сутки: 1/)
  assert.match(client.sent[0].text, /Токены \(live\): in 100 · out 50 · всего 150/)
  assert.equal(digestDates.length, 1)
})

test('digest respects the notification policy', async () => {
  const policy = { decide: () => ({ send: false, notify: false, reason: 'mute' }) }
  const { client, observer } = makeObserver({ policy })
  await observer.sendDigest()
  await tick(120)
  assert.equal(client.sent.length, 0)
})
