import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Keep the event loop alive on Node 20/22: the plugin uses unref'd approval
// timers, and the test runner otherwise cancels pending tests.
const keepAliveTimer = setInterval(() => {}, 1000)
after(() => clearInterval(keepAliveTimer))


import {
  DEFAULT_VOICE_MAX_BYTES,
  VOICE_PROMPT_LIMIT,
  resolveVoiceEndpoint,
  transcribeAudio,
  voiceConfigured,
  voicePromptText,
} from '../lib/voice.mjs'

const dirPromise = mkdtemp(join(tmpdir(), 'dsh-voice-'))
after(async () => {
  await rm(await dirPromise, { recursive: true, force: true })
})

async function audioFile(name = 'voice.ogg', content = 'OggS-test-audio') {
  const dir = await dirPromise
  const filePath = join(dir, name)
  await writeFile(filePath, content)
  return filePath
}

function jsonResponse(payload, status = 200, statusText = '') {
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })
}

const API_KEY = 'sk-test-secret-0123456789'

// ---------------------------------------------------------------------------
// resolveVoiceEndpoint
// ---------------------------------------------------------------------------

test('resolveVoiceEndpoint appends the transcription path to a base URL', () => {
  assert.equal(
    resolveVoiceEndpoint('https://api.openai.com/v1'),
    'https://api.openai.com/v1/audio/transcriptions',
  )
  assert.equal(
    resolveVoiceEndpoint('http://127.0.0.1:8080/v1/'),
    'http://127.0.0.1:8080/v1/audio/transcriptions',
  )
  assert.equal(
    resolveVoiceEndpoint('https://example.com'),
    'https://example.com/audio/transcriptions',
  )
})

test('resolveVoiceEndpoint keeps a complete transcription URL as is', () => {
  const url = 'https://api.openai.com/v1/audio/transcriptions'
  assert.equal(resolveVoiceEndpoint(url), url)
  assert.equal(resolveVoiceEndpoint(`${url}/`), url)
  assert.equal(
    resolveVoiceEndpoint('https://host/v1/audio/transcriptions?api-version=1'),
    'https://host/v1/audio/transcriptions?api-version=1',
  )
})

test('resolveVoiceEndpoint preserves a query string on the base URL', () => {
  assert.equal(
    resolveVoiceEndpoint('https://host/v1?api-version=1'),
    'https://host/v1/audio/transcriptions?api-version=1',
  )
})

test('resolveVoiceEndpoint rejects non-http(s) and malformed URLs', () => {
  for (const value of ['ftp://example.com/v1', 'file:///tmp/api', 'not-a-url', '', '   ', '//host/v1', undefined, null, 42]) {
    assert.throws(() => resolveVoiceEndpoint(value), TypeError, String(value))
  }
})

test('resolveVoiceEndpoint rejects credentials in the URL', () => {
  assert.throws(() => resolveVoiceEndpoint('https://user:pass@example.com/v1'), TypeError)
})

// ---------------------------------------------------------------------------
// transcribeAudio: request shape and success
// ---------------------------------------------------------------------------

