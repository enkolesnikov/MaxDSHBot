import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'
import { createInteractions } from '../lib/interactions.mjs'
import { resolveAutonomyPolicy } from '../lib/autonomy.mjs'
import { awaitSettled, createFakeClient, tick } from './helpers/fakes.mjs'

const silentLogger = { info() {}, warn() {}, debug() {} }

function makeInteractions(overrides = {}) {
  const client = createFakeClient()
  const interactions = createInteractions({
    client,
    config: normalizeConfig({
      botToken: 't',
      chatId: '123456789',
      allowedUserIds: ['987654321'],
      ...overrides,
    }),
    logger: silentLogger,
    target: { chatId: '123456789' },
    resolveTitle: () => 'Тестовая сессия',
    state: overrides.state,
    audit: overrides.audit,
    resolveAutonomy: overrides.resolveAutonomy,
  })
  return { client, interactions }
}

function cardButtons(client) {
  const attachments = client.sent.at(-1)?.attachments
  return attachments?.[0]?.payload?.buttons ?? []
}

function approvalRequest(agent = { session: { id: 'session-a', header: {} } }) {
  return {
    agent,
    toolName: 'bash',
    reason: 'нужен доступ к /root',
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

test('approval answered from MAX resolves allowed-once and marks the card', async () => {
  const { client, interactions } = makeInteractions()
  let guiResolve
  const guiPromise = new Promise((resolve) => {
    guiResolve = resolve
  })
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => guiPromise)
  await tick()

  assert.equal(client.sent.length, 1)
  assert.match(client.sent[0].text, /Разрешить/)
  const buttons = cardButtons(client)
  assert.equal(buttons.length, 2)

  const allow = buttons[0][0].payload
  assert.equal(await interactions.handleCallback({ callbackId: 'cb-allow', payload: allow }), true)
  assert.equal(await outcomePromise, 'allowed-once')
  assert.match(client.edits.at(-1).text, /Разрешено/)
  assert.equal(client.answers.at(-1).body.notification, '✅ Разрешено')
  guiResolve('unavailable')
  await tick()
})

test('approval denied from MAX resolves rejected', async () => {
  const { client, interactions } = makeInteractions()
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  await tick()
  const deny = cardButtons(client)[1][0].payload
  await interactions.handleCallback({ callbackId: 'cb-deny', payload: deny })
  assert.equal(await outcomePromise, 'rejected')
  assert.match(client.edits.at(-1).text, /Отклонено/)
})

test('GUI winning the approval race edits the MAX card and returns the GUI outcome', async () => {
  const { client, interactions } = makeInteractions()
  const outcome = await interactions.handleApproval(approvalRequest(), async () => 'rejected')
  assert.equal(outcome, 'rejected')
  assert.match(client.edits.at(-1).text, /Отклонено.*\(GUI\)/)
})

test('subagent approvals are delegated to the GUI only', async () => {
  const { client, interactions } = makeInteractions()
  const subagent = { session: { id: 'session-child', header: { origin: 'subagent', delegationDepth: 1 } } }
  const outcome = await interactions.handleApproval(approvalRequest(subagent), async () => 'allowed-once')
  assert.equal(outcome, 'allowed-once')
  assert.equal(client.sent.length, 0)
})

test('question option button resolves the structured answer', async () => {
  const { client, interactions } = makeInteractions()
  const request = {
    agent: { session: { id: 'session-b', header: {} } },
    questions: [{ id: 'q1', question: 'Какой вариант?', options: [{ label: 'A' }, { label: 'B' }] }],
    signal: new AbortController().signal,
  }
  const answerPromise = interactions.handleQuestions(request, () => new Promise(() => {}))
  await tick()
  assert.match(client.sent[0].text, /Какой вариант/)

  const buttons = cardButtons(client)
  assert.equal(buttons.length, 2)
  await interactions.handleCallback({ callbackId: 'cb-q', payload: buttons[1][0].payload })
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['B'] }])
  assert.match(client.edits.at(-1).text, /Ответ отправлен/)
})

test('free-text answer resolves the question as custom text', async () => {
  const { interactions } = makeInteractions()
  const request = {
    agent: { session: { id: 'session-c', header: {} } },
    questions: [{ id: 'q1', question: 'Что делаем?' }],
    signal: new AbortController().signal,
  }
  const answerPromise = interactions.handleQuestions(request, () => new Promise(() => {}))
  await tick()
  assert.equal(await interactions.tryAnswerText({ chatId: '123456789', text: 'свой вариант' }), true)
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: [], custom: 'свой вариант' }])
})

