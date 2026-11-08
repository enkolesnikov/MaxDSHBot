/**
 * Text-to-speech for MAX voice replies.
 *
 * Works with any OpenAI-compatible `/audio/speech` endpoint (OpenAI or a
 * gateway). Zero dependencies; `fetchImpl` is injectable for tests. The API key
 * never appears in errors or logs.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_MAX_CHARS = 600
const SPEECH_SUFFIX = '/audio/speech'
const CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
}

export function resolveTtsEndpoint(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (raw === '') throw new Error('TTS endpoint is empty')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid TTS endpoint: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('TTS endpoint must be http(s)')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith(SPEECH_SUFFIX)) return url.toString()
  url.pathname = `${pathname}${SPEECH_SUFFIX}`
  return url.toString()
}

/** Strip markdown/code/links and truncate to a speakable limit. */
export function speakableText(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  let value = String(text ?? '')
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`[^`\n]*`/g, ' ')
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  value = value.replace(/https?:\/\/\S+/gi, ' ')
  value = value.replace(/^[ \t]{0,3}(#{1,6}|[-*+]|>|\d+[.)])\s+/gm, '')
  value = value.replace(/[*_~|>#]/g, '')
  value = value.replace(/\s+/g, ' ').trim()
  const limit = Math.max(20, Number(maxChars) || DEFAULT_MAX_CHARS)
  if (value.length <= limit) return value
  const cut = value.slice(0, limit)
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('; '))
  const trimmed = boundary > limit * 0.5 ? cut.slice(0, boundary + 1) : cut
  return `${trimmed.trim()}…`
}

/** Whether the config has enough fields for TTS. */
export function ttsConfigured(config = {}) {
  if (config.voiceTts !== true) return { ok: false, reason: 'voiceTts is off' }
  const endpoint = config.voiceTtsEndpoint || config.voiceEndpoint
  const key = config.voiceTtsApiKey || config.voiceApiKey
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return { ok: false, reason: 'TTS endpoint is not set' }
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, reason: 'TTS api key is not set' }
  return { ok: true }
}

/** Decide whether one final answer should be spoken. */
export function shouldSpeak(text, config = {}) {
  const check = ttsConfigured(config)
  if (!check.ok) return { ok: false, reason: check.reason }
  const mode = config.voiceTtsMode === 'always' ? 'always' : config.voiceTtsMode === 'off' ? 'off' : 'short'
  if (mode === 'off') return { ok: false, reason: 'voiceTtsMode is off' }
  const speakable = speakableText(text, { maxChars: config.voiceTtsMaxChars })
  if (speakable === '') return { ok: false, reason: 'nothing speakable' }
  if (mode === 'short') {
    const limit = Math.max(20, Number(config.voiceTtsMaxChars) || DEFAULT_MAX_CHARS)
    if (String(text ?? '').trim().length > limit) return { ok: false, reason: 'answer is longer than voiceTtsMaxChars' }
  }
  return { ok: true, text: speakable }
}

/**
 * Synthesize one text into an audio buffer.
 * @returns {Promise<{ok:true, buffer:Buffer, contentType:string}|{ok:false, error:string}>}
 */
export async function synthesizeSpeech({
  text,
  endpoint,
  apiKey,
  model = 'gpt-4o-mini-tts',
  voice = 'alloy',
  format = 'mp3',
  speed,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return { ok: false, error: 'TTS api key is empty' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is unavailable' }
  let url
  try {
    url = resolveTtsEndpoint(endpoint)
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
  const speakable = speakableText(text, { maxChars })
  if (speakable === '') return { ok: false, error: 'nothing speakable' }
  const formatName = ['mp3', 'opus', 'aac', 'flac', 'wav'].includes(format) ? format : 'mp3'
  const body = {
    model: String(model || 'gpt-4o-mini-tts'),
    voice: String(voice || 'alloy'),
    input: speakable,
    response_format: formatName,
  }
  const speedValue = Number(speed)
  if (Number.isFinite(speedValue) && speedValue > 0) body.speed = speedValue

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, error: `TTS request failed: ${error?.message || String(error)}` }
  }
  if (!response || typeof response.ok !== 'boolean') return { ok: false, error: 'invalid TTS response' }
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      detail = ''
    }
    return { ok: false, error: `TTS endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` }
  }
  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return { ok: false, error: `cannot read TTS audio: ${error?.message || String(error)}` }
  }
  if (buffer.length === 0) return { ok: false, error: 'TTS returned empty audio' }
  if (buffer.length > 50 * 1024 * 1024) return { ok: false, error: 'TTS audio is too large' }
  const contentType = response.headers?.get?.('content-type') || CONTENT_TYPES[formatName] || 'audio/mpeg'
  return { ok: true, buffer, contentType }
}

/** Write an audio buffer to a private temp file (for transports needing a path). */
export function writeTempAudio(buffer, { format = 'mp3' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-max-tts-'))
  const file = join(dir, `speech.${format}`)
  writeFileSync(file, buffer, { mode: 0o600 })
  return {
    file,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    },
  }
}
