import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutbox, resolveOutboxFile } from '../lib/outbox.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-outbox-'))
let fileCounter = 0
const freshFile = () => join(workspace, `outbox-${++fileCounter}.json`)

const silent = { warn() {}, debug() {}, info() {} }

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
