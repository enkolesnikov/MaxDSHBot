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

function makeObserver({ config = {}, policy, runtime, state, outbox, now, logger } = {}) {
  const client = createFakeClient()
  const logs = []
  const loggerStub = logger ?? {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: (...args) => logs.push(['debug', ...args]),
  }
  const observer = createObserver({
    client,
    config: baseConfig(config),
    logger: loggerStub,
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
    outbox,
    now,
  })
  return { client, observer, logs }
}

/**
 * Run `observer.start()` with interval/timeout factories captured instead of
 * armed, so a test can fire one scheduled check without waiting 30 s / 5 min.
 */
function startWithCapturedTimers(observer) {
  const intervals = []
  const timeouts = []
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  const fakeHandle = () => ({ unref() {} })
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms })
    return fakeHandle()
  }
  globalThis.setTimeout = (fn, ms) => {
    timeouts.push({ fn, ms })
    return fakeHandle()
  }
  try {
    observer.start()
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
  }
  return { intervals, timeouts, fire: (list, ms) => list.find((item) => item.ms === ms).fn() }
}

/** State stub that remembers the single persisted digest date. */
function digestState() {
  let digestDate
  return {
    getDigestDate: () => digestDate,
    setDigestDate: (value) => {
      digestDate = value
    },
    get date() {
      return digestDate
    },
  }
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
  assert.match(client.sent[0].text, /Дочерний агент/)
  assert.match(client.sent[0].text, /дочерний итог/)
  assert.match(client.sent[0].text, /session-child/)
})

test('settled unawaited jobs notify; awaited ones are skipped by default', async () => {
  const first = makeObserver()
  first.observer.onJobEvent({ type: 'settled', awaited: false, job: { id: 'bash-abc', kind: 'bash', label: 'pnpm test', status: 'completed', detail: 'exit code: 0' } })
  assert.ok(await waitFor(() => first.client.sent.length === 1))
  assert.match(first.client.sent[0].text, /Фоновая задача/)
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
  assert.match(client.sent[0].text, /Ошибка/)
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
  assert.match(client.sent[0].text, /Брифинг/)
  assert.match(client.sent[0].text, /Сделано: 1 активных/)
  assert.match(client.sent[0].text, /Токены: 150/)
  assert.equal(digestDates.length, 1)
})

test('digest respects the notification policy', async () => {
  const policy = { decide: () => ({ send: false, notify: false, reason: 'mute' }) }
  const { client, observer } = makeObserver({ policy })
  await observer.sendDigest()
  await tick(120)
  assert.equal(client.sent.length, 0)
})


test('digest is due after the scheduled minute, catches up a missed tick and never double-sends', async () => {
  let nowMs = new Date(2026, 10, 17, 8, 59, 30).getTime()
  const state = digestState()
  const { client, observer } = makeObserver({
    config: { digestEnabled: true, digestTime: '09:00' },
    state,
    now: () => nowMs,
  })

  // Before the configured time nothing is sent.
  assert.equal(await observer.maybeSendDigest(), false)
  await tick(20)
  assert.equal(client.sent.length, 0)

  // The exact 09:00 minute was missed (blocked event loop / restart at 09:01):
  // the first later tick must still send instead of skipping the whole day.
  nowMs = new Date(2026, 10, 17, 9, 1, 0).getTime()
  assert.equal(await observer.maybeSendDigest(), true)
  assert.ok(await waitFor(() => client.sent.length === 1))
  assert.match(client.sent[0].text, /Брифинг/)
  assert.equal(state.date, '2026-11-17')

  // Later ticks on the same day stay silent, and a restart cannot double-send:
  // the date was persisted before the observer was recreated.
  nowMs = new Date(2026, 10, 17, 14, 37, 0).getTime()
  assert.equal(await observer.maybeSendDigest(), false)
  const restarted = makeObserver({ config: { digestEnabled: true, digestTime: '09:00' }, state, now: () => nowMs })
  assert.equal(await restarted.observer.maybeSendDigest(), false)
  await tick(20)
  assert.equal(restarted.client.sent.length, 0)
  assert.equal(client.sent.length, 1)

  // Next day: still waiting before 09:00, due again at/after it.
  nowMs = new Date(2026, 10, 18, 8, 30, 0).getTime()
  assert.equal(await observer.maybeSendDigest(), false)
  nowMs = new Date(2026, 10, 18, 9, 0, 7).getTime()
  assert.equal(await observer.maybeSendDigest(), true)
  assert.ok(await waitFor(() => client.sent.length === 2, { timeoutMs: 2500 }))
})

