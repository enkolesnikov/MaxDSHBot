import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'
import { createInteractions } from '../lib/interactions.mjs'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

const silentLogger = { info() {}, warn() {}, debug() {} }

function createFakeClient() {
  const sent = []
  const edits = []
  const answers = []
  return {
    sent,
    edits,
    answers,
    async sendMessage(params) {
      sent.push(params)
      return { message: { body: { mid: `mid-${sent.length}` } } }
    },
    async editMessage(params) {
      edits.push(params)
      return { success: true }
    },
    async answerCallback(callbackId, body) {
      answers.push({ callbackId, body })
    },
  }
}

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
  assert.match(client.sent[0].text, /Требуется разрешение/)
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
  assert.match(client.edits.at(-1).text, /Отклонено.*\(в GUI\)/)
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
  assert.match(client.edits.at(-1).text, /Ответ дан в GUI/)
})

test('dispose resolves pending approvals as cancelled', async () => {
  const { interactions } = makeInteractions()
  const outcomePromise = interactions.handleApproval(approvalRequest(), () => new Promise(() => {}))
  await tick()
  interactions.dispose()
  assert.equal(await outcomePromise, 'cancelled')
})
