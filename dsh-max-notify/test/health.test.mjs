import test from 'node:test'
import assert from 'node:assert/strict'
import { createHealth } from '../lib/health.mjs'
import { registerSecret, clearSecrets } from '../lib/redact.mjs'

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
