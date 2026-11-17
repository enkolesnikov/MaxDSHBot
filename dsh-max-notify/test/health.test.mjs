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
