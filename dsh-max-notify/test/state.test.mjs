import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState, resolveStateFile } from '../lib/state.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-state-'))
const file = join(workspace, 'state.json')

/** Logger that keeps the raw warn() argument list of every call. */
function collectingLogger() {
  const calls = []
  return {
    calls,
    logger: {
      warn: (...args) => calls.push(args),
      debug() {},
    },
  }
}

const modeOf = (path) => statSync(path).mode & 0o777

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
    JSON.stringify({
      schemaVersion: 1,
      marker: 777,
      sessions: { 123456789: 'session-old' },
      mode: 'mute',
      digestDate: '2026-11-01',
    }),
  )
  const state = createState({ file: v1File, logger: { warn() {} }, chatId: 123456789 })
  assert.equal(state.storedSchemaVersion, 1)
  assert.equal(state.persistenceBlocked, false)
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

test('pushWebhookQueue keeps the 2000-entry count cap', () => {
  const file = join(workspace, 'webhook-count-cap.json')
  const state = createState({ file, logger: { warn() {} } })
  for (let index = 0; index < 2005; index += 1) {
    const result = state.pushWebhookQueue({ key: `k${index}`, update: { n: index }, at: index }, 2000)
    assert.ok(result.depth <= 2000)
  }
  const queue = state.getWebhookQueue()
  assert.equal(queue.length, 2000)
  assert.equal(state.snapshot().depth, 2000)
  assert.equal(queue[0].key, 'k5')
  assert.equal(queue[queue.length - 1].key, 'k2004')
  state.dispose()
})

test('pushWebhookQueue rejects an entry larger than 64KiB', () => {
  const file = join(workspace, 'webhook-entry-cap.json')
  const state = createState({ file, logger: { warn() {} } })
  const huge = { key: 'huge', update: { body: 'a'.repeat(64 * 1024) }, at: 1 }
  const result = state.pushWebhookQueue(huge, 200, 8 * 1024 * 1024, 64 * 1024)
  assert.equal(result.rejected, true)
  assert.equal(result.reason, 'entry-bytes')
  assert.equal(result.added, false)
  assert.equal(result.depth, 0)
  assert.equal(state.getWebhookQueue().length, 0)
  assert.equal(state.snapshot().bytes, 0)
  state.dispose()
})

test('pushWebhookQueue drops oldest entries at the 8MiB byte cap', () => {
  const file = join(workspace, 'webhook-bytes-cap.json')
  const state = createState({ file, logger: { warn() {} } })
  const body = 'x'.repeat(60 * 1024) // under the 64KiB per-entry cap
  for (let index = 0; index < 150; index += 1) {
    state.pushWebhookQueue({ key: `b${index}`, update: { body }, at: index }, 200, 8 * 1024 * 1024, 64 * 1024)
  }
  const stats = state.getWebhookQueueStats()
  const queue = state.getWebhookQueue()
  assert.ok(stats.bytes <= 8 * 1024 * 1024)
  assert.ok(stats.depth < 150 && stats.depth > 100)
  assert.equal(stats.depth, queue.length)
  assert.notEqual(queue[0].key, 'b0')
  assert.equal(queue[queue.length - 1].key, 'b149')
  state.dispose()
})

test('state snapshot exposes webhook queue bytes and survives a reload', () => {
  const file = join(workspace, 'webhook-bytes-snapshot.json')
  const first = createState({ file, logger: { warn() {} } })
  first.pushWebhookQueue({ key: 'a', update: { msg: 'hello' }, at: 1 }, 200, 8 * 1024 * 1024, 64 * 1024)
  const snapshot = first.snapshot()
  assert.equal(snapshot.depth, 1)
  assert.ok(snapshot.bytes > 0)
  assert.equal(snapshot.webhookQueueDepth, 1)
  assert.equal(snapshot.webhookQueueBytes, snapshot.bytes)
  first.save()
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  assert.equal(second.snapshot().bytes, snapshot.bytes)
  assert.equal(second.snapshot().depth, 1)
  second.dispose()
})

