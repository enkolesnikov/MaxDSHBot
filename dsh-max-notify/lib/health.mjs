/**
 * In-memory health snapshot for `/health`, heartbeat files and monitoring.
 *
 * The snapshot is cheap to read and updated from the polling loop, transports
 * and outbox; a periodic task copies it into durable state.
 *
 * Error strings are redacted at write time (same filter as the log sinks), so a
 * secret that leaked into an exception message never lands in state or /health.
 */
import { redact } from './redact.mjs'

export function createHealth({ version, startedAt = Date.now(), now = () => Date.now() } = {}) {
  const health = {
    version,
    startedAt,
    lastPollAt: undefined,
    lastUpdateAt: undefined,
    lastSendAt: undefined,
    lastError: undefined,
    lastErrorAt: undefined,
    pollStopped: false,
    pollStoppedReason: undefined,
    pollFailures: 0,
  }

  function update(patch) {
    if (!patch || typeof patch !== 'object') return
    const safe = {}
    for (const [key, value] of Object.entries(patch)) safe[key] = typeof value === 'string' ? redact(value) : value
    Object.assign(health, safe)
  }

  function fail(error, { stopped = false, reason } = {}) {
    health.lastError = redact(error?.message || String(error))
    health.lastErrorAt = now()
    health.pollFailures += 1
    if (stopped) {
      health.pollStopped = true
      health.pollStoppedReason = reason === undefined ? health.lastError : redact(String(reason))
    }
  }

  function snapshot(extra = {}) {
    return {
      ...health,
      uptimeMs: Math.max(0, now() - health.startedAt),
      ...extra,
    }
  }

  return { update, fail, snapshot, get startedAt() { return health.startedAt } }
}
