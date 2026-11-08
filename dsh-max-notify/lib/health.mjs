/**
 * In-memory health snapshot for `/health`, heartbeat files and monitoring.
 *
 * The snapshot is cheap to read and updated from the polling loop, transports
 * and outbox; a periodic task copies it into durable state.
 */
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
    Object.assign(health, patch)
  }

  function fail(error, { stopped = false, reason } = {}) {
    health.lastError = error?.message || String(error)
    health.lastErrorAt = now()
    health.pollFailures += 1
    if (stopped) {
      health.pollStopped = true
      health.pollStoppedReason = reason ?? health.lastError
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