test('transcribeAudio posts multipart form data with bearer auth and returns text', async () => {
  const filePath = await audioFile('voice.ogg', 'OggS-bytes')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ text: '  привет мир  ' })
  }

  const result = await transcribeAudio({
    filePath,
    endpoint: 'https://api.openai.com/v1',
    apiKey: API_KEY,
    language: 'ru',
    fetchImpl,
  })

  assert.deepEqual(result, { ok: true, text: 'привет мир' })
  assert.equal(calls.length, 1)

  const { url, init } = calls[0]
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`)
  assert.equal(init.headers['Content-Type'], undefined)
  assert.ok(init.signal instanceof AbortSignal)

  assert.ok(init.body instanceof FormData)
  const file = init.body.get('file')
  assert.ok(file instanceof Blob)
  assert.equal(file.name, 'voice.ogg')
  assert.equal(file.type, 'audio/ogg')
  assert.equal(await file.text(), 'OggS-bytes')
  assert.equal(init.body.get('model'), 'whisper-1')
  assert.equal(init.body.get('language'), 'ru')
  assert.equal(init.body.get('response_format'), 'json')
  assert.equal(url.includes(API_KEY), false)
})

test('transcribeAudio accepts a complete endpoint and custom model, omits empty language', async () => {
  const filePath = await audioFile('voice.mp3', 'mp3')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ text: 'ok' })
  }

  const result = await transcribeAudio({
    filePath,
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: API_KEY,
    model: 'gpt-4o-transcribe',
    language: '  ',
    fetchImpl,
  })

  assert.deepEqual(result, { ok: true, text: 'ok' })
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(calls[0].init.body.get('model'), 'gpt-4o-transcribe')
  assert.equal(calls[0].init.body.get('language'), null)
  assert.equal(calls[0].init.body.get('file').type, 'audio/mpeg')
})

test('transcribeAudio handles a fake response that only exposes json()', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: 'json only' }) })
  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.deepEqual(result, { ok: true, text: 'json only' })
})

// ---------------------------------------------------------------------------
// transcribeAudio: failures are returned, never thrown
// ---------------------------------------------------------------------------

test('transcribeAudio reports an HTTP error with the provider message', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () =>
    jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401, 'Unauthorized')

  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /401/)
  assert.match(result.error, /Incorrect API key/)
})

test('transcribeAudio reports a plain-text HTTP error', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () => new Response('<html>bad gateway</html>', { status: 502 })

  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /502/)
  assert.match(result.error, /bad gateway/)
})

test('transcribeAudio rejects a non-JSON success body', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () => new Response('<html>ok</html>', { status: 200 })

  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /не JSON/)
})

test('transcribeAudio rejects an empty transcript', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () => jsonResponse({ text: '   \n\t ' })

  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /Пустой текст/)
})

test('transcribeAudio rejects missing and empty files without calling fetch', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return jsonResponse({ text: 'x' })
  }

  const missing = await transcribeAudio({
    filePath: '/definitely/does/not/exist/voice.ogg',
    endpoint: 'https://host/v1',
    apiKey: API_KEY,
    fetchImpl,
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /не найден/)

  const emptyPath = await audioFile('empty.ogg', '')
  const empty = await transcribeAudio({ filePath: emptyPath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /пуст/)
  assert.equal(called, false)
})

test('transcribeAudio enforces maxBytes before fetch', async () => {
  const filePath = await audioFile('big.ogg', '0123456789')
  let called = false
  const fetchImpl = async () => {
    called = true
    return jsonResponse({ text: 'x' })
  }

  const result = await transcribeAudio({
    filePath,
    endpoint: 'https://host/v1',
    apiKey: API_KEY,
    maxBytes: 4,
    fetchImpl,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /лимит/)
  assert.match(result.error, /4/)
  assert.equal(called, false)
  assert.equal(DEFAULT_VOICE_MAX_BYTES, 25 * 1024 * 1024)
})

test('transcribeAudio rejects invalid endpoints and missing apiKey without fetch', async () => {
  const filePath = await audioFile()
  let called = false
  const fetchImpl = async () => {
    called = true
    return jsonResponse({ text: 'x' })
  }

  const badUrl = await transcribeAudio({ filePath, endpoint: 'ftp://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(badUrl.ok, false)
  assert.match(badUrl.error, /http/)

  const garbage = await transcribeAudio({ filePath, endpoint: 'not a url', apiKey: API_KEY, fetchImpl })
  assert.equal(garbage.ok, false)
  assert.match(garbage.error, /URL/)

  const noKey = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: '   ', fetchImpl })
  assert.equal(noKey.ok, false)
  assert.match(noKey.error, /ApiKey/)

  assert.equal(called, false)
})

test('transcribeAudio wraps network exceptions and never leaks the apiKey', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () => {
    throw new Error(`connect failed for key ${API_KEY}`)
  }

  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /connect failed/)
  assert.equal(result.error.includes(API_KEY), false)
  assert.match(result.error, /<redacted>/)
})

test('transcribeAudio scrubs the apiKey echoed in a provider error body', async () => {
  const filePath = await audioFile()
  const fetchImpl = async () => jsonResponse({ error: { message: `bad key ${API_KEY}` } }, 401)

  const result = await transcribeAudio({ filePath, endpoint: 'https://host/v1', apiKey: API_KEY, fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.error.includes(API_KEY), false)
  assert.match(result.error, /<redacted>/)
})

test('transcribeAudio maps an aborted request to a timeout error', async () => {
  const filePath = await audioFile()
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        { once: true },
      )
    })

  const result = await transcribeAudio({
    filePath,
    endpoint: 'https://host/v1',
    apiKey: API_KEY,
    timeoutMs: 15,
    fetchImpl,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /Таймаут/)
})

// ---------------------------------------------------------------------------
// voicePromptText
// ---------------------------------------------------------------------------

test('voicePromptText formats and trims the transcript', () => {
  assert.equal(voicePromptText('привет'), '🎤 Голосовое сообщение:\nпривет')
  assert.equal(voicePromptText('  привет  '), '🎤 Голосовое сообщение:\nпривет')
  assert.equal(voicePromptText('привет', { prefix: 'Речь' }), 'Речь:\nпривет')
  assert.equal(voicePromptText('привет', { prefix: '   ' }), 'привет')
  assert.equal(voicePromptText(''), '')
  assert.equal(voicePromptText('   '), '')
  assert.equal(voicePromptText(undefined), '')
})

test('voicePromptText truncates the composed prompt to 4000 characters', () => {
  const transcript = 'a'.repeat(5000)
  const result = voicePromptText(transcript)
  assert.equal(VOICE_PROMPT_LIMIT, 4000)
  assert.equal(result.length, 4000)
  assert.equal(result, `🎤 Голосовое сообщение:\n${transcript}`.slice(0, 4000))

  const custom = voicePromptText(transcript, { prefix: 'P' })
  assert.equal(custom.length, 4000)
  assert.ok(custom.startsWith('P:\n'))
})

// ---------------------------------------------------------------------------
// voiceConfigured
// ---------------------------------------------------------------------------

test('voiceConfigured accepts apiKey or apiKeyFile without reading the file', () => {
  const base = {
    voiceTranscribe: true,
    voiceEndpoint: 'https://api.openai.com/v1',
    voiceApiKey: 'sk-key',
  }
  assert.deepEqual(voiceConfigured(base), { ok: true })

  const fileOnly = {
    ...base,
    voiceApiKey: undefined,
    voiceApiKeyFile: '/definitely/does/not/exist/key.txt',
  }
  assert.deepEqual(voiceConfigured(fileOnly), { ok: true })

  assert.deepEqual(voiceConfigured({ ...base, voiceEndpoint: 'https://api.openai.com/v1/audio/transcriptions' }), {
    ok: true,
  })
})

test('voiceConfigured explains why it is disabled', () => {
  const base = {
    voiceTranscribe: true,
    voiceEndpoint: 'https://api.openai.com/v1',
    voiceApiKey: 'sk-key',
  }

  const disabled = voiceConfigured({ ...base, voiceTranscribe: false })
  assert.equal(disabled.ok, false)
  assert.match(disabled.reason, /voiceTranscribe/)

  const stringDisabled = voiceConfigured({ ...base, voiceTranscribe: 'false' })
  assert.equal(stringDisabled.ok, false)

  const noEndpoint = voiceConfigured({ ...base, voiceEndpoint: '   ' })
  assert.equal(noEndpoint.ok, false)
  assert.match(noEndpoint.reason, /voiceEndpoint/)

  const badEndpoint = voiceConfigured({ ...base, voiceEndpoint: 'ftp://host/v1' })
  assert.equal(badEndpoint.ok, false)
  assert.match(badEndpoint.reason, /невалиден/)

  const noKey = voiceConfigured({ ...base, voiceApiKey: '  ', voiceApiKeyFile: '   ' })
  assert.equal(noKey.ok, false)
  assert.match(noKey.reason, /voiceApiKey/)

  const empty = voiceConfigured(undefined)
  assert.equal(empty.ok, false)
  assert.ok(empty.reason.length > 0)
})
