import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-max-notify-dry-'))

const { apply } = await import('../index.js')

function fakeCtx() {
  const emitter = new EventEmitter()
  const routes = []
  const disposers = []
  const services = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined },
  }
  const ctx = {
    ...services,
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get: (name) => services[name],
    inject: (deps, callback) => callback(services),
    on: (event, handler) => { emitter.on(event, handler); return () => emitter.off(event, handler) },
    effect: (factory) => { disposers.push(factory()) },
  }
  return { ctx, routes, dispose: async () => { for (const fn of disposers.reverse()) await fn?.() } }
}

function fakeClient() {
  const calls = []
  return {
    calls,
    sendMessage: async (params) => { calls.push(['sendMessage', params]); return { message: { body: { mid: 'real' } } } },
    sendText: async (params) => { calls.push(['sendText', params]); return [] },
    sendWithAttachments: async (params) => { calls.push(['sendWithAttachments', params]); return {} },
    editMessage: async () => { calls.push(['editMessage']); return {} },
    deleteMessage: async () => { calls.push(['deleteMessage']); return {} },
    answerCallback: async () => { calls.push(['answerCallback']); return {} },
    sendAction: async () => { calls.push(['sendAction']); return {} },
    uploadMedia: async () => { calls.push(['uploadMedia']); return { token: 'real-token' } },
    subscribeWebhook: async () => { calls.push(['subscribeWebhook']); return { ok: true } },
    unsubscribeWebhook: async () => { calls.push(['unsubscribeWebhook']); return { ok: true } },
    getChat: async () => ({ type: 'dialog', dialog_with_user: { user_id: '1' } }),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('dryRun never calls outbound client methods', async () => {
  const { ctx, dispose } = fakeCtx()
  const client = fakeClient()
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['123456789'], dryRun: true, notifyOnStart: false }, { createClient: () => client })
  // Trigger a message through the public runtime hook used by /send etc.
  ctx.emit?.('session/event')
  await sleep(20)
  assert.equal(client.calls.length, 0)
  await dispose()
})

test('settings GET exposes only GUI-allowed keys', async () => {
  const { ctx, routes, dispose } = fakeCtx()
  const client = fakeClient()
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['123456789'], dryRun: true, notifyOnStart: false }, { createClient: () => client })
  const route = routes.find((r) => r.path === '/max-notify/settings.json')
  assert.ok(route, 'settings route registered')
  let body
  const res = { setHeader() {}, end(payload) { body = JSON.parse(payload) } }
  await route.handler({ method: 'GET', headers: {} }, res)
  assert.equal(body.ok, true)
  assert.equal('voiceEndpoint' in body.values, false)
  assert.equal('voiceModel' in body.values, false)
  assert.equal('autonomyEnabled' in body.values, false)
  assert.equal('mode' in body.values, true)
  await dispose()
})

test('settings route relies on webServer admission (no rc.2 requestRejection re-check)', async () => {
  const routes = []
  const services = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: {}, // rc.2: requestRejection removed
  }
  const emitter = new EventEmitter()
  const ctx = {
    ...services,
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get: (name) => services[name],
    inject: (deps, callback) => callback(services),
    on: (event, handler) => { emitter.on(event, handler); return () => emitter.off(event, handler) },
    effect: (factory) => { factory() },
  }
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['123456789'], dryRun: true, notifyOnStart: false }, { createClient: () => fakeClient() })
  const route = routes.find((r) => r.path === '/max-notify/settings.json')
  assert.ok(route, 'settings route registered')
  assert.equal(route.auth, 'required', 'route must be admitted by the host')
  let body
  const res = { setHeader() {}, end(payload) { body = JSON.parse(payload) } }
  await route.handler({ method: 'GET', headers: {} }, res, { principal: 'admitted' })
  assert.equal(body.ok, true)
  assert.equal('voiceEndpoint' in body.values, false)
})

test('legacy hosts with requestRejection still fail closed when it rejects', async () => {
  const routes = []
  const services = {
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    connection: { requestRejection: async () => 401 },
  }
  const emitter = new EventEmitter()
  const ctx = {
    ...services,
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get: (name) => services[name],
    inject: (deps, callback) => callback(services),
    on: (event, handler) => { emitter.on(event, handler); return () => emitter.off(event, handler) },
    effect: (factory) => { factory() },
  }
  apply(ctx, { botToken: 't', chatId: '123456789', allowedUserIds: ['123456789'], dryRun: true, notifyOnStart: false }, { createClient: () => fakeClient() })
  const route = routes.find((r) => r.path === '/max-notify/settings.json')
  assert.equal(route.auth, 'required')
  let status
  const res = { statusCode: 0, setHeader() {}, end() { status = this.statusCode } }
  await route.handler({ method: 'GET', headers: {} }, res)
  assert.equal(status, 401)
})
