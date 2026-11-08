import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_HTML_PATH,
  SETTINGS_JSON_PATH,
  SETTINGS_KEYS,
  createSettingsApi,
  createSettingsHandler,
  loadSettings,
  mergeSettings,
  resolveSettingsFile,
  safeEqual,
  sanitizeSettingsPatch,
  saveSettings,
} from '../lib/settings.mjs'

const silent = { info() {}, warn() {}, debug() {} }

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-max-notify-settings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function fakeRequest({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.resume = () => {}
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
      this.headers[name.toLowerCase()] = value
    },
    end(value) {
      this.body = String(value ?? '')
      this.finished = true
    },
  }
}

function settingsUrl(path, token) {
  return `${path}?token=${encodeURIComponent(token)}`
}

function makeHandler(file, { token = 'secret-token', getStatus = () => ({ transport: 'polling' }), getVersion = () => '1.2.3', maxBytes } = {}) {
  return createSettingsHandler({ token, file, getStatus, getVersion, logger: silent, maxBytes })
}

async function get(handler, path, token, extra = {}) {
  const res = fakeResponse()
  await handler(fakeRequest({ method: 'GET', url: settingsUrl(path, token), ...extra }), res)
  return res
}

async function post(handler, token, body, extra = {}) {
  const res = fakeResponse()
  await handler(
    fakeRequest({
      method: 'POST',
      url: settingsUrl(SETTINGS_JSON_PATH, token),
      body,
      headers: { 'content-type': 'application/json' },
      ...extra,
    }),
    res,
  )
  return res
}

test('SETTINGS_KEYS exposes exactly the safe allowlist with defaults', () => {
  assert.deepEqual(Object.keys(SETTINGS_KEYS).sort(), [
    'approvalTimeoutMs',
    'buttonsPresets',
    'digestEnabled',
    'digestTime',
    'messageStyle',
    'mode',
    'nativeIncomingImages',
    'notify',
    'notifyErrors',
    'notifyGoals',
    'notifyJobs',
    'notifySubagents',
    'progress',
    'quietHours',
    'receiveFiles',
    'tableFiles',
    'tableMaxFiles',
    'threads',
    'todoProgress',
    'typing',
    'voiceEndpoint',
    'voiceModel',
    'voiceTranscribe',
    'voiceTts',
    'voiceTtsMaxChars',
    'voiceTtsMode',
    'voiceTtsModel',
    'voiceTtsVoice',
  ])
  assert.deepEqual(SETTINGS_KEYS.mode.values, ['all', 'errors', 'mute'])
  assert.equal(SETTINGS_KEYS.tableMaxFiles.min, 0)
  assert.equal(SETTINGS_KEYS.tableMaxFiles.max, 8)
  assert.equal(SETTINGS_KEYS.approvalTimeoutMs.max, 600000)
  assert.equal(SETTINGS_KEYS.buttonsPresets.maxItems, 6)
  assert.equal(SETTINGS_DEFAULTS.mode, 'all')
  assert.equal(SETTINGS_DEFAULTS.digestTime, '21:00')
  assert.equal(SETTINGS_DEFAULTS.tableMaxFiles, 4)
  assert.equal(SETTINGS_DEFAULTS.approvalTimeoutMs, 120000)
  assert.equal(SETTINGS_DEFAULTS.nativeIncomingImages, true)
  assert.equal(SETTINGS_DEFAULTS.voiceModel, 'whisper-1')
  assert.equal(SETTINGS_DEFAULTS.voiceTts, false)
  assert.equal(SETTINGS_DEFAULTS.voiceTtsMode, 'short')
  assert.deepEqual(SETTINGS_DEFAULTS.buttonsPresets, [])
})

