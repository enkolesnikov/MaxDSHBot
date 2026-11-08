import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveTtsEndpoint,
  shouldSpeak,
  speakableText,
  synthesizeSpeech,
  ttsConfigured,
} from '../lib/tts.mjs'

test('resolveTtsEndpoint appends /audio/speech once and validates scheme', () => {
  assert.equal(resolveTtsEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/audio/speech')
  assert.equal(resolveTtsEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/audio/speech')
  assert.equal(
    resolveTtsEndpoint('https://api.openai.com/v1/audio/speech'),
    'https://api.openai.com/v1/audio/speech',
  )
  assert.throws(() => resolveTtsEndpoint('ftp://example.test'), /http/)
  assert.throws(() => resolveTtsEndpoint(''), /empty/)
})

test('speakableText strips markdown/code/links and truncates', () => {
  const text = '# Заголовок\n\n**Готово** `код` [ссылка](https://example.test)\n\n```js\nconst x = 1\n```\n\n- пункт'
  const spoken = speakableText(text)
  assert.doesNotMatch(spoken, /#|\*|`|https:\/\//)
  assert.match(spoken, /Заголовок/)
  assert.match(spoken, /Готово/)
  assert.ok(speakableText('а'.repeat(1000), { maxChars: 100 }).length <= 101)
  assert.equal(speakableText(''), '')
})

test('ttsConfigured and shouldSpeak honor mode and limits', () => {
  assert.equal(ttsConfigured({}).ok, false)
  assert.equal(ttsConfigured({ voiceTts: true, voiceEndpoint: 'https://x', voiceApiKey: 'k' }).ok, true)
  assert.equal(shouldSpeak('привет', { voiceTts: true, voiceEndpoint: 'https://x', voiceApiKey: 'k' }).ok, true)
  assert.equal(
    shouldSpeak('очень длинный ответ, который точно длиннее двадцати символов', {
      voiceTts: true,
      voiceEndpoint: 'https://x',
      voiceApiKey: 'k',
      voiceTtsMode: 'short',
      voiceTtsMaxChars: 5,
    }).ok,
    false,
  )
  assert.equal(
    shouldSpeak('длинно', {
      voiceTts: true,
      voiceEndpoint: 'https://x',
      voiceApiKey: 'k',
      voiceTtsMode: 'always',
      voiceTtsMaxChars: 5,
    }).ok,
    true,
  )
})

test('synthesizeSpeech posts JSON and returns an audio buffer', async () => {
  let captured
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      async arrayBuffer() {
        return new Uint8Array([1, 2, 3]).buffer
      },
    }
  }
  const result = await synthesizeSpeech({
    text: 'привет',
    endpoint: 'https://api.example.test/v1',
    apiKey: 'secret',
    fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.deepEqual([...result.buffer], [1, 2, 3])
  assert.equal(captured.body.model, 'gpt-4o-mini-tts')
  assert.equal(captured.body.response_format, 'mp3')
  assert.equal(captured.options.headers.Authorization, 'Bearer secret')
  assert.match(captured.url, /\/audio\/speech$/)
})

test('synthesizeSpeech returns structured errors', async () => {
  assert.equal((await synthesizeSpeech({ text: 'x', endpoint: 'https://x', apiKey: '' })).ok, false)
  const http = await synthesizeSpeech({
    text: 'x',
    endpoint: 'https://x/v1',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return 'boom' } }),
  })
  assert.equal(http.ok, false)
  assert.match(http.error, /500/)
  const empty = await synthesizeSpeech({
    text: '   ',
    endpoint: 'https://x/v1',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, async arrayBuffer() { return new ArrayBuffer(0) } }),
  })
  assert.equal(empty.ok, false)
})
