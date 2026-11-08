import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHealth } from '../lib/health.mjs'
import { createAudit, resolveAuditFile } from '../lib/audit.mjs'

test('health snapshot tracks uptime, polls and failures', () => {
  let time = 1000
  const health = createHealth({ version: '0.6.0', startedAt: 1000, now: () => time })
  health.update({ lastPollAt: 2000 })
  assert.equal(health.snapshot().lastPollAt, 2000)
  time = 61_000
  assert.equal(health.snapshot().uptimeMs, 60_000)

  health.fail(new Error('network down'))
  assert.equal(health.snapshot().lastError, 'network down')
  assert.equal(health.snapshot().pollFailures, 1)
  assert.equal(health.snapshot().pollStopped, false)

  health.fail(new Error('unauthorized'), { stopped: true, reason: 'unauthorized (401)' })
  assert.equal(health.snapshot().pollStopped, true)
  assert.equal(health.snapshot().pollStoppedReason, 'unauthorized (401)')
  assert.equal(health.snapshot().pollFailures, 2)
})

test('resolveAuditFile defaults to DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home'
  try {
    assert.equal(resolveAuditFile({}), join('/tmp/dsh-home', 'max-notify', 'audit.jsonl'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('audit appends metadata-only JSONL with 0600 permissions', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-max-audit-')), 'audit.jsonl')
  const audit = createAudit({ file, logger: { warn() {} } })
  audit.approve({ tool: 'bash', outcome: 'allowed-once', source: 'max' })
  audit.question({ questionId: 'q1', outcome: 'answered' })
  audit.command({ command: 'status' })
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 3)
  assert.equal(lines[0].kind, 'approval')
  assert.equal(lines[1].kind, 'question')
  assert.equal(lines[2].kind, 'command')
  assert.equal((statSync(file).mode & 0o777).toString(8), '600')
})

test('audit disabled writes nothing', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-max-audit-off-')), 'audit.jsonl')
  const audit = createAudit({ file, enabled: false })
  audit.approve({ tool: 'bash' })
  assert.throws(() => readFileSync(file, 'utf8'))
})