test('session caches are LRU-bounded and released when a session is disposed', async () => {
  const enqueued = []
  const outbox = {
    enqueue(item) {
      enqueued.push(item)
      return true
    },
    async flush() {},
  }
  const { observer } = makeObserver({ outbox })
  for (let index = 0; index < 501; index += 1) {
    const sessionId = `session-${index}`
    observer.onGoalChanged({
      agent: { session: { id: sessionId, header: {} } },
      change: { operation: 'start', goal: { id: `goal-${index}`, objective: `цель ${index}` } },
    })
    observer.onSessionEvent({ id: sessionId, header: {} }, {
      type: 'todo/write',
      data: { todos: [{ content: 'шаг', status: 'pending' }] },
    })
  }
  // 501 distinct sessions against a 500-entry cap: the oldest key is evicted.
  assert.deepEqual(observer.cacheSizes, { goals: 500, todos: 500, todoProgress: 500 })
  assert.equal(observer.goals.some((goal) => goal.id === 'goal-0'), false)
  assert.equal(observer.goals.some((goal) => goal.id === 'goal-500'), true)

  // `session/disposed` wiring clears every cached view of that session.
  assert.equal(observer.clearSession('session-500'), true)
  assert.deepEqual(observer.cacheSizes, { goals: 499, todos: 499, todoProgress: 499 })
  assert.equal(observer.clearSession('session-500'), true)
  assert.deepEqual(observer.cacheSizes, { goals: 499, todos: 499, todoProgress: 499 })
  assert.equal(observer.clearSession(''), false)
  assert.equal(enqueued.length, 1002)
})

test('notifications are enqueued into the durable outbox when it is available', async () => {
  const enqueued = []
  const flushes = []
  const outbox = {
    enqueue(item) {
      enqueued.push(item)
      return true
    },
    async flush() {
      flushes.push(1)
    },
  }
  const { client, observer } = makeObserver({ outbox })
  observer.onSubagentEnd({
    id: 'session-child',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'ok' }],
  })
  await tick()
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].kind, 'subagent')
  assert.equal(enqueued[0].dedupeKey, 'subagent:session-child')
  assert.equal(flushes.length, 1)
  assert.equal(client.sent.length, 0)
})

test('error notifications use the critical priority lane', async () => {
  const enqueued = []
  const outbox = {
    enqueue(item) {
      enqueued.push(item)
      return true
    },
    async flush() {},
  }
  const { observer } = makeObserver({ outbox })
  observer.onAgentError({
    agent: { session: { id: 'session-1', header: {} } },
    turn: 2,
    step: 3,
    error: new Error('boom'),
  })
  await tick()
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].priority, 10)
  assert.equal(enqueued[0].dedupeKey, 'error:session-1:2:3')
})

function budgetRuntime(percent, extra = {}) {
  const budget = {
    enabled: true,
    amount: 100,
    spent: percent,
    remaining: Math.max(0, 100 - percent),
    percent,
    period: 'month',
    periodKey: '2026-11',
    start: '2026-11-01',
    end: '2026-11-09',
  }
  return {
    budgetStatus: async () => ({
      available: true,
      currency: { code: 'CNY', symbol: '¥', decimals: 2 },
      budget,
      today: { date: '2026-11-09', amount: 5 },
      month: { amount: 15 },
      total: { amount: 15 },
      ...extra,
    }),
  }
}

function createBudgetState() {
  let alerts = {}
  return {
    getBudgetAlerts: () => alerts,
    setBudgetAlerts: (next) => {
      alerts = { ...next }
    },
    getDigestDate: () => undefined,
    setDigestDate: () => {},
    snapshot: () => alerts,
  }
}

test('budget alerts fire once per threshold and period', async () => {
  const state = createBudgetState()
  const { client, observer } = makeObserver({
    config: { budgetAlertEnabled: true, budgetAlertThresholds: [80, 100] },
    runtime: budgetRuntime(85),
    state,
  })
  assert.deepEqual(await observer.checkBudget(), { sent: 1 })
  assert.equal(client.sent.length, 1)
  assert.match(client.sent[0].text, /80%/)
  assert.deepEqual(await observer.checkBudget(), { sent: 0 })
  assert.equal(client.sent.length, 1)

  const second = makeObserver({
    config: { budgetAlertEnabled: true, budgetAlertThresholds: [80, 100] },
    runtime: budgetRuntime(120),
    state,
  })
  assert.deepEqual(await second.observer.checkBudget(), { sent: 1 })
  assert.equal(second.client.sent.length, 1)
  assert.match(second.client.sent[0].text, /исчерпан/)
})

test('budget alerts are skipped when the budget is disabled or absent', async () => {
  const { observer } = makeObserver({
    config: { budgetAlertEnabled: true, budgetAlertThresholds: [80] },
    runtime: {
      budgetStatus: async () => ({ available: true, budget: { enabled: false, percent: 99 } }),
    },
    state: createBudgetState(),
  })
  assert.deepEqual(await observer.checkBudget(), { sent: 0, skipped: 'budget disabled or ledger unavailable' })
})

test('digest includes cost and budget lines', async () => {
  const { client, observer } = makeObserver({
    runtime: {
      ...makeObserver().runtime,
      costSnapshot: async () => ({
        available: true,
        currency: { code: 'CNY', symbol: '¥', decimals: 2 },
        today: { amount: 5 },
        month: { amount: 15 },
        budget: { enabled: true, amount: 100, spent: 15, percent: 15 },
      }),
    },
  })
  await observer.sendDigest()
  assert.match(client.sent.at(-1).text, /Деньги: ¥5\.00 сегодня/)
  assert.match(client.sent.at(-1).text, /бюджет 15\.0%/)
})

