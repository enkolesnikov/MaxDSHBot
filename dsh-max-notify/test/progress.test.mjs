import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'
import { createProgress } from '../lib/progress.mjs'

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeClient() {
  const sent = []
  const edits = []
  const deleted = []
  const actions = []
  return {
    sent,
    edits,
    deleted,
    actions,
    async sendMessage(params) {
      sent.push(params)
      return { message: { body: { mid: `mid-${sent.length}` } } }
    },
    async editMessage(params) {
      edits.push(params)
      return { success: true }
    },
    async deleteMessage(messageId) {
      deleted.push(messageId)
      return { success: true }
    },
    async sendAction(chatId, action) {
      actions.push({ chatId, action })
      return { success: true }
    },
  }
}

function makeProgress(overrides = {}) {
  const client = createFakeClient()
  const progress = createProgress({
    client,
    config: normalizeConfig({
      botToken: 't',
      chatId: '123456789',
      progressDelayMs: 5,
      progressThrottleMs: 5,
      progressTextLimit: 200,
      typing: true,
      ...overrides,
    }),
    logger: { info() {}, warn() {}, debug() {} },
    target: { chatId: '123456789' },
  })
  return { client, progress }
}

const session = (id = 'session-live', header = { cwd: '/work/app', delegationDepth: 0 }) => ({ id, header })

test('progress card is created after the delay, edited on tool activity and deleted at turn end', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session())
  await tick(30)
  assert.equal(client.sent.length, 1)
  assert.match(client.sent[0].text, /Работаю/)

  progress.onTool(session(), { name: 'bash' })
  await tick(40)
  assert.ok(client.edits.length >= 1)
  assert.match(client.edits.at(-1).text, /bash/)

  progress.onTurnEnd(session())
  await tick(20)
  assert.equal(client.deleted.length, 1)
})

test('assistant stream text appears in the progress card', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session('session-stream'))
  await tick(30)
  progress.onStream(session('session-stream'), {
    type: 'chunk',
    chunk: { type: 'text-delta', text: 'пишу ответ' },
  })
  await tick(40)
  assert.ok(client.edits.some((edit) => edit.text.includes('пишу ответ')))
})

test('a turn that ends before the delay sends no progress card', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session('session-fast'))
  progress.onTurnEnd(session('session-fast'))
  await tick(40)
  assert.equal(client.sent.length, 0)
})

test('subagent sessions get no progress card', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session('session-child', { origin: 'subagent', delegationDepth: 1 }))
  await tick(30)
  assert.equal(client.sent.length, 0)
})

test('typing action is sent while a turn is active', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session('session-typing'))
  await tick(30)
  assert.ok(client.actions.length >= 1)
  assert.equal(client.actions[0].action, 'typing_on')
  progress.onTurnEnd(session('session-typing'))
})

test('dispose removes active cards', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session('session-dispose'))
  await tick(30)
  progress.dispose()
  await tick(20)
  assert.equal(client.deleted.length, 1)
})
