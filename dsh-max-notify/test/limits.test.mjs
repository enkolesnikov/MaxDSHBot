import test from 'node:test'
import assert from 'node:assert/strict'
import { PRIORITY, createLimiter } from '../lib/limits.mjs'

const silent = { warn() {}, debug() {}, info() {} }
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

function makeLimiter(overrides = {}) {
  let time = 1_000_000
  const now = () => time
  const limiter = createLimiter({
    perChatPerSecond: 2,
    globalPerSecond: 100,
    now,
    logger: silent,
    ...overrides,
  })
  return {
    limiter,
    advance(ms) {
      time += ms
    },
    pump: () => limiter.pump()._pump?.(),
  }
}

test('two requests per chat pass immediately, the third waits for a refill', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 2, globalPerSecond: 100, now: () => time, logger: silent })

  await limiter.acquire('chat-1')
  await limiter.acquire('chat-1')
  let thirdResolved = false
  const third = limiter.acquire('chat-1').then(() => {
    thirdResolved = true
  })
  await tick()
  assert.equal(thirdResolved, false)
  assert.equal(limiter.snapshot().queueDepth, 1)

  time += 500
  limiter.pump()
  await third
  assert.equal(limiter.snapshot().waits, 1)
  assert.ok(limiter.snapshot().totalWaitMs >= 0)
})

test('different chats use independent buckets', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 2, globalPerSecond: 100, now: () => time, logger: silent })
  await limiter.acquire('chat-a')
  await limiter.acquire('chat-a')
  await limiter.acquire('chat-b')
  await limiter.acquire('chat-b')
  assert.equal(limiter.snapshot().queueDepth, 0)
})

test('global bucket limits all chats together', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 100, globalPerSecond: 2, now: () => time, logger: silent })
  await limiter.acquire('a')
  await limiter.acquire('b')
  let resolved = false
  const third = limiter.acquire('c').then(() => {
    resolved = true
  })
  await tick()
  assert.equal(resolved, false)
  time += 500
  limiter.pump()
  await third
})

test('critical requests jump the queue', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 2, globalPerSecond: 2, now: () => time, logger: silent })
  await limiter.acquire('a')
  await limiter.acquire('a')
  const order = []
  const normal1 = limiter.acquire('a').then(() => order.push('normal1'))
  const normal2 = limiter.acquire('a').then(() => order.push('normal2'))
  const critical = limiter.acquire('a', PRIORITY.critical).then(() => order.push('critical'))
  time += 500
  limiter.pump()
  await critical
  time += 500
  limiter.pump()
  time += 500
  limiter.pump()
  await Promise.all([normal1, normal2])
  assert.equal(order[0], 'critical')
  limiter.stop()
})

test('stop rejects queued waiters', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 2, globalPerSecond: 100, now: () => time, logger: silent })
  await limiter.acquire('chat')
  await limiter.acquire('chat')
  const queued = limiter.acquire('chat')
  limiter.stop()
  await assert.rejects(queued, /disposed/)
  assert.equal(limiter.snapshot().rejected, 1)
})

test('a null chat key only uses the global bucket', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 2, globalPerSecond: 100, now: () => time, logger: silent })
  for (let index = 0; index < 10; index += 1) await limiter.acquire(null)
  assert.equal(limiter.snapshot().queueDepth, 0)
})
