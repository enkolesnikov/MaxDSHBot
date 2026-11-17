import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

// ---------------------------------------------------------------------------
// P2: queue timer must keep the process alive while waiters are pending
// ---------------------------------------------------------------------------

test('the refill timer stays referenced so a queued acquire resolves instead of the process exiting', () => {
  // The child uses a frozen clock, so only the limiter's own refill timer can
  // keep the event loop alive: a 20ms unref'd timer advances the clock and
  // pumps. With an unref'd refill timer Node would exit first (unsettled
  // top-level await, code 13) and never print "resolved".
  const limitsUrl = new URL('../lib/limits.mjs', import.meta.url).href
  const script = `
    const { createLimiter } = await import(${JSON.stringify(limitsUrl)})
    let time = 1_000_000
    const limiter = createLimiter({ perChatPerSecond: 2, globalPerSecond: 100, now: () => time })
    await limiter.acquire('chat')
    await limiter.acquire('chat')
    const pending = limiter.acquire('chat')
    setTimeout(() => {
      time += 1000
      limiter.pump()
    }, 20).unref()
    await pending
    limiter.stop()
    console.log('resolved')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, `limiter child exited with ${result.status}: ${result.stderr}`)
  assert.match(result.stdout, /resolved/)
})

// ---------------------------------------------------------------------------
// P2: LRU eviction of chat buckets
// ---------------------------------------------------------------------------

test('chat buckets are evicted least-recently-used, not first-in-first-out', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 1, globalPerSecond: 100_000, maxChatBuckets: 2, now: () => time, logger: silent })

  await limiter.acquire('a') // a: empty bucket
  await limiter.acquire('b') // b: empty bucket
  assert.equal(limiter.snapshot().chatBuckets, 2)
  assert.equal(limiter.snapshot().maxChatBuckets, 2)

  time += 1000
  await limiter.acquire('a') // refills a and makes it the most recently used
  await limiter.acquire('c') // a new bucket must evict b (LRU), not a (FIFO would evict a)
  assert.equal(limiter.snapshot().chatBuckets, 2)

  let resolved = false
  const pending = limiter.acquire('a').then(() => {
    resolved = true
  })
  await tick()
  assert.equal(resolved, false, 'a recently used chat keeps its depleted bucket')
  assert.equal(limiter.snapshot().queueDepth, 1)

  time += 1000
  limiter.pump()
  await pending
  limiter.stop()
})

test('the default chat bucket bound keeps memory at 500 buckets', async () => {
  const limiter = createLimiter({ perChatPerSecond: 10, globalPerSecond: 100_000, logger: silent })
  for (let index = 0; index < 600; index += 1) await limiter.acquire(`chat-${index}`)
  assert.equal(limiter.snapshot().maxChatBuckets, 500)
  assert.equal(limiter.snapshot().chatBuckets, 500)
  limiter.stop()
})

// ---------------------------------------------------------------------------
// P2: waitFor() is a read-only estimate
// ---------------------------------------------------------------------------

test('waitFor() estimates the refill delay without creating, refilling or evicting buckets', async () => {
  let time = 1_000_000
  const limiter = createLimiter({ perChatPerSecond: 1, globalPerSecond: 100, maxChatBuckets: 2, now: () => time, logger: silent })

  assert.equal(limiter.snapshot().chatBuckets, 0)
  assert.equal(limiter.waitFor('never-seen'), 0, 'a missing bucket would be created full of tokens')
  assert.equal(limiter.snapshot().chatBuckets, 0, 'waitFor must not create buckets')

  await limiter.acquire('a')
  assert.equal(limiter.waitFor('a'), 1000, 'a depleted chat needs the full refill')
  time += 500
  assert.equal(limiter.waitFor('a'), 500)
  assert.equal(limiter.snapshot().chatBuckets, 1, 'waitFor must not change the bucket map')

  await limiter.acquire('b') // map is now {a, b} at the limit
  assert.equal(limiter.waitFor('a'), 500, 'a still holds its partially refilled bucket')
  assert.equal(limiter.waitFor('unknown'), 0)
  assert.equal(limiter.waitFor('a'), 500, 'probing an unknown chat must not evict the LRU bucket')
  assert.equal(limiter.snapshot().chatBuckets, 2)
  limiter.stop()
})
