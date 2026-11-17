/**
 * Plugin teardown / HMR lifecycle contract.
 *
 * The plugin is a Cordis function plugin: `apply(ctx, config)` registers every
 * background concern inside `ctx.effect(() => disposer)`. DSH reloads plugins on
 * HMR, so the disposer is the only thing that stops sends, timers, routes and
 * durable writers of the previous generation. These tests drive a fake Cordis
 * context (no real DSH host, no network) and assert the full teardown contract:
 *
 *  - no dry-run send attempts or transport calls after dispose;
 *  - background timers are cleared (the test process must not be held alive);
 *  - webServer routes registered by the plugin are disposed;
 *  - durable state/outbox/health files are valid JSON with no half-written tmp
 *    files (state/outbox are flushed by their own disposers);
 *  - a second generation (HMR reload) re-registers routes cleanly;
 *  - calling the disposer twice does not throw.
 *
 * Most scenarios run with `dryRun: true` so the plugin fakes every outbound
 * write and the fake transport asserts it was never called; the only observable
 * "send attempt" then is the plugin's `[dry-run] would send` log line. One test
 * switches dry-run off and drives the real send path against the fake transport.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never resolve the plugin's default state under a live DSH home. Every test
// below also passes explicit paths; this is belt-and-braces isolation.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-max-notify-teardown-'))
process.env.DSH_HOME = TEST_HOME

const { apply } = await import('../index.js')
const { createFakeClient, createFakeCtx, createFakeWebServer, tick, waitFor } = await import('./helpers/fakes.mjs')

const CHAT_ID = '42424242'
// Valid MAX webhook secret: 32-256 chars, [A-Za-z0-9_-].
const WEBHOOK_SECRET = 'teardown-secret-0123456789abcdef0123456789'

const tempDirs = []
test.after(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true })
  rmSync(TEST_HOME, { recursive: true, force: true })
})

/** Fresh per-test directory with all durable paths the plugin can write. */
function createPaths() {
  const dir = mkdtempSync(join(TEST_HOME, 'case-'))
  tempDirs.push(dir)
  return {
    dir,
    stateFile: join(dir, 'state.json'),
    outboxFile: join(dir, 'outbox.json'),
    healthFile: join(dir, 'health.json'),
    settingsFile: join(dir, 'settings.json'),
    auditFile: join(dir, 'audit.jsonl'),
  }
}

function createConfig(paths) {
  return {
    botToken: 'teardown-token',
    chatId: CHAT_ID,
    // Allowlisting the target keeps the remote-control half enabled without any
    // getChat lookup, so the webhook route is registered on the sync setup path.
    allowedChatIds: [CHAT_ID],
    dryRun: true,
    transport: 'webhook',
    webhookSecret: WEBHOOK_SECRET,
    webhookAutoSubscribe: false,
    webhookRemoveOnStop: false,
    settingsPage: true,
    stateFile: paths.stateFile,
    outboxFile: paths.outboxFile,
    heartbeatFile: paths.healthFile,
    settingsFile: paths.settingsFile,
    auditFile: paths.auditFile,
    minIntervalMs: 0,
    requestTimeoutMs: 1000,
  }
}

const SESSION = Object.freeze({ id: 'teardown-session', header: { cwd: '/tmp/teardown-workspace' } })
let seq = 0
const event = (type, data) => ({ type, seq: (seq += 1), time: Date.now(), data })
const assistantMessage = (turn, text) =>
  event('assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
const turnEnd = (turn, kind = 'completed') => event('turn/end', { turn, reason: { kind } })

function emitTurn(fake, turn, text) {
  fake.emit('session/event', SESSION, assistantMessage(turn, text))
  fake.emit('session/event', SESSION, turnEnd(turn))
}

/** Dry-run "would send" log lines prove the forwarding path actually ran. */
const sentAttempts = (fake) => fake.logs.filter(([, message]) => String(message).includes('[dry-run] would send')).length

/** A timer that would keep the process alive; unref'd/cleared timers are absent. */
const activeTimeouts = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length

function assertNoTmpFiles(dir) {
  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `durable writers must not leave tmp files behind: ${leftovers.join(', ')}`)
}

function assertValidJson(file, label) {
  assert.ok(existsSync(file), `${label} must exist after dispose: ${file}`)
  const text = readFileSync(file, 'utf8')
  assert.doesNotThrow(() => JSON.parse(text), `${label} must be valid JSON`)
  return JSON.parse(text)
}

function assertPrivateMode(file) {
  if (process.platform === 'win32') return
  const mode = statSync(file).mode & 0o777
  assert.equal(mode, 0o600, `${file} must be writable only by the owner (mode ${mode.toString(8)})`)
}

