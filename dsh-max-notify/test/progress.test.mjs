import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'
import { createProgress } from '../lib/progress.mjs'
import { createFakeClient, tick } from './helpers/fakes.mjs'

function makeProgress(overrides = {}, target = { chatId: '123456789' }) {
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
    target,
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

test('a malformed delegationDepth keeps the session top-level', async () => {
  const { client, progress } = makeProgress()
  progress.onTurnStart(session('session-bad-depth', { cwd: '/work/app', delegationDepth: 'n/a' }))
  await tick(30)
  assert.equal(client.sent.length, 1)
  progress.onTurnEnd(session('session-bad-depth'))
})

test('progress cards target a user dialog when only userId is configured', async () => {
  const { client, progress } = makeProgress({}, { userId: '777' })
  progress.onTurnStart(session('session-user'))
  await tick(30)
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].userId, '777')
  assert.equal(client.sent[0].chatId, undefined)
  // Typing actions need a chat id, so the user dialog gets none.
  assert.equal(client.actions.length, 0)
  progress.onTurnEnd(session('session-user'))
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