test('bumpWebhookHeadAttempts persists the counter immediately', () => {
  const file = join(workspace, 'webhook-attempts.json')
  const state = createState({ file, logger: { warn() {} } })
  state.pushWebhookQueue({ key: 'x', update: {}, at: 1 }, 200, 8 * 1024 * 1024, 64 * 1024)
  state.save()
  assert.equal(state.bumpWebhookHeadAttempts(), 1)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).webhookQueue[0].attempts, 1)
  assert.equal(state.bumpWebhookHeadAttempts(), 2)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).webhookQueue[0].attempts, 2)
  state.dispose()
})

test('session anchors and message routing survive reloads', () => {
  const file = join(workspace, 'anchors.json')
  const first = createState({ file, logger: { warn() {} } })
  first.setAnchor('session-thread', 'mid-anchor')
  first.mapMessage('session-thread', 'mid-reply-2')
  assert.equal(first.getAnchor('session-thread'), 'mid-anchor')
  assert.equal(first.findSessionByMid('mid-reply-2'), 'session-thread')
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  assert.equal(second.getAnchor('session-thread'), 'mid-anchor')
  assert.equal(second.findSessionByMid('mid-anchor'), 'session-thread')
  assert.equal(second.findSessionByMid('mid-reply-2'), 'session-thread')
  second.dispose()
})

test('schedule autonomy policies survive reloads and can be removed', () => {
  const policyFile = join(workspace, 'policies.json')
  const first = createState({ file: policyFile, logger: { warn() {} } })
  assert.equal(first.setSchedulePolicy('', { mode: 'auto' }), false)
  assert.equal(first.setSchedulePolicy('sched-1', { mode: 'read-only', title: 'Deploy' }), true)
  assert.equal(first.setSchedulePolicy('sched-2', { mode: 'invalid' }), false)
  first.dispose()

  const second = createState({ file: policyFile, logger: { warn() {} } })
  assert.deepEqual(second.getSchedulePolicy('sched-1')?.mode, 'read-only')
  assert.equal(second.getSchedulePolicy('sched-2'), undefined)
  second.removeSchedulePolicy('sched-1')
  assert.equal(second.getSchedulePolicy('sched-1'), undefined)
  second.dispose()
})

test('a newer state schema is preserved, backed up and never overwritten', () => {
  const directory = mkdtempSync(join(workspace, 'future-'))
  const futureFile = join(directory, 'state.json')
  const original = `${JSON.stringify({ schemaVersion: 99, marker: 5, sessions: { 1: 'session-x' } }, null, 2)}\n`
  writeFileSync(futureFile, original)
  const { calls, logger } = collectingLogger()

  const state = createState({ file: futureFile, logger })
  assert.equal(state.persistenceBlocked, true)
  assert.equal(state.storedSchemaVersion, 99)
  // An unknown schema is not interpreted: the plugin runs with empty memory.
  assert.equal(state.marker, undefined)
  assert.equal(state.sessionFor(1), undefined)

  state.setMarker(11)
  assert.equal(state.save(), false)
  state.dispose()

  // The future file stays byte-identical, no corrupt backup was made.
  assert.equal(readFileSync(futureFile, 'utf8'), original)
  const names = readdirSync(directory)
  assert.equal(names.some((name) => name.includes('.corrupt-')), false)
  const backups = names.filter((name) => name.includes('.future-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(directory, backups[0]), 'utf8'), original)
  assert.equal(modeOf(join(directory, backups[0])), 0o600)
  assert.ok(calls.some((args) => String(args[0]).includes('newer') && args.includes(99)))
  assert.ok(calls.some((args) => String(args[0]).includes('refusing to overwrite')))
})

test('corrupt state is renamed to a .corrupt backup, then a fresh file is written', () => {
  const directory = mkdtempSync(join(workspace, 'corrupt-'))
  const broken = join(directory, 'state.json')
  writeFileSync(broken, '{not json')
  const { calls, logger } = collectingLogger()

  const state = createState({ file: broken, logger })
  const backups = readdirSync(directory).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(directory, backups[0]), 'utf8'), '{not json')
  assert.ok(calls.some((args) => String(args[0]).includes('corrupt')))

  state.setMarker(7)
  assert.equal(state.save(), true)
  state.dispose()
  const saved = JSON.parse(readFileSync(broken, 'utf8'))
  assert.equal(saved.schemaVersion, 2)
  assert.equal(saved.marker, 7)
})

