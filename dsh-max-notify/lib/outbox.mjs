/**
 * Durable outbound queue for MAX messages.
 *
 * MAX outages, restarts and HMR must not lose agent replies or notifications.
 * Every item is persisted under `$DSH_HOME/max-notify/outbox.json`, retried with
 * exponential backoff, and de-duplicated by a business key (`dedupeKey`) so a
 * replay after a crash cannot double-send the same final answer.
 *
 * The queue owns a bounded delivery history (`delivered`) used for idempotency
 * checks; it is pruned by TTL and size.
 *
 * Durability contract: every write is atomic (unique 0600 tmp file in a 0700
 * directory → fsync → rename → directory fsync). A newer file `version` written
 * by a future release is never interpreted or overwritten: it is backed up to
 * `<file>.future-<ts>` and persistence stays disabled until the plugin is
 * upgraded, so a downgrade cannot destroy queued messages.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const OUTBOX_SCHEMA_VERSION = 1
const RETRY_BASE_MS = 5000
const RETRY_MAX_MS = 5 * 60 * 1000
const DELIVERED_LIMIT = 500

/** Parse a stored version marker; `undefined` means a legacy file without one. */
function storedVersionOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  const version = Number(value)
  return Number.isFinite(version) ? version : undefined
}

/**
 * Best-effort fsync of a directory so the preceding rename is durable after a
 * crash. Opening a directory read-only works on POSIX; platforms that refuse it
 * are ignored — the data file itself has already been fsynced.
 */
function fsyncDirectory(directory) {
  let fd
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // directory fsync is not portable; the file fsync is the hard guarantee
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Crash-safe atomic write with private permissions: unique tmp file next to the
 * target, fsync of the file, rename over the target, fsync of the directory.
 * Throws on failure so callers can log and keep delivering.
 */
function writeFileAtomic(path, contents) {
  const directory = dirname(path)
  // Queued messages may contain private chat text: keep the directory 0700 even
  // when an older release or a permissive umask created it with broader bits.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch {
    // best effort (some filesystems do not support chmod)
  }
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd
  try {
    fd = openSync(tmp, 'w', 0o600)
    chmodSync(tmp, 0o600)
    writeFileSync(fd, contents)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // the tmp file may not exist
    }
    throw error
  }
  fsyncDirectory(directory)
}

/** Resolve the outbox file: explicit config path, or `$DSH_HOME/max-notify/outbox.json`. */
export function resolveOutboxFile(config = {}) {
  if (typeof config.outboxFile === 'string' && config.outboxFile.trim() !== '') return config.outboxFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'outbox.json')
}

function defaultFile(config = {}) {
  return resolveOutboxFile(config)
}

/** Merge a loaded outbox document into the in-memory queues (v1 compatible). */
function applyLoadedOutbox(pending, delivered, parsed) {
  if (Array.isArray(parsed.pending)) {
    for (const item of parsed.pending) {
      if (item && typeof item.id === 'string' && typeof item.call === 'string') pending.push(item)
    }
  }
  if (Array.isArray(parsed.delivered)) {
    for (const entry of parsed.delivered) {
      if (entry && typeof entry.key === 'string') delivered.push(entry)
    }
  }
}

/**
 * @param {object} options
 * @param {string} [options.file]
 * @param {number} [options.maxItems] - pending cap; lowest-priority oldest items are dropped.
 * @param {number} [options.ttlHours] - pending and delivered retention.
 * @param {number} [options.intervalMs] - background flush cadence.
 * @param {(call: string, params: object) => Promise<unknown>} options.send - executes one item.
 * @param {() => number} [options.now]
 * @param {object} [options.logger]
 */
