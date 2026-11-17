/**
 * In-memory health snapshot for `/health`, heartbeat files and monitoring.
 *
 * The snapshot is cheap to read and updated from the polling loop, transports
 * and outbox; a periodic task copies it into durable state.
 *
 * Failure accounting keeps two counters apart:
 *  - `pollFailures` is the *current* consecutive-failure streak and is reset by
 *    a successful poll (`resetPollState`), so `/health` can never claim
 *    "polling stopped" while the poller is actually working again;
 *  - `pollFailuresTotal` is the process-lifetime total and is never reset.
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
    /** Consecutive failures since the last successful poll (current streak). */
    pollFailures: 0,
    /** Lifetime failures; survives `resetPollState()` (separate from the streak). */
    pollFailuresTotal: 0,
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
    health.pollFailuresTotal += 1
    if (stopped) {
      health.pollStopped = true
      health.pollStoppedReason = reason === undefined ? health.lastError : redact(String(reason))
    }
  }

  /**
   * A successful poll proves the poller works: clear the stopped marker, its
   * reason and the current failure streak. `lastError`/`lastErrorAt` stay for
   * diagnostics and lifetime totals are untouched.
   */
  function resetPollState() {
    health.pollStopped = false
    health.pollStoppedReason = undefined
    health.pollFailures = 0
  }

  function snapshot(extra = {}) {
    return {
      ...health,
      uptimeMs: Math.max(0, now() - health.startedAt),
      lastErrorAgeMs: health.lastErrorAt === undefined ? undefined : Math.max(0, now() - health.lastErrorAt),
      ...extra,
    }
  }

  return { update, fail, resetPollState, snapshot, get startedAt() { return health.startedAt } }
}