test('multi-question numeric answers map by position', async () => {
  const { interactions } = makeInteractions()
  const request = {
    agent: { session: { id: 'session-d', header: {} } },
    questions: [
      { id: 'q1', question: 'Первый?', options: [{ label: 'A1' }, { label: 'A2' }] },
      { id: 'q2', question: 'Второй?', options: [{ label: 'B1' }, { label: 'B2' }] },
    ],
    signal: new AbortController().signal,
  }
  const answerPromise = interactions.handleQuestions(request, () => new Promise(() => {}))
  await tick()
  assert.equal(await interactions.tryAnswerText({ chatId: '123456789', text: '2 1' }), true)
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [
    { id: 'q1', selected: ['A2'] },
    { id: 'q2', selected: ['B1'] },
  ])
})

test('stale callbacks are answered with a notice', async () => {
  const { client, interactions } = makeInteractions()
  assert.equal(
    await interactions.handleCallback({
      callbackId: 'cb-old',
      payload: JSON.stringify({ t: 'ap', tk: 'missing', v: 'allow' }),
    }),
    true,
  )
  assert.match(client.answers.at(-1).body.notification, /неактуально/)
})

test('GUI winning the question race returns the GUI answer and edits the card', async () => {
  const { client, interactions } = makeInteractions()
  const request = {
    agent: { session: { id: 'session-e', header: {} } },
    questions: [{ id: 'q1', question: 'Да или нет?', options: [{ label: 'Да' }, { label: 'Нет' }] }],
    signal: new AbortController().signal,
  }
  const answer = await interactions.handleQuestions(request, async () => ({
    answers: [{ id: 'q1', selected: ['Да'] }],
  }))
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['Да'] }])
  assert.match(client.edits.at(-1).text, /Ответ дан \(GUI\)/)
})

test('dispose resolves pending approvals as cancelled', async () => {
  const { interactions } = makeInteractions()
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  await tick()
  interactions.dispose()
  assert.equal(await outcomePromise, 'cancelled')
})


test('an unanswered approval is rejected after the timeout', async () => {
  const audit = { entries: [], approve(entry) { this.entries.push(entry) } }
  const { client, interactions } = makeInteractions({ approvalTimeoutMs: 30, audit })
  const startedAt = Date.now()
  // The plugin unref's its approval timeout (a pending approval must not keep
  // the host process alive); the test holds the event loop referenced itself
  // until that unref'd timer fires, instead of the old file-wide keepalive.
  const outcome = await awaitSettled(
    interactions.handleApproval(approvalRequest(), () => new Promise(() => {})),
    { label: 'MAX approval timeout' },
  )
  assert.equal(outcome, 'rejected')
  assert.ok(Date.now() - startedAt >= 25)
  assert.match(client.edits.at(-1).text, /таймаут/i)
  assert.deepEqual(audit.entries.at(-1), { tool: 'bash', outcome: 'rejected', source: 'timeout' })
})

test('a remembered rule auto-allows without sending a card', async () => {
  const calls = []
  const state = {
    approvalRuleFor(tool) {
      return tool === 'bash' ? { tool: 'bash', until: Date.now() + 60_000 } : undefined
    },
    addPendingCard() {},
    removePendingCard() {},
    setApprovalRule(tool, until) {
      calls.push({ tool, until })
    },
  }
  const audit = { entries: [], approve(entry) { this.entries.push(entry) } }
  const { client, interactions } = makeInteractions({ state, audit })
  const outcome = await interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  assert.equal(outcome, 'allowed-once')
  assert.equal(client.sent.length, 0)
  assert.deepEqual(audit.entries.at(-1), { tool: 'bash', outcome: 'allowed-once', source: 'rule' })
})

test('"allow and remember" stores a scoped rule and resolves allowed-once', async () => {
  const stored = []
  const state = {
    approvalRuleFor() {
      return undefined
    },
    addPendingCard() {},
    removePendingCard() {},
    setApprovalRule(tool, until) {
      stored.push({ tool, until })
    },
  }
  const audit = { entries: [], approve(entry) { this.entries.push(entry) } }
  const { client, interactions } = makeInteractions({
    approvalRememberTools: ['bash'],
    state,
    audit,
  })
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  await tick()
  const buttons = cardButtons(client)
  assert.equal(buttons.length, 3)
  const remember = buttons[2][0].payload
  assert.equal(JSON.parse(remember).v, 'allow-always')
  await interactions.handleCallback({ callbackId: 'cb-remember', payload: remember })
  assert.equal(await outcomePromise, 'allowed-once')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].tool, 'bash')
  assert.ok(stored[0].until > Date.now())
  assert.match(client.answers.at(-1).body.notification, /запомнено/)
  assert.deepEqual(audit.entries.at(-1), { tool: 'bash', outcome: 'allowed-once', source: 'max-remember' })
})

