import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OUTBOX_SCHEMA_VERSION, createOutbox, resolveOutboxFile } from '../lib/outbox.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-outbox-'))
let fileCounter = 0
const freshFile = () => join(workspace, `outbox-${++fileCounter}.json`)
const freshDir = () => mkdtempSync(join(workspace, 'case-'))

const silent = { warn() {}, debug() {}, info() {} }

/** Logger that keeps the raw warn() argument list of every call. */
function collectingLogger() {
  const calls = []
  return {
    calls,
    logger: {
      warn: (...args) => calls.push(args),
      debug() {},
      info() {},
    },
  }
}

const modeOf = (path) => statSync(path).mode & 0o777

function memoryNow(initial = 1_000_000) {
  let time = initial
  return { now: () => time, advance: (ms) => { time += ms } }
}

test('resolveOutboxFile prefers explicit config and falls back to DSH_HOME', () => {
  assert.equal(resolveOutboxFile({ outboxFile: '/tmp/custom-outbox.json' }), '/tmp/custom-outbox.json')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home'
  try {
    assert.equal(resolveOutboxFile({}), join('/tmp/dsh-home', 'max-notify', 'outbox.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('flush sends pending items and records delivery keys', async () => {
  const { now } = memoryNow()
  const sent = []
  const outbox = createOutbox({
    file: freshFile(),
    now,
    logger: silent,
    send: async (call, params) => {
      sent.push({ call, params })
    },
  })
  assert.equal(outbox.enqueue({ params: { text: 'one' }, dedupeKey: 'k1' }), true)
  const result = await outbox.flush()
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 })
  assert.equal(sent.length, 1)
  assert.equal(outbox.snapshot().pending, 0)
  assert.equal(outbox.isDelivered('k1'), true)
  // duplicate enqueue is ignored
  assert.equal(outbox.enqueue({ params: { text: 'one' }, dedupeKey: 'k1' }), false)
})

test('failed items stay queued, are retried and removed after success', async () => {
  const clock = memoryNow()
  let failures = 1
  const attempts = []
  const outbox = createOutbox({
    file: freshFile(),
    now: clock.now,
    logger: silent,
    send: async () => {
      attempts.push(1)
      if (failures > 0) {
        failures -= 1
        throw new Error('MAX unavailable')
      }
    },
  })
  outbox.enqueue({ params: { text: 'retry me' }, dedupeKey: 'retry' })
  await outbox.flush()
  assert.equal(outbox.snapshot().pending, 1)
  assert.equal(outbox.snapshot().failed, 1)
  assert.match(outbox.snapshot().lastError, /unavailable/)

  clock.advance(10_000)
  const second = await outbox.flush()
  assert.deepEqual(second, { attempted: 1, sent: 1, failed: 0 })
  assert.equal(outbox.snapshot().pending, 0)
  assert.equal(attempts.length, 2)
})

test('deliverNow falls back to the queue when the direct send fails', async () => {
  const { now } = memoryNow()
  let fail = true
  const outbox = createOutbox({
    file: freshFile(),
    now,
    logger: silent,
    send: async () => {
      if (fail) throw new Error('boom')
    },
  })
  const result = await outbox.deliverNow({ text: 'hello' }, { dedupeKey: 'final:1' })
  assert.equal(result.queued, true)
  assert.equal(outbox.snapshot().pending, 1)
  fail = false
  const flush = await outbox.flush()
  assert.equal(flush.sent, 1)
  assert.equal(outbox.isDelivered('final:1'), true)
})

test('pending items are ordered by priority first', async () => {
  const { now } = memoryNow()
  const calls = []
  const outbox = createOutbox({
    file: freshFile(),
    now,
    logger: silent,
    send: async (call, params) => calls.push(params.text),
  })
  outbox.enqueue({ params: { text: 'normal-1' }, priority: 0 })
  outbox.enqueue({ params: { text: 'normal-2' }, priority: 0 })
  outbox.enqueue({ params: { text: 'critical' }, priority: 10 })
  await outbox.flush()
  assert.equal(calls[0], 'critical')
})

test('expired pending items are pruned by TTL', async () => {
  const clock = memoryNow()
  const outbox = createOutbox({
    file: freshFile(),
    now: clock.now,
    ttlHours: 1,
    logger: silent,
    send: async () => {},
  })
  outbox.enqueue({ params: { text: 'old' } })
  clock.advance(2 * 60 * 60 * 1000)
  await outbox.flush()
  assert.equal(outbox.snapshot().pending, 0)
  assert.equal(outbox.snapshot().dropped, 1)
})

test('the pending queue is capped by maxItems', async () => {
  const { now } = memoryNow()
  const outbox = createOutbox({
    file: freshFile(),
    now,
    maxItems: 2,
    logger: silent,
    send: async () => {},
  })
  outbox.enqueue({ params: { text: 'a' } })
  outbox.enqueue({ params: { text: 'b' } })
  outbox.enqueue({ params: { text: 'c' } })
  assert.equal(outbox.snapshot().pending, 2)
  assert.equal(outbox.snapshot().dropped, 1)
})

test('pending items survive a reload from disk', async () => {
  const file = freshFile()
  const { now } = memoryNow()
  const first = createOutbox({ file, now, logger: silent, send: async () => {} })
  first.enqueue({ params: { text: 'persisted' }, dedupeKey: 'persist' })
  first.save()

  const sent = []
  const second = createOutbox({
    file,
    now,
    logger: silent,
    send: async (call, params) => sent.push(params.text),
  })
  assert.equal(second.snapshot().pending, 1)
  await second.flush()
  assert.deepEqual(sent, ['persisted'])
})

test('a newer outbox version is preserved, backed up and never overwritten', () => {
  const directory = freshDir()
  const path = join(directory, 'outbox.json')
  const original = `${JSON.stringify(
    {
      version: 2,
      pending: [{ id: 'p1', call: 'sendMessage', params: { text: 'queued' }, createdAt: 1 }],
      delivered: [{ key: 'done', at: 1 }],
    },
    null,
    2,
  )}\n`
  writeFileSync(path, original)
  const { calls, logger } = collectingLogger()

  const outbox = createOutbox({ file: path, logger, send: async () => {} })
  assert.equal(outbox.persistenceBlocked, true)
  assert.equal(outbox.storedVersion, 2)
  // The unknown format is neither replayed nor treated as delivered history.
  assert.equal(outbox.snapshot().pending, 0)
  assert.equal(outbox.isDelivered('done'), false)

  assert.equal(outbox.enqueue({ params: { text: 'new' } }), true)
  assert.equal(outbox.save(), false)
  outbox.dispose()

  assert.equal(readFileSync(path, 'utf8'), original)
  const names = readdirSync(directory)
  assert.equal(names.some((name) => name.includes('.corrupt-')), false)
  const backups = names.filter((name) => name.includes('.future-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(directory, backups[0]), 'utf8'), original)
  assert.equal(modeOf(join(directory, backups[0])), 0o600)
  assert.ok(calls.some((args) => String(args[0]).includes('version %d') && args.includes(2)))
  assert.ok(calls.some((args) => String(args[0]).includes('refusing to overwrite')))
})

test('corrupt outbox is renamed to a .corrupt backup, then a clean file is written', () => {
  const directory = freshDir()
  const path = join(directory, 'outbox.json')
  writeFileSync(path, '{broken')
  const { calls, logger } = collectingLogger()

  const outbox = createOutbox({ file: path, logger, send: async () => {} })
  const backups = readdirSync(directory).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(directory, backups[0]), 'utf8'), '{broken')
  assert.ok(calls.some((args) => String(args[0]).includes('corrupt')))
  assert.equal(outbox.persistenceBlocked, false)

  outbox.enqueue({ params: { text: 'after corruption' } })
  outbox.dispose()
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.version, OUTBOX_SCHEMA_VERSION)
  assert.equal(saved.pending.length, 1)
})