test('a missing state file is not treated as corruption', () => {
  const directory = mkdtempSync(join(workspace, 'missing-'))
  const missing = join(directory, 'state.json')
  const { calls, logger } = collectingLogger()

  const state = createState({ file: missing, logger })
  assert.equal(state.save(), true)
  state.dispose()
  assert.deepEqual(calls, [])
  assert.equal(readdirSync(directory).some((name) => name.includes('.corrupt-')), false)
  assert.equal(JSON.parse(readFileSync(missing, 'utf8')).schemaVersion, 2)
})

test('unreadable state is reported but never renamed', () => {
  const directory = mkdtempSync(join(workspace, 'unreadable-'))
  const path = join(directory, 'state.json')
  mkdirSync(path) // reading a directory fails with EISDIR, not a parse error
  const { calls, logger } = collectingLogger()

  const state = createState({ file: path, logger })
  assert.ok(calls.some((args) => String(args[0]).includes('cannot read')))
  assert.equal(readdirSync(directory).some((name) => name.includes('.corrupt-')), false)
  state.setMarker(1)
  state.dispose() // a failed save only logs, it must never throw
  assert.equal(statSync(path).isDirectory(), true)
  assert.deepEqual(readdirSync(directory), ['state.json'])
})

test('state file is 0600 and its directory 0700 after a save', () => {
  const directory = join(workspace, 'modes', 'max-notify')
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  chmodSync(directory, 0o755)
  const path = join(directory, 'state.json')

  const state = createState({ file: path, logger: { warn() {} } })
  state.setMarker(1)
  assert.equal(state.save(), true)
  assert.equal(modeOf(path), 0o600)
  assert.equal(modeOf(directory), 0o700)
  assert.deepEqual(readdirSync(directory), ['state.json'])
  state.dispose()
  assert.equal(modeOf(path), 0o600)
})

test('repeated atomic saves keep the file valid and leave no tmp files', () => {
  const directory = mkdtempSync(join(workspace, 'fsync-'))
  const path = join(directory, 'state.json')
  const state = createState({ file: path, logger: { warn() {} } })

  for (let index = 0; index < 25; index += 1) {
    state.setMarker(index)
    // Every save runs write → fsync(file) → rename → fsync(directory).
    assert.equal(state.save(), true)
  }
  assert.deepEqual(readdirSync(directory), ['state.json'])
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).marker, 24)
  state.dispose()
})

