import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHealth } from '../lib/health.mjs'
import { createAudit } from '../lib/audit.mjs'
import { registerSecret, clearSecrets } from '../lib/redact.mjs'

afterEach(() => clearSecrets())

test('health.fail redacts a registered secret before storing the error', () => {
  const secret = '0123456789abcdef0123456789abcdef'
  assert.equal(registerSecret(secret), true)
  try {
    const health = createHealth({ version: 'test' })
    // Brackets keep the 32-char value out of the generic 40+ token rule: only
    // the explicit registration can mask it here.
    health.fail(new Error(`cannot reach endpoint [${secret}]`))
    const snapshot = health.snapshot()
    assert.equal(snapshot.lastError.includes(secret), false)
    assert.match(snapshot.lastError, /<redacted>/)
    assert.equal(snapshot.pollFailures, 1)

    health.fail(new Error('network down'), { stopped: true, reason: `policy=[${secret}]` })
    const stopped = health.snapshot()
    assert.equal(stopped.pollStopped, true)
    assert.equal(stopped.pollStoppedReason.includes(secret), false)
    assert.match(stopped.pollStoppedReason, /<redacted>/)
  } finally {
    clearSecrets()
  }
})

test('resetPollState clears the stopped marker and the streak but keeps totals and the last error', () => {
  let time = 5_000
  const health = createHealth({ version: 'test', startedAt: 1_000, now: () => time })
  health.fail(new Error('network down'))
  time = 6_500
  health.fail(new Error('unauthorized'), { stopped: true, reason: 'unauthorized (401)' })

  const failed = health.snapshot()
  assert.equal(failed.pollStopped, true)
  assert.equal(failed.pollFailures, 2)
  assert.equal(failed.pollFailuresTotal, 2)
  assert.equal(failed.lastError, 'unauthorized')
  assert.equal(failed.lastErrorAgeMs, 0)

  time = 60_000
  assert.equal(health.snapshot().lastErrorAgeMs, 53_500)

  health.resetPollState()
  const reset = health.snapshot()
  assert.equal(reset.pollStopped, false)
  assert.equal(reset.pollStoppedReason, undefined)
  // The current streak is gone, the lifetime total and the diagnostic error stay.
  assert.equal(reset.pollFailures, 0)
  assert.equal(reset.pollFailuresTotal, 2)
  assert.equal(reset.lastError, 'unauthorized')
  assert.equal(reset.lastErrorAgeMs, 53_500)

  // Counting restarts from zero after a reset but keeps accumulating totals.
  health.fail(new Error('timeout'))
  assert.equal(health.snapshot().pollFailures, 1)
  assert.equal(health.snapshot().pollFailuresTotal, 3)
})

test('health.update redacts string patches on write', () => {
  const secret = 'voice-api-key-0123456789abcdef'
  registerSecret(secret)
  try {
    const health = createHealth({ version: 'test' })
    health.update({ webhookSubscriptionError: `subscribe failed for [${secret}]` })
    assert.equal(health.snapshot().webhookSubscriptionError.includes(secret), false)
    assert.match(health.snapshot().webhookSubscriptionError, /<redacted>/)
  } finally {
    clearSecrets()
  }
})

// A secret without a secret-like context word: only registration can mask it,
// so a deep-redaction pass is the only thing that can hide it in nested data.
const NESTED_SECRET = 'Q7w9E2r5T8y1U4i6O3p0A5s8D1f4G7h9'

test('health.update deep-redacts strings nested in objects and arrays', () => {
  registerSecret(NESTED_SECRET)
  const health = createHealth({ version: 'test' })
  health.update({
    webhook: { subscriptionError: `subscribe failed [${NESTED_SECRET}]` },
    events: [`saw [${NESTED_SECRET}]`],
    nested: { deep: [{ at: 1, note: `[${NESTED_SECRET}]` }] },
  })
  const snapshot = health.snapshot()
  assert.equal(snapshot.webhook.subscriptionError.includes(NESTED_SECRET), false)
  assert.match(snapshot.webhook.subscriptionError, /<redacted>/)
  assert.equal(snapshot.events[0].includes(NESTED_SECRET), false)
  assert.equal(snapshot.nested.deep[0].note.includes(NESTED_SECRET), false)
  // Non-string values keep their type/value.
  assert.equal(snapshot.nested.deep[0].at, 1)
})

test('health.snapshot deep-redacts nested `extra` and does not mutate it', () => {
  registerSecret(NESTED_SECRET)
  const health = createHealth({ version: 'test' })
  const extra = {
    outbox: { sent: 3, lastError: `send failed [${NESTED_SECRET}]` },
    limiter: { note: [`[${NESTED_SECRET}]`] },
  }
  const snapshot = health.snapshot(extra)
  assert.equal(snapshot.outbox.lastError.includes(NESTED_SECRET), false)
  assert.match(snapshot.outbox.lastError, /<redacted>/)
  assert.equal(snapshot.limiter.note[0].includes(NESTED_SECRET), false)
  assert.equal(snapshot.outbox.sent, 3)
  // Deep redaction copies: the caller's object is untouched.
  assert.equal(extra.outbox.lastError.includes(NESTED_SECRET), true)
})

test('audit deep-redacts dead-letter update and error payloads', () => {
  registerSecret(NESTED_SECRET)
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-max-audit-redact-')), 'audit.jsonl')
  const audit = createAudit({ file, logger: { warn() {} } })
  audit.write({
    kind: 'webhook',
    action: 'dead-letter',
    attempts: 3,
    error: `cannot process update with [${NESTED_SECRET}]`,
    update: {
      update_type: 'message_created',
      message: { body: { text: `hi [${NESTED_SECRET}]` } },
      nested: [{ token: NESTED_SECRET }],
    },
  })
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes(NESTED_SECRET), false)
  assert.match(raw, /<redacted>/)
  const line = JSON.parse(raw.trim())
  assert.equal(line.kind, 'webhook')
  assert.equal(line.action, 'dead-letter')
  assert.equal(line.attempts, 3)
  assert.equal(line.update.update_type, 'message_created')
  assert.equal(line.update.message.body.text.includes(NESTED_SECRET), false)
  assert.equal(line.update.nested[0].token, '<redacted>')
  assert.equal(line.error.includes(NESTED_SECRET), false)
})

test('audit rotates an oversized file to <file>.1 before appending', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-max-audit-rotate-'))
  const file = join(directory, 'audit.jsonl')
  const oversized = 'x'.repeat(5 * 1024 * 1024 + 16)
  writeFileSync(file, oversized)

  const audit = createAudit({ file, logger: { warn() {} } })
  audit.approve({ tool: 'bash', outcome: 'allowed-once' })
  assert.equal(readFileSync(`${file}.1`, 'utf8'), oversized)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).kind, 'approval')
  assert.equal((statSync(file).mode & 0o777).toString(8), '600')

  // A small file is not rotated again; the single `.1` generation stays.
  audit.command({ command: 'status' })
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2)
  assert.equal(readFileSync(`${file}.1`, 'utf8'), oversized)
})
