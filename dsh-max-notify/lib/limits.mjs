/**
 * Global outbound scheduler for MAX API requests.
 *
 * MAX allows ~2 messages/second per chat and ~30 requests/second overall. Every
 * request goes through two token buckets; approvals/questions/errors use a
 * higher priority lane so they are not delayed behind notification bursts.
 *
 * The scheduler is transport-agnostic: `acquire(chatKey, priority)` resolves
 * when the caller may issue the request. A missing/`null` chat key means the
 * request is only counted against the global bucket (e.g. media uploads or
 * message edits where the chat is not known at the call site).
 *
 * Timers: while the queue is non-empty the refill timer is deliberately kept
 * referenced. An unref'd timer would let Node exit with `acquire()` promises
 * still pending (unsettled top-level await), so a pending outbound request could
 * silently never resolve. `stop()` rejects every waiter and clears the timer.
 *
 * Chat buckets: bounded by `maxChatBuckets` (default 500) with least-recently-
 * used eviction - a chat that is actively sending is kept, an idle one is
 * dropped. `waitFor()` never creates or refills buckets; it is a pure estimate.
 */
export const PRIORITY = Object.freeze({ normal: 0, critical: 10 })
export const DEFAULT_MAX_CHAT_BUCKETS = 500

export function createLimiter({
  perChatPerSecond = 2,
  globalPerSecond = 30,
  maxChatBuckets = DEFAULT_MAX_CHAT_BUCKETS,
  now = () => Date.now(),
  logger,
} = {}) {
  const chatCapacity = Math.max(1, perChatPerSecond)
  const globalCapacity = Math.max(1, globalPerSecond)
  const bucketLimit = Number.isFinite(Number(maxChatBuckets)) && Number(maxChatBuckets) >= 1
    ? Math.floor(Number(maxChatBuckets))
    : DEFAULT_MAX_CHAT_BUCKETS
  /** Map iteration order is the LRU order: first entry = least recently used. */
  const chatBuckets = new Map()
  const globalBucket = { tokens: globalCapacity, last: now() }
  /** @type {Array<{chatKey: string|null, priority: number, enqueuedAt: number, resolve: Function}>} */
  const queue = []
  let timer
  let draining = false
  let stopped = false
  const stats = {
    acquired: 0,
    queued: 0,
    waits: 0,
    totalWaitMs: 0,
    maxQueue: 0,
    rejected: 0,
  }

  function touchBucket(chatKey, bucket) {
    // Re-insert to move the entry to the most-recently-used end of the Map.
    chatBuckets.delete(chatKey)
    chatBuckets.set(chatKey, bucket)
  }

  function bucketFor(chatKey) {
    const existing = chatBuckets.get(chatKey)
    if (existing) {
      touchBucket(chatKey, existing)
      return existing
    }
    const bucket = { tokens: chatCapacity, last: now() }
    chatBuckets.set(chatKey, bucket)
    // Bound memory on long-lived processes: drop the least recently used chat.
    while (chatBuckets.size > bucketLimit) {
      const oldest = chatBuckets.keys().next().value
      if (oldest === undefined) break
      chatBuckets.delete(oldest)
    }
    return bucket
  }

  function refill(bucket, rate, capacity, at) {
    const elapsedMs = at - bucket.last
    if (elapsedMs <= 0) return
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * rate)
    bucket.last = at
  }

  /** Token count at `at` without mutating the bucket (used by read-only waitFor). */
  function projectedTokens(bucket, capacity, at) {
    const elapsedMs = Math.max(0, at - bucket.last)
    if (elapsedMs === 0) return bucket.tokens
    return Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * capacity)
  }

  function available(chatKey, at) {
    refill(globalBucket, globalCapacity, globalCapacity, at)
    if (globalBucket.tokens < 1) return false
    if (chatKey === null || chatKey === undefined) return true
    const bucket = bucketFor(chatKey)
    refill(bucket, chatCapacity, chatCapacity, at)
    return bucket.tokens >= 1
  }

  function consume(chatKey, at) {
    refill(globalBucket, globalCapacity, globalCapacity, at)
    globalBucket.tokens -= 1
    if (chatKey !== null && chatKey !== undefined) {
      const bucket = bucketFor(chatKey)
      refill(bucket, chatCapacity, chatCapacity, at)
      bucket.tokens -= 1
    }
  }

  /**
   * Milliseconds until both buckets would allow one request for this key.
   * Read-only: it never creates, refills or reorders buckets, so callers
   * (metrics, tests) may probe freely without affecting scheduling.
   */
  function waitFor(chatKey, at = now()) {
    let waitMs = 0
    const globalTokens = projectedTokens(globalBucket, globalCapacity, at)
    if (globalTokens < 1) {
      waitMs = Math.max(waitMs, ((1 - globalTokens) / globalCapacity) * 1000)
    }
    if (chatKey !== null && chatKey !== undefined) {
      // A missing bucket means a fresh one would be created full of tokens.
      const bucket = chatBuckets.get(String(chatKey))
      const tokens = bucket ? projectedTokens(bucket, chatCapacity, at) : chatCapacity
      if (tokens < 1) {
        waitMs = Math.max(waitMs, ((1 - tokens) / chatCapacity) * 1000)
      }
    }
    return Math.max(0, Math.ceil(waitMs))
  }

  function pump() {
    if (draining || stopped) return
    draining = true
    try {
      while (queue.length > 0) {
        // Critical requests first; within a lane FIFO by enqueue time.
        queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)
        const at = now()
        let picked = -1
        for (let index = 0; index < queue.length; index += 1) {
          if (available(queue[index].chatKey, at)) {
            picked = index
            break
          }
        }
        if (picked === -1) break
        const [item] = queue.splice(picked, 1)
        const waitMs = Math.max(0, at - item.enqueuedAt)
        stats.acquired += 1
        stats.totalWaitMs += waitMs
        consume(item.chatKey, at)
        item.resolve()
      }
      if (queue.length === 0) {
        // Nothing left to wait for: drop a previously scheduled refill timer so
        // an idle limiter does not keep the event loop alive.
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        return
      }
      if (!timer && !stopped) {
        let waitMs = 1000
        for (const item of queue) waitMs = Math.min(waitMs, waitFor(item.chatKey, now()))
        timer = setTimeout(() => {
          timer = undefined
          pump()
        }, Math.max(5, waitMs))
        // Kept referenced on purpose: an unref'd timer lets Node exit with
        // queued `acquire()` promises still unresolved.
      }
    } finally {
      draining = false
    }
  }

  /**
   * Wait until one request may be issued.
   * @param {string|null} [chatKey]
   * @param {number} [priority] - `PRIORITY.critical` jumps the queue.
   * @returns {Promise<void>}
   */
  function acquire(chatKey = null, priority = PRIORITY.normal) {
    if (stopped) return Promise.reject(new Error('MAX limiter is disposed'))
    const key = chatKey === undefined || chatKey === null ? null : String(chatKey)
    const at = now()
    if (available(key, at)) {
      stats.acquired += 1
      consume(key, at)
      return Promise.resolve()
    }
    stats.queued += 1
    stats.waits += 1
    stats.maxQueue = Math.max(stats.maxQueue, queue.length + 1)
    return new Promise((resolve, reject) => {
      queue.push({
        chatKey: key,
        priority: Number(priority) || 0,
        enqueuedAt: now(),
        resolve: () => resolve(),
        reject,
      })
      pump()
    })
  }

  function stop() {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    while (queue.length > 0) {
      const item = queue.shift()
      stats.rejected += 1
      item.reject?.(new Error('MAX limiter is disposed'))
    }
  }

  function snapshot() {
    return {
      ...stats,
      queueDepth: queue.length,
      chatBuckets: chatBuckets.size,
      maxChatBuckets: bucketLimit,
      perChatPerSecond: chatCapacity,
      globalPerSecond: globalCapacity,
      stopped,
    }
  }

  return { acquire, stop, snapshot, pump, waitFor }
}