test('a missing outbox is not corruption while legacy versionless files still load', () => {
  const directory = freshDir()
  const missingPath = join(directory, 'missing.json')
  const { calls, logger } = collectingLogger()
  const missing = createOutbox({ file: missingPath, logger, send: async () => {} })
  assert.equal(missing.persistenceBlocked, false)
  missing.dispose()
  assert.equal(readdirSync(directory).some((name) => name.includes('.corrupt-')), false)

  const legacyPath = join(directory, 'legacy.json')
  writeFileSync(
    legacyPath,
    JSON.stringify({
      pending: [
        { id: 'legacy-1', call: 'sendMessage', params: { text: 'old' }, createdAt: 1 },
        { nope: true },
      ],
      delivered: [{ key: 'legacy-done', at: 1 }],
    }),
  )
  const legacy = createOutbox({ file: legacyPath, logger, send: async () => {} })
  assert.equal(legacy.persistenceBlocked, false)
  assert.equal(legacy.storedVersion, undefined)
  assert.equal(legacy.snapshot().pending, 1)
  assert.equal(legacy.isDelivered('legacy-done'), true)
  assert.equal(legacy.save(), true)
  legacy.dispose()
  assert.equal(JSON.parse(readFileSync(legacyPath, 'utf8')).version, OUTBOX_SCHEMA_VERSION)
  assert.deepEqual(calls, [])
})

test('outbox file is 0600 and its directory 0700 after a save', () => {
  const directory = join(workspace, 'modes', 'max-notify')
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  chmodSync(directory, 0o755)
  const path = join(directory, 'outbox.json')

  const outbox = createOutbox({ file: path, logger: silent, send: async () => {} })
  assert.equal(outbox.enqueue({ params: { text: 'mode check' } }), true)
  assert.equal(modeOf(path), 0o600)
  assert.equal(modeOf(directory), 0o700)
  assert.deepEqual(readdirSync(directory), ['outbox.json'])
  outbox.dispose()
  assert.equal(modeOf(path), 0o600)
})

test('repeated outbox saves keep the file valid and leave no tmp files', () => {
  const directory = freshDir()
  const path = join(directory, 'outbox.json')
  const outbox = createOutbox({ file: path, now: () => 1_000_000, logger: silent, send: async () => {} })

  for (let index = 0; index < 25; index += 1) {
    assert.equal(outbox.enqueue({ params: { text: `queued-${index}` } }), true)
  }
  assert.equal(outbox.snapshot().pending, 25)
  assert.deepEqual(readdirSync(directory), ['outbox.json'])
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.version, OUTBOX_SCHEMA_VERSION)
  assert.equal(saved.pending.length, 25)
  outbox.dispose()
})