test('sanitizeSettingsPatch validates and coerces the full allowlist', () => {
  const result = sanitizeSettingsPatch({
    mode: ' ERRORS ',
    digestEnabled: 'true',
    digestTime: '07:05',
    quietHours: { start: '22:30', end: '06:15' },
    threads: 'off',
    tableFiles: 1,
    tableMaxFiles: '8',
    notify: 'yes',
    progress: 0,
    typing: false,
    approvalTimeoutMs: '600000',
    receiveFiles: true,
    nativeIncomingImages: 'on',
    buttonsPresets: [
      { label: ' Ok ', prompt: ' Do it ' },
      { label: 'B', prompt: 'C' },
    ],
    voiceTranscribe: 'true',
    voiceEndpoint: ' https://stt.example.test/v1/audio ',
    voiceModel: ' whisper-1 ',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.ignored, [])
  assert.deepEqual(result.values, {
    mode: 'errors',
    digestEnabled: true,
    digestTime: '07:05',
    quietHours: { start: '22:30', end: '06:15' },
    threads: false,
    tableFiles: true,
    tableMaxFiles: 8,
    notify: true,
    progress: false,
    typing: false,
    approvalTimeoutMs: 600000,
    receiveFiles: true,
    nativeIncomingImages: true,
    buttonsPresets: [
      { label: 'Ok', prompt: 'Do it' },
      { label: 'B', prompt: 'C' },
    ],
    voiceTranscribe: true,
    voiceEndpoint: 'https://stt.example.test/v1/audio',
    voiceModel: 'whisper-1',
  })
})

test('sanitizeSettingsPatch reports every invalid allowlisted value', () => {
  const result = sanitizeSettingsPatch({
    mode: 'quiet',
    digestEnabled: 'maybe',
    digestTime: '7:5',
    quietHours: { start: '24:00', end: '06:00' },
    tableMaxFiles: 9,
    approvalTimeoutMs: -1,
    buttonsPresets: Array.from({ length: 7 }, () => ({ label: 'a', prompt: 'b' })),
    voiceEndpoint: 'http://insecure.test/api',
    voiceModel: 'x'.repeat(81),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.values, {})
  assert.equal(result.errors.length, 9)
  for (const key of [
    'mode',
    'digestEnabled',
    'digestTime',
    'quietHours',
    'tableMaxFiles',
    'approvalTimeoutMs',
    'buttonsPresets',
    'voiceEndpoint',
    'voiceModel',
  ]) {
    assert.ok(
      result.errors.some((message) => message.startsWith(`${key}:`)),
      `missing error for ${key}: ${result.errors.join(' | ')}`,
    )
  }
})

test('sanitizeSettingsPatch keeps valid keys of an invalid partial patch', () => {
  const result = sanitizeSettingsPatch({ mode: 'mute', tableMaxFiles: 99 })
  assert.equal(result.ok, false)
  assert.deepEqual(result.values, { mode: 'mute' })
  assert.equal(result.errors.length, 1)
})

test('sanitizeSettingsPatch validates preset shape, sizes and count', () => {
  const cases = [
    [{ buttonsPresets: 'nope' }, /array/],
    [{ buttonsPresets: [{ label: '', prompt: 'p' }] }, /label/],
    [{ buttonsPresets: [{ label: 'x'.repeat(41), prompt: 'p' }] }, /label/],
    [{ buttonsPresets: [{ label: 'l', prompt: '' }] }, /prompt/],
    [{ buttonsPresets: [{ label: 'l', prompt: 'p'.repeat(501) }] }, /prompt/],
    [{ buttonsPresets: Array.from({ length: 7 }, (_, index) => ({ label: `l${index}`, prompt: 'p' })) }, /at most 6/],
    [{ buttonsPresets: [null] }, /item 1/],
  ]
  for (const [patch, pattern] of cases) {
    const result = sanitizeSettingsPatch(patch)
    assert.equal(result.ok, false)
    assert.match(result.errors[0], pattern)
  }
  assert.equal(sanitizeSettingsPatch({ buttonsPresets: [] }).ok, true)
})

test('sanitizeSettingsPatch accepts null/empty optional values and exact limits', () => {
  assert.deepEqual(sanitizeSettingsPatch({ quietHours: null }).values, { quietHours: null })
  assert.deepEqual(sanitizeSettingsPatch({ voiceEndpoint: null }).values, { voiceEndpoint: null })
  assert.deepEqual(sanitizeSettingsPatch({ voiceEndpoint: '' }).values, { voiceEndpoint: null })
  assert.equal(sanitizeSettingsPatch({ voiceModel: '' }).ok, true)
  assert.equal(sanitizeSettingsPatch({ voiceModel: 'x'.repeat(80) }).ok, true)
  assert.equal(sanitizeSettingsPatch({ digestTime: '23:59' }).ok, true)
  assert.equal(sanitizeSettingsPatch({ approvalTimeoutMs: '0' }).ok, true)
})

test('sanitizeSettingsPatch ignores unknown keys with a message and no values', () => {
  const result = sanitizeSettingsPatch({ botToken: 'do-not-leak', mode: 'mute', 'some key': 1 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.values, { mode: 'mute' })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ignored.length, 2)
  assert.match(result.ignored[0], /botToken/)
  assert.doesNotMatch(JSON.stringify(result.ignored), /do-not-leak/)
})

test('sanitizeSettingsPatch rejects non-object patches', () => {
  for (const patch of [null, undefined, [], 'text', 42, true]) {
    const result = sanitizeSettingsPatch(patch)
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /object/)
    assert.deepEqual(result.values, {})
  }
})

test('mergeSettings applies only valid allowlisted overrides and never mutates', () => {
  const config = { mode: 'all', tableMaxFiles: 4, botToken: 'private', quietHours: null }
  const merged = mergeSettings(config, {
    mode: 'mute',
    tableMaxFiles: '2',
    digestTime: 'not-a-time',
    botToken: 'hacked',
    unknown: true,
    quietHours: { start: '22:00', end: '07:00' },
  })
  assert.notEqual(merged, config)
  assert.deepEqual(config, { mode: 'all', tableMaxFiles: 4, botToken: 'private', quietHours: null })
  assert.equal(merged.mode, 'mute')
  assert.equal(merged.tableMaxFiles, 2)
  assert.equal(merged.botToken, 'private')
  assert.equal(merged.digestTime, undefined)
  assert.equal(merged.unknown, undefined)
  assert.deepEqual(merged.quietHours, { start: '22:00', end: '07:00' })
  assert.deepEqual(mergeSettings(null, { mode: 'errors' }), { mode: 'errors' })
  assert.deepEqual(mergeSettings({ mode: 'all' }, null), { mode: 'all' })
})

test('loadSettings returns {} for a missing, corrupt or non-object file', (t) => {
  const directory = tempDir(t)
  const missing = join(directory, 'missing.json')
  assert.deepEqual(loadSettings(missing), {})
  assert.deepEqual(loadSettings(undefined), {})

  const corrupt = join(directory, 'corrupt.json')
  writeFileSync(corrupt, '{oops')
  assert.deepEqual(loadSettings(corrupt), {})

  const array = join(directory, 'array.json')
  writeFileSync(array, '[1,2,3]')
  assert.deepEqual(loadSettings(array), {})
})

test('loadSettings keeps valid values and drops unknown/invalid ones', (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'config.json')
  writeFileSync(
    file,
    JSON.stringify({ mode: 'errors', threads: false, tableMaxFiles: 99, botToken: 'private', extra: true }),
  )
  assert.deepEqual(loadSettings(file), { mode: 'errors', threads: false })
})

