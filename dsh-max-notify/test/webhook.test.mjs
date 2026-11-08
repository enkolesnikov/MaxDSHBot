import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createWebhookHandler,
  ensureWebhookSubscription,
  removeWebhookSubscription,
  safeEqual,
} from '../lib/webhook.mjs'

const silent = { info() {}, warn() {}, debug() {} }

function fakeRequest({ method = 'POST', secret, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = secret === undefined ? {} : { 'x-max-bot-api-secret': secret }
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(value) {
      this.body = String(value ?? '')
      this.finished = true
    },
  }
}

test('safeEqual compares secrets in constant time semantics', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual(undefined, 'abc'), false)
})

test('a valid webhook POST persists the update and answers 200', async () => {
  const updates = []
  const handler = createWebhookHandler({ secret: 'top-secret', accept: async (update) => updates.push(update), logger: silent })
  const res = fakeResponse()
  await handler(fakeRequest({ secret: 'top-secret', body: { update_type: 'message_created' } }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].update_type, 'message_created')
  assert.match(res.headers['content-type'], /application\/json/)
})

test('a bad secret is rejected with 401 and the update is not accepted', async () => {
  let accepted = false
  const handler = createWebhookHandler({ secret: 'top-secret', accept: async () => { accepted = true }, logger: silent })
  const res = fakeResponse()
  await handler(fakeRequest({ secret: 'wrong', body: {} }), res)
  assert.equal(res.statusCode, 401)
  assert.equal(accepted, false)
})

test('non-POST requests are rejected with 405', async () => {
  const handler = createWebhookHandler({ secret: 's', accept: async () => {}, logger: silent })
  const res = fakeResponse()
  await handler(fakeRequest({ method: 'GET', secret: 's' }), res)
  assert.equal(res.statusCode, 405)
})

test('invalid JSON is rejected with 400', async () => {
  const handler = createWebhookHandler({ secret: 's', accept: async () => {}, logger: silent })
  const res = fakeResponse()
  await handler(fakeRequest({ secret: 's', body: '{oops' }), res)
  assert.equal(res.statusCode, 400)
})

test('a storage failure answers 503 so MAX retries the delivery', async () => {
  const handler = createWebhookHandler({
    secret: 's',
    accept: async () => {
      throw new Error('disk full')
    },
    logger: silent,
  })
  const res = fakeResponse()
  await handler(fakeRequest({ secret: 's', body: { update_type: 'message_created' } }), res)
  assert.equal(res.statusCode, 503)
})

test('oversized bodies are rejected with 413', async () => {
  const handler = createWebhookHandler({ secret: 's', accept: async () => {}, maxBytes: 16, logger: silent })
  const res = fakeResponse()
  await handler(fakeRequest({ secret: 's', body: { update_type: 'x', padding: 'a'.repeat(100) } }), res)
  assert.equal(res.statusCode, 413)
})

test('missing secret configuration fails closed', async () => {
  let accepted = false
  const handler = createWebhookHandler({ secret: undefined, accept: async () => { accepted = true }, logger: silent })
  const res = fakeResponse()
  await handler(fakeRequest({ secret: 'anything', body: {} }), res)
  assert.equal(res.statusCode, 503)
  assert.equal(accepted, false)
})

test('ensureWebhookSubscription subscribes/updates an existing URL', async () => {
  const calls = []
  const client = {
    async getSubscriptions() {
      return { subscriptions: [{ url: 'https://example.test/max/webhook' }] }
    },
    async subscribeWebhook(params) {
      calls.push(params)
    },
  }
  const result = await ensureWebhookSubscription({
    client,
    url: 'https://example.test/max/webhook',
    secret: 's',
    updateTypes: 'message_created',
    logger: silent,
  })
  assert.equal(result.ok, true)
  assert.equal(result.existing, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].secret, 's')
})

test('ensureWebhookSubscription rejects non-HTTPS URLs', async () => {
  const result = await ensureWebhookSubscription({
    client: { subscribeWebhook: async () => {} },
    url: 'http://example.test/webhook',
    secret: 's',
    logger: silent,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /https/)
})

test('removeWebhookSubscription is best effort', async () => {
  const urls = []
  const result = await removeWebhookSubscription({
    client: { unsubscribeWebhook: async (url) => urls.push(url) },
    url: 'https://example.test/max/webhook',
    logger: silent,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(urls, ['https://example.test/max/webhook'])
})