test('dispose marks pending cards as stale', async () => {
  const { client, interactions } = makeInteractions()
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  await tick()
  interactions.dispose()
  assert.equal(await outcomePromise, 'cancelled')
  assert.match(client.edits.at(-1).text, /перезагружен/i)
})

test('plan review sends the full plan as a file and approves from a button', async () => {
  const { client, interactions } = makeInteractions()
  const plan = `# План обновления\n\n${'шаг '.repeat(800)}`
  const request = {
    agent: { session: { id: 'session-plan', header: {} } },
    questions: [
      {
        id: 'review-1',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: plan,
        options: [
          { label: 'Approve', description: 'leave plan mode' },
          { label: 'Keep planning', description: 'stay' },
        ],
        intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan' },
      },
    ],
    signal: new AbortController().signal,
  }
  const answerPromise = interactions.handleQuestions(request, () => new Promise(() => {}))
  await tick()

  assert.equal(client.uploads.length, 1)
  assert.equal(client.uploads[0].filename, 'plan.md')
  assert.match(client.sent[0].text, /Review плана/)
  const attachments = client.sent[0].attachments ?? []
  assert.ok(attachments.some((item) => item.type === 'file' && item.payload?.token === 'token-file'))
  const rows = attachments.find((item) => item.type === 'inline_keyboard')?.payload?.buttons ?? []
  assert.equal(rows.length, 2)

  const approve = rows[0][0].payload
  assert.equal(JSON.parse(approve).t, 'q')
  await interactions.handleCallback({ callbackId: 'cb-plan-approve', payload: approve })
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [{ id: 'review-1', selected: ['Approve'] }])
  assert.match(client.edits.at(-1).text, /одобрен/i)
})

test('plan review free-text feedback becomes a custom answer', async () => {
  const { client, interactions } = makeInteractions()
  const request = {
    agent: { session: { id: 'session-plan-2', header: {} } },
    questions: [
      {
        id: 'review-2',
        header: 'Plan review',
        question: 'Approve this plan?',
        detail: '# План\n\nСделать А и Б.',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-2' },
      },
    ],
    signal: new AbortController().signal,
  }
  const answerPromise = interactions.handleQuestions(request, () => new Promise(() => {}))
  await tick()
  await interactions.tryAnswerText({ chatId: 123456789, text: 'добавь ещё тесты' })
  const answer = await answerPromise
  assert.equal(answer.answers[0].custom, 'добавь ещё тесты')
  assert.match(client.edits.at(-1).text, /Фидбек/i)
})

test('autonomy read-only rejects side effects without a MAX card', async () => {
  const auditEntries = []
  const { client, interactions } = makeInteractions({
    resolveAutonomy: async () => ({ mode: 'read-only', scheduleId: 'sched-1', title: 'Deploy' }),
    audit: { write: (entry) => auditEntries.push(entry) },
  })
  const outcome = await interactions.handleApproval(
    approvalRequest({ session: { id: 'sched-session', header: {} } }),
    () => new Promise(() => {}),
  )
  assert.equal(outcome, 'rejected')
  assert.equal(client.sent.length, 0)
  assert.equal(auditEntries.at(-1).kind, 'autonomy')
  assert.equal(auditEntries.at(-1).outcome, 'rejected')

  const read = makeInteractions({
    resolveAutonomy: async () => ({ mode: 'read-only', scheduleId: 'sched-1', title: 'Deploy' }),
  })
  const request = { ...approvalRequest({ session: { id: 'sched-session', header: {} } }), toolName: 'read' }
  assert.equal(await read.interactions.handleApproval(request, () => new Promise(() => {})), 'allowed-once')
  assert.equal(read.client.sent.length, 0)
})