test('a present but unparseable schemaVersion is preserved, backed up and never overwritten', () => {
  const directory = mkdtempSync(join(workspace, 'invalid-schema-'))
  const invalidFile = join(directory, 'state.json')
  const original = `${JSON.stringify({ schemaVersion: 'v3', marker: 5, sessions: { 1: 'session-x' } }, null, 2)}\n`
  writeFileSync(invalidFile, original)
  const { calls, logger } = collectingLogger()

  const state = createState({ file: invalidFile, logger })
  assert.equal(state.persistenceBlocked, true)
  // The raw marker is exposed instead of being silently treated as absent.
  assert.equal(state.storedSchemaVersion, 'v3')
  // An unparseable schema is not interpreted: the plugin runs with empty memory.
  assert.equal(state.marker, undefined)
  assert.equal(state.sessionFor(1), undefined)

  state.setMarker(11)
  assert.equal(state.save(), false)
  state.dispose()

  assert.equal(readFileSync(invalidFile, 'utf8'), original)
  const names = readdirSync(directory)
  assert.equal(names.some((name) => name.includes('.corrupt-')), false)
  const backups = names.filter((name) => name.includes('.future-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(directory, backups[0]), 'utf8'), original)
  assert.equal(modeOf(join(directory, backups[0])), 0o600)
  assert.ok(calls.some((args) => String(args[0]).includes('invalid schemaVersion') && args.includes('v3')))
  assert.ok(calls.some((args) => String(args[0]).includes('refusing to overwrite')))
})

test('non-positive, non-integer and non-numeric schema markers are all blocked', () => {
  for (const marker of [0, -3, 1.5, true, null]) {
    const directory = mkdtempSync(join(workspace, `bad-marker-${String(marker).replace(/\W/g, '_')}-`))
    const path = join(directory, 'state.json')
    const original = JSON.stringify({ schemaVersion: marker, marker: 7 })
    writeFileSync(path, original)
    const state = createState({ file: path, logger: { warn() {} } })
    assert.equal(state.persistenceBlocked, true, `schemaVersion ${String(marker)} must block persistence`)
    assert.equal(state.marker, undefined)
    assert.equal(readFileSync(path, 'utf8'), original)
    const backups = readdirSync(directory).filter((name) => name.includes('.future-'))
    assert.equal(backups.length, 1)
    state.dispose()
  }
})

test('loading a state file applies the 200-entry webhook queue cap', () => {
  const stateFile = join(workspace, 'load-count-cap.json')
  const entries = Array.from({ length: 250 }, (_, index) => ({ key: `k${index}`, update: { n: index }, at: index }))
  writeFileSync(stateFile, JSON.stringify({ schemaVersion: 2, webhookQueue: entries }))
  const { calls, logger } = collectingLogger()

  const state = createState({ file: stateFile, logger })
  const queue = state.getWebhookQueue()
  assert.equal(queue.length, 200)
  assert.equal(queue[0].key, 'k50')
  assert.equal(queue[queue.length - 1].key, 'k249')
  assert.equal(state.snapshot().depth, 200)
  assert.ok(calls.some((args) => String(args[0]).includes('exceeded its caps on load')))
  state.dispose()
})

test('loading a state file applies the 8MiB webhook queue byte cap', () => {
  const stateFile = join(workspace, 'load-bytes-cap.json')
  const body = 'y'.repeat(60 * 1024) // under the 64KiB per-entry cap
  const entries = Array.from({ length: 140 }, (_, index) => ({ key: `b${index}`, update: { body }, at: index }))
  writeFileSync(stateFile, JSON.stringify({ schemaVersion: 2, webhookQueue: entries }))

  const state = createState({ file: stateFile, logger: { warn() {} } })
  const queue = state.getWebhookQueue()
  assert.ok(queue.length < 140 && queue.length > 100, `expected a trimmed queue, got ${queue.length}`)
  assert.ok(state.getWebhookQueueStats().bytes <= 8 * 1024 * 1024)
  assert.equal(state.snapshot().depth, queue.length)
  assert.equal(state.snapshot().bytes, state.getWebhookQueueStats().bytes)
  assert.notEqual(queue[0].key, 'b0')
  assert.equal(queue[queue.length - 1].key, 'b139')
  state.dispose()
})

test('setWebhookQueue enforces the 200-entry count cap and keeps the newest', () => {
  const stateFile = join(workspace, 'set-count-cap.json')
  const state = createState({ file: stateFile, logger: { warn() {} } })
  const queue = Array.from({ length: 250 }, (_, index) => ({ key: `s${index}`, update: { n: index }, at: index }))
  state.setWebhookQueue(queue)
  const kept = state.getWebhookQueue()
  assert.equal(kept.length, 200)
  assert.equal(kept[0].key, 's50')
  assert.equal(kept[kept.length - 1].key, 's249')
  state.dispose()
})

test('setWebhookQueue enforces the byte cap, drops oldest and filters invalid entries', () => {
  const stateFile = join(workspace, 'set-bytes-cap.json')
  const state = createState({ file: stateFile, logger: { warn() {} } })
  const body = 'z'.repeat(60 * 1024)
  const queue = Array.from({ length: 20 }, (_, index) => ({ key: `z${index}`, update: { body }, at: index }))
  queue.push({ key: 'no-update' }, null, { key: 'primitive-update', update: 'nope' })
  state.setWebhookQueue(queue, 200, 512 * 1024)
  const kept = state.getWebhookQueue()
  assert.ok(kept.length >= 7 && kept.length < 20, `expected a trimmed queue, got ${kept.length}`)
  assert.ok(state.getWebhookQueueStats().bytes <= 512 * 1024)
  assert.equal(kept[kept.length - 1].key, 'z19')
  assert.equal(kept.some((entry) => entry.key === 'no-update' || entry.key === 'primitive-update'), false)
  state.dispose()
})