function assertRoutesDisposed(webServer, registered) {
  assert.equal(webServer.exact.size, 0, 'no exact routes may survive dispose')
  assert.equal(webServer.prefixes.size, 0, 'no prefix routes may survive dispose')
  assert.equal(webServer.disposed.length, registered, 'every registered route must be disposed exactly once')
}

test('apply → dispose stops sends, clears timers, disposes routes and flushes durable files', async () => {
  const paths = createPaths()
  const webServer = createFakeWebServer()
  const fake = createFakeCtx({ services: { webServer } })
  const client = createFakeClient()
  const baselineTimers = activeTimeouts()
  // Positive control: the timer accounting below must notice a ref'd timer, so a
  // green "no timers after dispose" assertion is not vacuous.
  const probe = setTimeout(() => {}, 30_000)
  assert.equal(activeTimeouts(), baselineTimers + 1, 'timer accounting must detect an active timer')
  clearTimeout(probe)
  assert.equal(activeTimeouts(), baselineTimers, 'cleared probe timer must disappear')

  apply(fake.ctx, createConfig(paths), { createClient: () => client })

  // The sync (non-inject) setup path registers the webhook and settings routes.
  assert.equal(webServer.registered.length, 2, 'webhook + settings routes must be registered by apply')
  assert.deepEqual([...webServer.exact.keys()].sort(), ['/max-notify/settings.json', '/max/webhook'])
  assert.ok(fake.effects.length >= 1, 'apply must register a Cordis effect')
  assert.ok(existsSync(paths.healthFile), 'the effect must write the first heartbeat')
  assert.equal(
    client.calls.filter(([name]) => name === 'subscribeWebhook').length,
    0,
    'webhookAutoSubscribe:false must not touch the subscriptions API',
  )

  // One live generation: a completed turn becomes exactly one dry-run send.
  emitTurn(fake, 1, 'тестовое сообщение teardown')
  await waitFor(() => sentAttempts(fake) >= 1, { label: 'first dry-run send attempt' })
  assert.equal(sentAttempts(fake), 1)
  assert.equal(client.sent.length, 0, 'dry run must never reach the transport')

  const mainDispose = fake.effects.at(-1)
  await mainDispose()
  await tick(30)

  const attemptsAfterDispose = sentAttempts(fake)
  const transportCallsAfterDispose = client.calls.length
  const timersAfterDispose = activeTimeouts()

  // 1. Routes are gone (both the webhook and the settings API).
  assertRoutesDisposed(webServer, 2)

  // 2. Background timers are cleared: nothing keeps the process alive.
  assert.equal(timersAfterDispose, baselineTimers, 'every plugin interval/timeout must be cleared on dispose')

  // 3. No send attempts or transport calls after dispose, even if a late event
  // arrives (listeners are still attached: the disposed gate must hold).
  emitTurn(fake, 2, 'сообщение после dispose')
  await tick(100)
  assert.equal(sentAttempts(fake), attemptsAfterDispose, 'no dry-run send may happen after dispose')
  assert.equal(client.calls.length, transportCallsAfterDispose, 'no transport call may happen after dispose')
  assert.equal(client.sent.length, 0)

  // 4. Durable state/outbox were flushed by their disposers and are valid JSON.
  const state = assertValidJson(paths.stateFile, 'state file')
  const outbox = assertValidJson(paths.outboxFile, 'outbox file')
  assert.ok(state && typeof state === 'object', 'state file must hold an object')
  assert.ok(outbox && typeof outbox === 'object', 'outbox file must hold an object')
  assertValidJson(paths.healthFile, 'heartbeat file')
  if (existsSync(paths.settingsFile)) assertValidJson(paths.settingsFile, 'settings file')
  assertPrivateMode(paths.stateFile)
  assertPrivateMode(paths.outboxFile)
  assertNoTmpFiles(paths.dir)

  // 5. The disposer is idempotent: a second call (HMR / double unload) must not throw.
  await assert.doesNotReject(async () => {
    await mainDispose()
    await mainDispose()
  })
  assert.ok(assertValidJson(paths.stateFile, 'state file after double dispose'))
  assert.ok(assertValidJson(paths.outboxFile, 'outbox file after double dispose'))
  assertNoTmpFiles(paths.dir)
  assert.equal(activeTimeouts(), baselineTimers, 'double dispose must not leak timers')

  // 6. Cordis also disposes the other effects of the fiber (route owners).
  await assert.doesNotReject(() => fake.disposeEffects())
  assertRoutesDisposed(webServer, 2)
  assert.equal(activeTimeouts(), baselineTimers, 'fiber unload must leave the timer table clean')
})