test('read-only network tools follow readOnlyNetwork: denied by default, allowed when opted in', async () => {
  const readOnlyPolicy = async () => ({ mode: 'read-only', scheduleId: 'sched-net', title: 'Net' })
  const webRequest = (toolName) => ({
    ...approvalRequest({ session: { id: 'sched-net-session', header: {} } }),
    toolName,
  })

  const denied = makeInteractions({ resolveAutonomy: readOnlyPolicy })
  assert.equal(await denied.interactions.handleApproval(webRequest('web_search'), () => new Promise(() => {})), 'rejected')
  assert.equal(denied.client.sent.length, 0)

  const allowed = makeInteractions({ readOnlyNetwork: true, resolveAutonomy: readOnlyPolicy })
  assert.equal(await allowed.interactions.handleApproval(webRequest('web_fetch'), () => new Promise(() => {})), 'allowed-once')
  assert.equal(allowed.client.sent.length, 0)

  // File tools keep the same allow/deny with and without the network opt-in.
  const file = makeInteractions({ readOnlyNetwork: true, resolveAutonomy: readOnlyPolicy })
  assert.equal(await file.interactions.handleApproval(webRequest('read'), () => new Promise(() => {})), 'allowed-once')
  assert.equal(file.client.sent.length, 0)
})

test('autonomy auto allows approvals silently when session identity is verified', async () => {
  const { client, interactions } = makeInteractions({
    resolveAutonomy: async () => ({
      mode: 'auto', scheduleId: 'sched-auto', title: 'Nightly', identityVerified: true,
    }),
  })
  assert.equal(await interactions.handleApproval(approvalRequest(), () => new Promise(() => {})), 'allowed-once')
  assert.equal(client.sent.length, 0)
})

// ── P1: an unverified title match must not silently auto-approve ────────────

test('autonomy auto without verified identity falls back to a MAX card', async () => {
  const auditEntries = []
  const { client, interactions } = makeInteractions({
    resolveAutonomy: async () => ({
      mode: 'auto', scheduleId: 'sched-auto', title: 'Nightly', identityVerified: false,
    }),
    audit: { write: (entry) => auditEntries.push(entry), approve() {} },
  })
  let guiResolve
  const guiPromise = new Promise((resolve) => { guiResolve = resolve })
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => guiPromise)
  await tick()
  assert.equal(client.sent.length, 1)
  assert.equal(auditEntries.length, 0)

  const allow = cardButtons(client)[0][0].payload
  assert.equal(await interactions.handleCallback({ callbackId: 'cb-allow', payload: allow }), true)
  assert.equal(await outcomePromise, 'allowed-once')
  guiResolve('unavailable')
  await tick()
})

test('a mismatched session id cannot inherit an auto policy through the real matcher', async () => {
  const now = Date.now()
  const schedules = [{
    id: 'sched-1',
    title: 'Nightly',
    targetSessionId: 'real-session',
    involvedSessionIds: ['real-session'],
    executionActive: true,
    status: 'active',
  }]
  const policies = { 'sched-1': { mode: 'auto', title: 'Nightly' } }
  const { client, interactions } = makeInteractions({
    resolveAutonomy: async (session) => resolveAutonomyPolicy({
      sessionId: session?.id, sessionTitle: 'Nightly', schedules, policies, now,
    }),
  })
  const outcomePromise = interactions.handleApproval(
    approvalRequest({ session: { id: 'attacker-session', header: {} } }),
    () => new Promise(() => {}),
  )
  await tick()
  // No silent auto: the normal approval card is shown instead.
  assert.equal(client.sent.length, 1)
  const deny = cardButtons(client)[1][0].payload
  await interactions.handleCallback({ callbackId: 'cb-deny', payload: deny })
  assert.equal(await outcomePromise, 'rejected')
})

test('fresh delivery plus a matching title cannot auto-approve another session', async () => {
  const now = Date.now()
  const schedules = [{
    id: 'sched-1',
    title: 'Nightly',
    targetSessionId: 'real-session',
    involvedSessionIds: [],
    executionActive: false,
    status: 'active',
    lastDelivery: { deliveredAt: new Date(now - 60_000).toISOString() },
  }]
  const policies = { 'sched-1': { mode: 'auto', title: 'Nightly' } }
  const { client, interactions } = makeInteractions({
    resolveAutonomy: async (session) => resolveAutonomyPolicy({
      sessionId: session?.id, sessionTitle: 'Nightly', schedules, policies, now,
    }),
  })
  const outcomePromise = interactions.handleApproval(
    approvalRequest({ session: { id: 'unrelated-session', header: {} } }),
    () => new Promise(() => {}),
  )
  await tick()
  assert.equal(client.sent.length, 1)
  const deny = cardButtons(client)[1][0].payload
  await interactions.handleCallback({ callbackId: 'cb-deny', payload: deny })
  assert.equal(await outcomePromise, 'rejected')
})

