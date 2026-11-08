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
 */
export const PRIORITY = Object.freeze({ normal: 0, critical: 10 })

export function createLimiter({
  perChatPerSecond = 2,
  globalPerSecond = 30,
  now = () => Date.now(),
  logger,
} = {}) {
  const chatCapacity = Math.max(1, perChatPerSecond)
  const globalCapacity = Math.max(1, globalPerSecond)
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

  function bucketFor(chatKey) {
    let bucket = chatBuckets.get(chatKey)
    if (!bucket) {
      bucket = { tokens: chatCapacity, last: now() }
      chatBuckets.set(chatKey, bucket)
      if (chatBuckets.size > 500) {
        // Bound memory on long-lived processes with many chats.
        const oldest = chatBuckets.keys().next().value
        if (oldest !== undefined) chatBuckets.delete(oldest)
      }
    }
    return bucket
  }

  function refill(bucket, rate, capacity, at) {
    const elapsedMs = at - bucket.last
    if (elapsedMs <= 0) return
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * rate)
    bucket.last = at
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

  /** Milliseconds until both buckets allow one request for this key. */
  function waitFor(chatKey, at) {
    let waitMs = 0
    if (globalBucket.tokens < 1) {
      waitMs = Math.max(waitMs, ((1 - globalBucket.tokens) / globalCapacity) * 1000)
    }
    if (chatKey !== null && chatKey !== undefined) {
      const bucket = bucketFor(chatKey)
      if (bucket.tokens < 1) {
        waitMs = Math.max(waitMs, ((1 - bucket.tokens) / chatCapacity) * 1000)
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
      if (queue.length > 0 && !timer && !stopped) {
        let waitMs = 1000
        for (const item of queue) waitMs = Math.min(waitMs, waitFor(item.chatKey, now()))
        timer = setTimeout(() => {
          timer = undefined
          pump()
        }, Math.max(5, waitMs))
        timer.unref?.()
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
      perChatPerSecond: chatCapacity,
      globalPerSecond: globalCapacity,
      stopped,
    }
  }

  return { acquire, stop, snapshot, pump }
}