test('saveSettings writes atomically with mode 0600 and can be loaded back', (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'nested', 'config.json')
  const saved = saveSettings(file, { mode: 'mute', threads: false })
  assert.deepEqual(saved, { mode: 'mute', threads: false })
  assert.deepEqual(loadSettings(file), saved)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(
    readdirSync(join(directory, 'nested')).filter((name) => name.endsWith('.tmp')),
    [],
  )

  saveSettings(file, { mode: 'all' })
  assert.deepEqual(loadSettings(file), { mode: 'all' })
})

test('saveSettings rejects invalid values without touching the existing file', (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'config.json')
  saveSettings(file, { mode: 'all' })
  assert.throws(() => saveSettings(file, { tableMaxFiles: 99 }), /invalid settings/)
  assert.throws(() => saveSettings(file, null), /invalid settings/)
  assert.deepEqual(loadSettings(file), { mode: 'all' })
})

test('safeEqual compares secrets with equal length semantics and fails closed', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual(undefined, 'abc'), false)
  assert.equal(safeEqual('', ''), false)
})

test('the handler rejects a missing, wrong or unconfigured token with 401', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const handler = makeHandler(file, { token: 'top-secret' })
  for (const url of [SETTINGS_HTML_PATH, SETTINGS_JSON_PATH, settingsUrl(SETTINGS_JSON_PATH, 'wrong')]) {
    const res = fakeResponse()
    await handler(fakeRequest({ url }), res)
    assert.equal(res.statusCode, 401)
    assert.match(res.headers['content-type'], /application\/json/)
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'unauthorized' })
    assert.doesNotMatch(res.body, /top-secret/)
  }

  const unconfigured = createSettingsHandler({ file, logger: silent })
  const res = fakeResponse()
  await unconfigured(fakeRequest({ url: settingsUrl(SETTINGS_JSON_PATH, 'anything') }), res)
  assert.equal(res.statusCode, 401)
  assert.doesNotMatch(res.body, /anything/)
})