export function createOutbox({
  file,
  maxItems = 200,
  ttlHours = 48,
  intervalMs = 15000,
  send,
  now = () => Date.now(),
  logger,
} = {}) {
  const path = file ?? defaultFile()
  const pending = []
  const delivered = []
  let timer
  let flushing = false
  let disposed = false
  const stats = { sent: 0, failed: 0, dropped: 0, enqueued: 0, lastError: undefined, lastSentAt: undefined }

  let storedVersion
  let persistenceBlocked = false
  let blockedSaveWarned = false
  let loaded

  try {
    loaded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Corrupt JSON only: keep the broken file for post-mortem, then start empty.
      logger?.warn?.('MAX outbox file %s is corrupt; starting empty (%s)', path, error?.message || String(error))
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`)
      } catch {
        // keep the original if it cannot be moved
      }
    } else if (error?.code !== 'ENOENT') {
      // A permission/IO error is not corruption: never rename an unreadable file.
      logger?.warn?.('cannot read MAX outbox file %s: %s', path, error?.message || String(error))
    }
  }

  if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
    storedVersion = storedVersionOf(loaded.version)
    if (storedVersion !== undefined && storedVersion > OUTBOX_SCHEMA_VERSION) {
      // A future release owns this file: preserve it byte-for-byte and disable
      // persistence instead of silently downgrading/overwriting its queue.
      persistenceBlocked = true
      logger?.warn?.(
        'MAX outbox file %s uses version %d but this plugin supports %d; preserving the file, starting empty and disabling persistence until the plugin is upgraded',
        path,
        storedVersion,
        OUTBOX_SCHEMA_VERSION,
      )
      try {
        const backup = `${path}.future-${Date.now()}`
        copyFileSync(path, backup)
        try {
          chmodSync(backup, 0o600)
        } catch {
          // best effort
        }
      } catch (error) {
        logger?.warn?.('cannot back up newer MAX outbox file %s: %s', path, error?.message || String(error))
      }
    } else {
      applyLoadedOutbox(pending, delivered, loaded)
    }
  }

  function save() {
    if (persistenceBlocked) {
      if (!blockedSaveWarned) {
        blockedSaveWarned = true
        logger?.warn?.(
          'refusing to overwrite MAX outbox file %s written by a newer version (stored %d, supported %d); persistence stays disabled',
          path,
          storedVersion,
          OUTBOX_SCHEMA_VERSION,
        )
      }
      return false
    }
    try {
      writeFileAtomic(path, `${JSON.stringify({ version: OUTBOX_SCHEMA_VERSION, pending, delivered }, null, 2)}\n`)
      return true
    } catch (error) {
      logger?.warn?.('cannot persist MAX outbox to %s: %s', path, error?.message || String(error))
      return false
    }
  }

  function prune() {
    const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000
    const cutoff = now() - ttlMs
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].createdAt < cutoff) {
        pending.splice(index, 1)
        stats.dropped += 1
      }
    }
    for (let index = delivered.length - 1; index >= 0; index -= 1) {
      if (delivered[index].at < cutoff) delivered.splice(index, 1)
    }
    while (delivered.length > DELIVERED_LIMIT) delivered.shift()
    // Cap pending: drop the lowest-priority oldest entries first.
    if (pending.length > maxItems) {
      pending.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt)
      while (pending.length > maxItems) {
        pending.pop()
        stats.dropped += 1
      }
    }
  }

  function isDelivered(dedupeKey) {
    if (!dedupeKey) return false
    return delivered.some((entry) => entry.key === dedupeKey)
  }

  function isPending(dedupeKey) {
    if (!dedupeKey) return false
    return pending.some((item) => item.dedupeKey === dedupeKey)
  }

  /**
   * Add one message to the queue.
   * @param {{dedupeKey?: string, call?: string, params: object, priority?: number, kind?: string}} item
   * @returns {boolean} false when dropped as a duplicate/expired item.
   */
  function enqueue(item) {
    if (disposed || !item || !item.params) return false
    const dedupeKey = item.dedupeKey
    if (dedupeKey && (isDelivered(dedupeKey) || isPending(dedupeKey))) return false
    pending.push({
      id: randomUUID(),
      dedupeKey,
      kind: item.kind ?? 'message',
      priority: Number(item.priority) || 0,
      call: item.call ?? 'sendMessage',
      params: item.params,
      createdAt: now(),
      attempts: 0,
      nextAt: now(),
      lastError: undefined,
    })
    stats.enqueued += 1
    prune()
    save()
    return true
  }

  async function runItem(item) {
    if (item.dedupeKey && isDelivered(item.dedupeKey)) {
      const index = pending.indexOf(item)
      if (index >= 0) pending.splice(index, 1)
      return true
    }
    try {
      await send(item.call, item.params)
      stats.sent += 1
      stats.lastSentAt = now()
      if (item.dedupeKey) delivered.push({ key: item.dedupeKey, at: now() })
      const index = pending.indexOf(item)
      if (index >= 0) pending.splice(index, 1)
      return true
    } catch (error) {
      stats.failed += 1
      stats.lastError = error?.message || String(error)
      item.attempts = (item.attempts ?? 0) + 1
      item.lastError = stats.lastError
      item.nextAt = now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (item.attempts - 1))
      logger?.debug?.('MAX outbox retry %d for %s in %d ms: %s', item.attempts, item.kind, item.nextAt - now(), item.lastError)
      return false
    }
  }

  /** Attempt all due items once (sequential, priority order). */
  async function flush(limit = 20) {
    if (flushing || disposed) return { attempted: 0, sent: 0, failed: 0 }
    flushing = true
    let attempted = 0
    let sent = 0
    let failed = 0
    try {
      prune()
      const due = pending
        .filter((item) => item.nextAt <= now())
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt)
        .slice(0, limit)
      for (const item of due) {
        attempted += 1
        if (await runItem(item)) sent += 1
        else failed += 1
      }
      if (attempted > 0) save()
    } finally {
      flushing = false
    }
    return { attempted, sent, failed }
  }

  /** Deliver a message now; persist it only when the direct attempt fails. */
  async function deliverNow(params, { dedupeKey, call = 'sendMessage', priority = 0, kind = 'message' } = {}) {
    if (dedupeKey && (isDelivered(dedupeKey) || isPending(dedupeKey))) return { skipped: true }
    try {
      const response = await send(call, params)
      stats.sent += 1
      stats.lastSentAt = now()
      if (dedupeKey) {
        delivered.push({ key: dedupeKey, at: now() })
        while (delivered.length > DELIVERED_LIMIT) delivered.shift()
        save()
      }
      return { sent: true, response, mid: response?.message?.body?.mid }
    } catch (error) {
      const queued = enqueue({ dedupeKey, call, params, priority, kind })
      return { queued, error: error?.message || String(error) }
    }
  }

  function start() {
    if (timer || disposed) return
    timer = setInterval(() => {
      void flush().catch((error) => logger?.warn?.('outbox flush failed: %s', error?.message || String(error)))
    }, intervalMs)
    timer.unref?.()
    void flush().catch(() => {})
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  function dispose() {
    disposed = true
    stop()
    save()
  }

  function snapshot() {
    return {
      pending: pending.length,
      delivered: delivered.length,
      oldestPendingAt: pending.length > 0 ? Math.min(...pending.map((item) => item.createdAt)) : undefined,
      lastError: stats.lastError,
      lastSentAt: stats.lastSentAt,
      sent: stats.sent,
      failed: stats.failed,
      dropped: stats.dropped,
      enqueued: stats.enqueued,
    }
  }

  return {
    enqueue,
    flush,
    deliverNow,
    start,
    stop,
    dispose,
    save,
    prune,
    isDelivered,
    isPending,
    snapshot,
    /** Version found on disk (`undefined` for legacy files without a marker). */
    get storedVersion() {
      return storedVersion
    },
    /** True when the file belongs to a newer release and must not be written. */
    get persistenceBlocked() {
      return persistenceBlocked
    },
    get pending() {
      return pending.length
    },
  }
}
