import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState, resolveStateFile } from '../lib/state.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-state-'))
const file = join(workspace, 'state.json')

test('resolveStateFile prefers explicit config and falls back to DSH_HOME', () => {
  assert.equal(resolveStateFile({ stateFile: '/tmp/custom.json' }), '/tmp/custom.json')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home'
  try {
    assert.equal(resolveStateFile({}), join('/tmp/dsh-home', 'max-notify', 'state.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('marker and active sessions survive a reload', () => {
  const first = createState({ file, logger: { warn() {} } })
  assert.equal(first.marker, undefined)
  first.setMarker(42)
  first.setSession('123456789', 'session-aaaaaaaa')
  first.save()
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  assert.equal(second.marker, 42)
  assert.equal(second.sessionFor('123456789'), 'session-aaaaaaaa')
  assert.equal(second.sessionFor('999'), undefined)
  second.forgetSession('123456789')
  assert.equal(second.sessionFor('123456789'), undefined)
  second.dispose()
})

test('corrupt state file starts fresh', () => {
  const broken = join(workspace, 'broken.json')
  writeFileSync(broken, '{not json')
  const state = createState({ file: broken, logger: { warn() {} } })
  assert.equal(state.marker, undefined)
  state.dispose()
})

test('schema v1 migrates to v2 without losing marker/session/mode', () => {
  const v1File = join(workspace, 'v1-state.json')
  writeFileSync(
    v1File,
    JSON.stringify({ marker: 777, sessions: { 123456789: 'session-old' }, mode: 'mute', digestDate: '2026-11-01' }),
  )
  const state = createState({ file: v1File, logger: { warn() {} }, chatId: 123456789 })
  assert.equal(state.marker, 777)
  assert.equal(state.sessionFor(123456789), 'session-old')
  assert.equal(state.getMode(), 'mute')
  state.setHealth({ lastPollAt: 123 })
  state.save()
  state.dispose()

  const migrated = JSON.parse(readFileSync(v1File, 'utf8'))
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.marker, 777)
  assert.equal(migrated.health.lastPollAt, 123)
})

test('processed dedupe keys are recorded once and pruned by TTL', () => {
  const file = join(workspace, 'processed.json')
  writeFileSync(file, JSON.stringify({ processed: [{ key: 'old-key', at: 0 }] }))
  const state = createState({ file, logger: { warn() {} } })
  assert.equal(state.hasProcessed('msg:1'), false)
  state.markProcessed('msg:1')
  state.markProcessed('msg:1')
  assert.equal(state.hasProcessed('msg:1'), true)
  assert.equal(state.hasProcessed('old-key'), false)
  state.save()
  state.dispose()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.processed.filter((entry) => entry.key === 'msg:1').length, 1)
  assert.equal(saved.processed.some((entry) => entry.key === 'old-key'), false)
})

test('pending cards survive reload until explicitly removed', () => {
  const file = join(workspace, 'cards.json')
  const first = createState({ file, logger: { warn() {} } })
  first.addPendingCard({ token: 'tok-1', kind: 'approval', messageId: 'mid-1', chatId: '123456789' })
  first.save()
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  assert.equal(second.listPendingCards().length, 1)
  assert.equal(second.listPendingCards()[0].messageId, 'mid-1')
  second.removePendingCard('tok-1')
  assert.equal(second.listPendingCards().length, 0)
  second.dispose()
})

test('approval rules are scoped by tool and expiry', () => {
  const file = join(workspace, 'rules.json')
  const state = createState({ file, logger: { warn() {} } })
  state.setApprovalRule('deploy', Date.now() + 60_000)
  assert.equal(state.approvalRuleFor('deploy').tool, 'deploy')
  assert.equal(state.approvalRuleFor('bash'), undefined)

  state.setApprovalRule('expired', Date.now() - 1)
  assert.equal(state.approvalRuleFor('expired'), undefined)
  state.clearApprovalRules()
  assert.equal(state.approvalRuleFor('deploy'), undefined)
  state.dispose()
})

test('budget alert timestamps persist across reloads', () => {
  const file = join(workspace, 'budget-alerts.json')
  const first = createState({ file, logger: { warn() {} } })
  first.setBudgetAlerts({ '2026-11:80': 123 })
  assert.deepEqual(first.getBudgetAlerts(), { '2026-11:80': 123 })
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  assert.deepEqual(second.getBudgetAlerts(), { '2026-11:80': 123 })
  second.dispose()
})

test('webhook updates are persisted in a durable queue', () => {
  const file = join(workspace, 'webhook-queue.json')
  const first = createState({ file, logger: { warn() {} } })
  const update = { update_type: 'message_created', message: { body: { mid: 'm1' } } }
  first.setWebhookQueue([{ key: 'msg:1:m1', update, at: 123 }])
  first.save()
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  const queue = second.getWebhookQueue()
  assert.equal(queue.length, 1)
  assert.equal(queue[0].key, 'msg:1:m1')
  assert.equal(queue[0].update.update_type, 'message_created')
  second.dispose()
})