test('a bad token is checked before the route so unknown paths do not leak either', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const handler = makeHandler(file)
  const unauthorized = fakeResponse()
  await handler(fakeRequest({ url: '/max-notify/other' }), unauthorized)
  assert.equal(unauthorized.statusCode, 401)

  const notFound = await get(handler, '/max-notify/other', 'secret-token')
  assert.equal(notFound.statusCode, 404)
})

test('GET /max-notify/settings returns a dark standalone HTML page', async (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'config.json')
  saveSettings(file, {
    mode: 'errors',
    tableMaxFiles: 2,
    quietHours: { start: '23:00', end: '07:00' },
    voiceModel: '<img src=x onerror=alert(1)>',
  })
  const handler = createSettingsHandler({
    token: 'tok&en',
    file,
    getStatus: () => ({ transport: 'webhook', note: '<script>status</script>' }),
    getVersion: () => '9.9.9',
    logger: silent,
  })
  const res = await get(handler, SETTINGS_HTML_PATH, 'tok&en')
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.headers['content-security-policy'], /default-src 'none'/)
  assert.match(res.body, /<style>/)
  assert.ok(res.body.includes('id="settings-form"'))
  assert.ok(res.body.includes('data-endpoint="/max-notify/settings.json?token=tok%26en"'))
  assert.match(res.body, /<option value="errors" selected>/)
  assert.ok(res.body.includes('value="23:00"'))
  assert.ok(res.body.includes('value="07:00"'))
  assert.ok(res.body.includes('value="2"'))
  assert.ok(res.body.includes('9.9.9'))
  assert.ok(res.body.includes('Сохранить'))
  assert.ok(res.body.includes('&lt;script&gt;status&lt;/script&gt;'))
  assert.ok(!res.body.includes('<script>status'))
  assert.ok(res.body.includes('value="&lt;img src=x onerror=alert(1)&gt;"'))
  assert.ok(!res.body.includes('<img src=x'))
  assert.doesNotMatch(res.body, /<link\b|<script[^>]+src=/)
})

test('GET HTML shows defaults when the overlay file does not exist', async (t) => {
  const file = join(tempDir(t), 'missing.json')
  const handler = makeHandler(file)
  const res = await get(handler, SETTINGS_HTML_PATH, 'secret-token')
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /<option value="all" selected>/)
  assert.ok(res.body.includes('value="21:00"'))
  assert.ok(res.body.includes('value="whisper-1"'))
  assert.ok(res.body.includes('value="120000"'))
})

test('GET /max-notify/settings.json returns values, status and version', async (t) => {
  const file = join(tempDir(t), 'config.json')
  saveSettings(file, { mode: 'mute' })
  const status = { transport: 'polling', users: 2 }
  const handler = makeHandler(file, { getStatus: () => status, getVersion: async () => '2.0.0' })
  const res = await get(handler, SETTINGS_JSON_PATH, 'secret-token')
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['cache-control'], /no-store/)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.deepEqual(data.status, status)
  assert.equal(data.version, '2.0.0')
  assert.equal(data.values.mode, 'mute')
  assert.equal(data.values.digestTime, '21:00')
  assert.equal(data.values.voiceModel, 'whisper-1')
  assert.deepEqual(data.values.buttonsPresets, [])
  assert.equal(data.values.quietHours, null)
})

