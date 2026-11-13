import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_JSON_PATH,
  SETTINGS_KEYS,
  createSettingsApi,
  loadSettings,
  mergeSettings,
  resolveSettingsFile,
  sanitizeSettingsPatch,
  saveSettings,
} from '../lib/settings.mjs'

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
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.values, {})
  assert.equal(result.errors.length, 7)
  for (const key of [
    'mode',
    'digestEnabled',
    'digestTime',
    'quietHours',
    'tableMaxFiles',
    'approvalTimeoutMs',
    'buttonsPresets',
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