test('HMR generation: a second apply → dispose re-registers routes cleanly and leaves no state behind', async () => {
  const paths = createPaths()
  const webServer = createFakeWebServer()
  const baselineTimers = activeTimeouts()

  // Generation 1.
  const first = createFakeCtx({ services: { webServer } })
  const firstClient = createFakeClient()
  apply(first.ctx, createConfig(paths), { createClient: () => firstClient })
  emitTurn(first, 1, 'первое поколение')
  await waitFor(() => sentAttempts(first) >= 1, { label: 'generation 1 send attempt' })
  await first.effects.at(-1)()
  await first.disposeEffects()
  assertRoutesDisposed(webServer, 2)
  assert.equal(activeTimeouts(), baselineTimers)

  // Generation 2 against the same route table and the same durable files. A
  // stale route would be logged and replaced; a clean dispose must avoid it.
  const second = createFakeCtx({ services: { webServer } })
  const secondClient = createFakeClient()
  apply(second.ctx, createConfig(paths), { createClient: () => secondClient })
  const replaced = second.logs.filter(([, message]) => String(message).includes('replacing stale webServer route'))
  assert.deepEqual(replaced, [], 'the previous generation must not leave stale routes behind')
  assert.equal(webServer.exact.size, 2, 'the new generation must register both routes again')
  assert.equal(webServer.registered.length, 4)

  emitTurn(second, 1, 'второе поколение')
  await waitFor(() => sentAttempts(second) >= 1, { label: 'generation 2 send attempt' })
  assert.equal(secondClient.sent.length, 0)

  const secondDispose = second.effects.at(-1)
  await secondDispose()
  await secondDispose()
  await second.disposeEffects()
  await tick(30)

  assertRoutesDisposed(webServer, 4)
  assert.equal(activeTimeouts(), baselineTimers, 'the HMR generation must not leak timers')
  assertValidJson(paths.stateFile, 'state file after HMR')
  assertValidJson(paths.outboxFile, 'outbox file after HMR')
  assertNoTmpFiles(paths.dir)
})

test('a real (non-dry-run) send path stops at the transport after dispose', async () => {
  // The dry-run test above proves the plugin stops attempting sends; this one
  // proves the transport itself sees nothing after the disposer runs. The fake
  // client never leaves the process, so no network or live bot is involved.
  const paths = createPaths()
  const webServer = createFakeWebServer()
  const fake = createFakeCtx({ services: { webServer } })
  const client = createFakeClient()
  const baselineTimers = activeTimeouts()

  apply(fake.ctx, { ...createConfig(paths), dryRun: false }, { createClient: () => client })
  emitTurn(fake, 1, 'живое сообщение до dispose')
  await waitFor(() => client.sent.length >= 1, { label: 'first transport send' })
  assert.equal(client.sent.length, 1, 'the live generation must send exactly one message')

  await fake.effects.at(-1)()
  await tick(30)
  const sentBeforeDispose = client.sent.length
  const callsBeforeDispose = client.calls.length

  emitTurn(fake, 2, 'сообщение после dispose')
  await tick(150)
  assert.equal(client.sent.length, sentBeforeDispose, 'no message may be sent after dispose')
  assert.equal(client.calls.length, callsBeforeDispose, 'the transport must not be called after dispose')
  assert.equal(activeTimeouts(), baselineTimers, 'no plugin timer may survive dispose')

  await assert.doesNotReject(() => fake.disposeEffects())
  assertRoutesDisposed(webServer, 2)
  assertValidJson(paths.stateFile, 'state file after a real send')
  assertValidJson(paths.outboxFile, 'outbox file after a real send')
})

test('a durable-write failure during dispose is logged, not thrown into Cordis', async () => {
  // Teardown must be best-effort: a broken durable path is reported by the
  // state/outbox writers instead of thrown into Cordis, which would abort the
  // rest of the unload and leak the previous generation.
  const paths = createPaths()
  const blocker = join(paths.dir, 'blocked-as-a-file')
  writeFileSync(blocker, 'not a directory')
  const webServer = createFakeWebServer()
  const fake = createFakeCtx({ services: { webServer } })
  const baselineTimers = activeTimeouts()

  apply(fake.ctx, { ...createConfig(paths), stateFile: join(blocker, 'state.json') }, {
    createClient: () => createFakeClient(),
  })
  const mainDispose = fake.effects.at(-1)
  await assert.doesNotReject(() => mainDispose())
  await assert.doesNotReject(() => fake.disposeEffects())
  await tick(30)

  assertRoutesDisposed(webServer, 2)
  assert.equal(activeTimeouts(), baselineTimers, 'teardown must finish even when a write fails')
  const warnings = fake.logs.filter(([level]) => level === 'warn').map(([, message]) => String(message))
  assert.ok(
    warnings.some((message) => message.includes('cannot persist MAX state')),
    `a failed durable write must be logged as a warning, got: ${warnings.join(' | ')}`,
  )
  assertValidJson(paths.outboxFile, 'outbox file after a failed state write')
  assertNoTmpFiles(paths.dir)
})