test('status/version getters that throw do not break the JSON API', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const handler = makeHandler(file, {
    getStatus: () => {
      throw new Error('status boom')
    },
    getVersion: async () => {
      throw new Error('version boom')
    },
  })
  const res = await get(handler, SETTINGS_JSON_PATH, 'secret-token')
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.status, null)
  assert.equal(data.version, null)
})

test('POST settings.json validates, merges with the overlay and saves atomically', async (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'config.json')
  const handler = makeHandler(file, { getStatus: () => ({ transport: 'polling' }), getVersion: () => '1.0.0' })

  const first = await post(handler, 'secret-token', {
    mode: 'mute',
    tableMaxFiles: '3',
    digestTime: '06:30',
    botToken: 'do-not-save',
  })
  assert.equal(first.statusCode, 200)
  const firstData = JSON.parse(first.body)
  assert.equal(firstData.ok, true)
  assert.equal(firstData.restartRequired, true)
  assert.equal(firstData.values.mode, 'mute')
  assert.equal(firstData.values.tableMaxFiles, 3)
  assert.equal(firstData.values.digestTime, '06:30')
  assert.equal(firstData.values.notify, true)
  assert.equal(firstData.ignored.length, 1)
  assert.match(firstData.ignored[0], /botToken/)
  assert.deepEqual(loadSettings(file), { mode: 'mute', tableMaxFiles: 3, digestTime: '06:30' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  )

  const second = await post(handler, 'secret-token', { threads: false })
  assert.equal(second.statusCode, 200)
  const secondData = JSON.parse(second.body)
  assert.equal(secondData.values.mode, 'mute')
  assert.equal(secondData.values.threads, false)
  assert.deepEqual(loadSettings(file), { mode: 'mute', tableMaxFiles: 3, digestTime: '06:30', threads: false })
})

test('POST with only unknown keys succeeds, reports them and keeps the file unchanged', async (t) => {
  const file = join(tempDir(t), 'config.json')
  saveSettings(file, { mode: 'errors' })
  const handler = makeHandler(file)
  const res = await post(handler, 'secret-token', { botToken: 'leak', chatId: '123' })
  assert.equal(res.statusCode, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.values.mode, 'errors')
  assert.equal(data.ignored.length, 2)
  assert.deepEqual(loadSettings(file), { mode: 'errors' })
})

test('POST rejects invalid JSON, non-object JSON and invalid values with 400', async (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'config.json')
  const handler = makeHandler(file)

  const invalidJson = await post(handler, 'secret-token', '{oops')
  assert.equal(invalidJson.statusCode, 400)
  assert.equal(JSON.parse(invalidJson.body).error, 'invalid JSON')

  const empty = await post(handler, 'secret-token', '')
  assert.equal(empty.statusCode, 400)

  const array = await post(handler, 'secret-token', [1, 2, 3])
  assert.equal(array.statusCode, 400)
  assert.match(JSON.parse(array.body).errors[0], /object/)

  const invalidValue = await post(handler, 'secret-token', { mode: 'mute', tableMaxFiles: 99 })
  assert.equal(invalidValue.statusCode, 400)
  const data = JSON.parse(invalidValue.body)
  assert.equal(data.ok, false)
  assert.ok(data.errors.some((message) => message.startsWith('tableMaxFiles:')))
  assert.equal(existsSync(file), false)
})

test('POST rejects a body over 64 KiB with 413', async (t) => {
  const directory = tempDir(t)
  const file = join(directory, 'config.json')
  const handler = makeHandler(file)
  const oversized = JSON.stringify({ voiceModel: 'x'.repeat(70 * 1024) })
  const res = await post(handler, 'secret-token', oversized)
  assert.equal(res.statusCode, 413)
  assert.equal(JSON.parse(res.body).error, 'request body too large')
  assert.equal(existsSync(file), false)
})