test('digest check failures are reported at warn, not debug', async () => {
  const nowMs = new Date(2026, 10, 17, 10, 0, 0).getTime()
  const { observer, logs } = makeObserver({
    config: { digestEnabled: true, digestTime: '09:00' },
    runtime: {
      costSnapshot: async () => {
        throw new Error('ledger boom')
      },
    },
    now: () => nowMs,
  })
  const timers = startWithCapturedTimers(observer)
  await tick(10)
  let warns = logs.filter(([level]) => level === 'warn')
  assert.equal(warns.length, 1)
  assert.equal(warns[0][1], '%s check failed: %s')
  assert.equal(warns[0][2], 'digest')
  assert.match(String(warns[0][3]), /ledger boom/)
  assert.equal(logs.some(([level]) => level === 'debug'), false)

  // Each failed scheduled run logs exactly one warn (no debug duplicate).
  timers.fire(timers.intervals, 30_000)
  await tick(10)
  warns = logs.filter(([level]) => level === 'warn')
  assert.equal(warns.length, 2)
  assert.equal(warns[1][2], 'digest')
})

test('budget check failures are reported at warn on startup and on the interval', async () => {
  const { observer, logs } = makeObserver({
    config: { digestEnabled: false, budgetAlertEnabled: true },
    runtime: {
      budgetStatus: async () => {
        throw new Error('ledger boom')
      },
    },
  })
  const timers = startWithCapturedTimers(observer)
  await tick(10)
  // Digest is disabled and the budget check is not due yet: nothing to report.
  assert.equal(logs.some(([level]) => level === 'warn'), false)

  timers.fire(timers.timeouts, 20_000) // delayed first budget check
  await tick(10)
  let warns = logs.filter(([level]) => level === 'warn')
  assert.equal(warns.length, 1)
  assert.equal(warns[0][1], '%s check failed: %s')
  assert.equal(warns[0][2], 'budget')
  assert.match(String(warns[0][3]), /ledger boom/)

  timers.fire(timers.intervals, 5 * 60_000) // periodic budget check
  await tick(10)
  warns = logs.filter(([level]) => level === 'warn')
  assert.equal(warns.length, 2)
  assert.equal(warns[1][2], 'budget')
  assert.equal(logs.some(([level]) => level === 'debug'), false)
})

test('notification handler failures are logged once at warn (outer debug catch stays last resort)', async () => {
  const policy = {
    decide() {
      throw new Error('policy boom')
    },
  }
  const { observer, logs, client } = makeObserver({ policy, config: { notifyAwaitedJobs: true } })
  observer.onSubagentEnd({ id: 'session-child', stopReason: 'completed' })
  observer.onJobEvent({ type: 'settled', awaited: true, job: { id: 'bash-abc', status: 'completed' } })
  observer.onGoalChanged({
    agent: { session: session() },
    change: { operation: 'start', goal: { id: 'goal-1', objective: 'x' } },
  })
  observer.onAgentError({ agent: { session: session() }, turn: 1, step: 1, error: new Error('boom') })
  observer.onSessionEvent(session(), { type: 'todo/write', data: { todos: [{ content: 'x', status: 'pending' }] } })
  await tick(20)

  const warns = logs.filter(([level]) => level === 'warn')
  assert.equal(warns.length, 5)
  assert.deepEqual(
    warns.map(([, message]) => message),
    [
      'subagent notification failed: %s',
      'job notification failed: %s',
      'goal notification failed: %s',
      'error notification failed: %s',
      'observer failed: %s',
    ],
  )
  for (const [, , reason] of warns) assert.match(String(reason), /policy boom/)
  assert.equal(logs.some(([level]) => level === 'debug'), false)
  assert.equal(client.sent.length, 0)
})

test('expected service-absent results and policy suppression stay at debug, not warn', async () => {
  // A partial runtime without budget/list services is an expected state, not a failure.
  const missing = makeObserver({
    config: { budgetAlertEnabled: true, digestEnabled: true, digestTime: '09:00' },
    runtime: {},
    now: () => new Date(2026, 10, 17, 10, 0, 0).getTime(),
  })
  assert.deepEqual(await missing.observer.checkBudget(), { sent: 0, skipped: 'budget disabled or ledger unavailable' })
  await missing.observer.sendDigest()
  await tick(20)
  assert.equal(missing.logs.filter(([level]) => level === 'warn').length, 0)

  // A suppressed notification is an expected decision: debug only.
  const muted = makeObserver({ policy: { decide: () => ({ send: false, notify: false, reason: 'mute' }) } })
  muted.observer.onSubagentEnd({ id: 'session-child', stopReason: 'completed' })
  assert.equal(muted.logs.filter(([level]) => level === 'warn').length, 0)
  const debugs = muted.logs.filter(([level]) => level === 'debug')
  assert.equal(debugs.length, 1)
  assert.equal(debugs[0][1], 'notification %s suppressed (%s)')
  assert.equal(debugs[0][2], 'subagent')
  assert.equal(debugs[0][3], 'mute')
})