test('a title-only auto policy is demoted to inherit and still prompts on the card', async () => {
  const now = Date.now()
  const schedules = [{
    id: 'sched-new',
    title: 'Nightly',
    targetSessionId: '',
    involvedSessionIds: [],
    executionActive: false,
    status: 'active',
    lastDelivery: { deliveredAt: new Date(now - 60_000).toISOString() },
  }]
  const policies = { 'sched-new': { mode: 'auto', title: 'Nightly' } }
  const { client, interactions } = makeInteractions({
    resolveAutonomy: async (session) => resolveAutonomyPolicy({
      sessionId: session?.id, sessionTitle: 'Nightly', schedules, policies, now,
    }),
  })
  const outcomePromise = interactions.handleApproval(
    approvalRequest({ session: { id: 'new-session', header: {} } }),
    () => new Promise(() => {}),
  )
  await tick()
  assert.equal(client.sent.length, 1)
  const deny = cardButtons(client)[1][0].payload
  await interactions.handleCallback({ callbackId: 'cb-deny', payload: deny })
  assert.equal(await outcomePromise, 'rejected')
})

// ── P2: bounded per-chat question index, dispose cleanup, shared helpers ─────

test('the per-chat question index is bounded to 500 chats and evicts the oldest', async () => {
  const client = createFakeClient()
  const target = { chatId: 'chat-0' }
  const interactions = createInteractions({
    client,
    config: normalizeConfig({ botToken: 't', chatId: 'chat-0', allowedUserIds: ['1'] }),
    logger: silentLogger,
    target,
    resolveTitle: () => 'Тестовая сессия',
  })

  // Rotate the shared target so each card lands in a different chat (the cache
  // key is the chat that received the question card).
  const pending = []
  for (let index = 0; index < 501; index += 1) {
    target.chatId = `chat-${index}`
    pending.push(
      interactions.handleQuestions(
        {
          agent: { session: { id: `session-${index}`, header: {} } },
          questions: [{ id: 'q1', question: 'Что делаем?' }],
          signal: new AbortController().signal,
        },
        () => new Promise(() => {}),
      ),
    )
    await tick(0)
  }

  // The first chat fell out of the LRU index: free text cannot reach its card.
  assert.equal(await interactions.tryAnswerText({ chatId: 'chat-0', text: 'поздно' }), false)
  // The most recent chat is still indexed and answers normally.
  assert.equal(await interactions.tryAnswerText({ chatId: 'chat-500', text: 'ответ' }), true)

  interactions.dispose()
  await tick()
  await Promise.all(pending)
})

test('dispose clears pending questions and the per-chat index', async () => {
  const { interactions } = makeInteractions()
  const request = {
    agent: { session: { id: 'session-dispose', header: {} } },
    questions: [
      { id: 'q1', question: 'Первый?' },
      { id: 'q2', question: 'Второй?' },
    ],
    signal: new AbortController().signal,
  }
  const answerPromise = interactions.handleQuestions(request, () => new Promise(() => {}))
  await tick()
  // Partial answer keeps the question pending and indexed.
  assert.equal(await interactions.tryAnswerText({ chatId: '123456789', text: 'ответ на первый' }), true)

  interactions.dispose()
  const answer = await answerPromise
  assert.deepEqual(answer.answers, [
    { id: 'q1', selected: [], custom: 'ответ на первый' },
    { id: 'q2', selected: [] },
  ])
  assert.equal(await interactions.tryAnswerText({ chatId: '123456789', text: 'ещё' }), false)
})

test('a null chatId target falls back to userId through the shared targetQuery', async () => {
  const client = createFakeClient()
  const interactions = createInteractions({
    client,
    config: normalizeConfig({ botToken: 't', userId: '987654321', allowedUserIds: ['987654321'] }),
    logger: silentLogger,
    target: { chatId: null, userId: '987654321' },
    resolveTitle: () => 'Тестовая сессия',
  })
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  await tick()
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].userId, '987654321')
  assert.equal('chatId' in client.sent[0], false)

  const deny = cardButtons(client)[1][0].payload
  await interactions.handleCallback({ callbackId: 'cb-deny', payload: deny })
  assert.equal(await outcomePromise, 'rejected')
})