test('POST rejects a declared oversized content-length before reading', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const handler = makeHandler(file)
  const res = await post(handler, 'secret-token', '{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } })
  assert.equal(res.statusCode, 413)
})

test('an aborted POST body is rejected instead of hanging the handler', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const handler = makeHandler(file)
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = settingsUrl(SETTINGS_JSON_PATH, 'secret-token')
  req.headers = {}
  req.resume = () => {}
  const res = fakeResponse()
  queueMicrotask(() => req.emit('aborted'))
  await handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'cannot read request body')
})

test('POST answers 500 when the settings file cannot be written', async (t) => {
  const directory = tempDir(t)
  const blocker = join(directory, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const handler = makeHandler(join(blocker, 'config.json'))
  const res = await post(handler, 'secret-token', { mode: 'mute' })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'cannot save settings' })
})

test('unsupported methods and write access to the HTML route answer 405', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const handler = makeHandler(file)

  const put = fakeResponse()
  await handler(fakeRequest({ method: 'PUT', url: settingsUrl(SETTINGS_JSON_PATH, 'secret-token') }), put)
  assert.equal(put.statusCode, 405)
  assert.equal(put.headers.allow, 'GET, POST')

  const htmlPost = fakeResponse()
  await handler(fakeRequest({ method: 'POST', url: settingsUrl(SETTINGS_HTML_PATH, 'secret-token'), body: {} }), htmlPost)
  assert.equal(htmlPost.statusCode, 405)
  assert.equal(htmlPost.headers.allow, 'GET')
})

test('legacy createSettingsApi stays compatible with the DSH client integration', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const api = createSettingsApi({
    file,
    getValues: () => ({ mode: 'all', notify: true }),
    getStatus: () => ({ transport: 'polling' }),
    getVersion: () => '3.0.0',
  })

  const getRes = fakeResponse()
  await api(fakeRequest({ method: 'GET', url: SETTINGS_JSON_PATH }), getRes)
  assert.equal(getRes.statusCode, 200)
  assert.deepEqual(JSON.parse(getRes.body), {
    ok: true,
    values: { mode: 'all', notify: true },
    status: { transport: 'polling' },
    version: '3.0.0',
  })

  const postRes = fakeResponse()
  await api(
    fakeRequest({
      method: 'POST',
      url: SETTINGS_JSON_PATH,
      body: { mode: 'mute', botToken: 'do-not-save' },
      headers: { 'content-type': 'application/json' },
    }),
    postRes,
  )
  assert.equal(postRes.statusCode, 200)
  const data = JSON.parse(postRes.body)
  assert.equal(data.values.mode, 'mute')
  assert.equal(data.values.notify, true)
  assert.equal(data.restartRequired, true)
  assert.equal(data.ignored.length, 1)
  assert.deepEqual(loadSettings(file), { mode: 'mute' })
})

test('resolveSettingsFile honors settingsFile and falls back outside the repository', () => {
  assert.equal(resolveSettingsFile({ settingsFile: '/tmp/custom-settings.json' }), '/tmp/custom-settings.json')
  assert.match(resolveSettingsFile({}), /max-notify[\\/]config\.json$/)
})

test('TTS settings validate and onSave applies them live', async (t) => {
  const file = join(tempDir(t), 'config.json')
  const applied = []
  const api = createSettingsApi({
    file,
    getValues: () => ({ voiceTts: false }),
    onSave: async (values) => {
      applied.push(values)
      return { applied: values, restartRequired: false }
    },
  })
  const res = fakeResponse()
  await api(fakeRequest({
    method: 'POST',
    body: { voiceTts: true, voiceTtsMode: 'always', voiceTtsVoice: 'alloy', voiceTtsMaxChars: 900 },
  }), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.restartRequired, false)
  assert.deepEqual(payload.applied, {
    voiceTts: true,
    voiceTtsMode: 'always',
    voiceTtsVoice: 'alloy',
    voiceTtsMaxChars: 900,
  })
  assert.equal(applied.length, 1)
  assert.equal(loadSettings(file).voiceTts, true)
})
