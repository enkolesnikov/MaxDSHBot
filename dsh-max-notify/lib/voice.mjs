/**
 * Optional voice/audio transcription for MAX attachments.
 *
 * Pure module: it knows nothing about MAX or DSH. Callers save an attachment to
 * disk and pass its path together with an OpenAI-compatible endpoint
 * (`/audio/transcriptions`). Network access is injected via `fetchImpl`, so
 * tests never touch the network. The API key is never logged or embedded in
 * returned error strings.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

export const VOICE_PROMPT_LIMIT = 4000
export const DEFAULT_VOICE_MODEL = 'whisper-1'
export const DEFAULT_VOICE_MAX_BYTES = 25 * 1024 * 1024
export const DEFAULT_VOICE_TIMEOUT_MS = 60000

const TRANSCRIPTIONS_PATH = '/audio/transcriptions'

const MIME_BY_EXTENSION = {
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
}

function mimeFor(filename) {
  const dot = String(filename ?? '').toLowerCase().lastIndexOf('.')
  return (dot >= 0 && MIME_BY_EXTENSION[String(filename).toLowerCase().slice(dot)]) || 'application/octet-stream'
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** Remove the exact API key from an error message (defence in depth). */
function scrub(message, apiKey) {
  const text = String(message ?? '')
  const key = typeof apiKey === 'string' ? apiKey : ''
  return key === '' ? text : text.split(key).join('<redacted>')
}

/**
 * Build the transcription URL from an API base.
 *
 * Accepts `https://api.openai.com/v1`, `https://host/v1/` or an already
 * complete `.../audio/transcriptions` URL. Only http(s) endpoints are allowed;
 * anything else throws a `TypeError`.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveVoiceEndpoint(baseUrl) {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  if (raw === '') throw new TypeError('voice endpoint не задан')

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(`voice endpoint не является URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`voice endpoint должен быть http(s), получено: ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('voice endpoint не должен содержать логин/пароль')
  }

  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith(TRANSCRIPTIONS_PATH) ? path : `${path}${TRANSCRIPTIONS_PATH}`
  return url.toString()
}

function describeHttpFailure({ status, statusText, payload, raw }) {
  const detail =
    (typeof payload?.error?.message === 'string' && payload.error.message.trim()) ||
    (typeof payload?.message === 'string' && payload.message.trim()) ||
    (typeof raw === 'string' ? raw.trim().slice(0, 300) : '')
  const head = status > 0 ? `HTTP ${status}` : 'HTTP ошибка'
  const tail = detail || String(statusText ?? '').trim()
  return `${head}${tail ? `: ${tail}` : ''}`.slice(0, 500)
}

/**
 * Transcribe one audio file through an OpenAI-compatible endpoint.
 *
 * Never throws: every failure is returned as `{ ok: false, error }`.
 *
 * @param {object} options
 * @param {string} options.filePath - local audio file.
 * @param {string} options.endpoint - API base (`.../v1`) or full transcriptions URL.
 * @param {string} options.apiKey - bearer token; never logged.
 * @param {string} [options.model]
 * @param {string} [options.language]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
 */
export async function transcribeAudio({
  filePath,
  endpoint,
  apiKey,
  model = DEFAULT_VOICE_MODEL,
  language,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_VOICE_TIMEOUT_MS,
  maxBytes = DEFAULT_VOICE_MAX_BYTES,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (key === '') return { ok: false, error: 'voiceApiKey не задан' }

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: 'fetch недоступен' }

  let url
  try {
    url = resolveVoiceEndpoint(endpoint)
  } catch (error) {
    return { ok: false, error: scrub(error?.message, key) }
  }

  if (typeof filePath !== 'string' || filePath === '') {
    return { ok: false, error: 'filePath не задан' }
  }
  const limit = positiveNumber(maxBytes, DEFAULT_VOICE_MAX_BYTES)

  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: `Файл не найден: ${filePath}` }
    return { ok: false, error: `Не удалось прочитать файл: ${scrub(error?.message, key)}` }
  }
  if (!info.isFile()) return { ok: false, error: `Не файл: ${filePath}` }
  if (info.size > limit) {
    return { ok: false, error: `Файл больше лимита: ${info.size} > ${limit} байт` }
  }

  let buffer
  try {
    buffer = await readFile(filePath)
  } catch (error) {
    return { ok: false, error: `Не удалось прочитать файл: ${scrub(error?.message, key)}` }
  }
  if (buffer.length === 0) return { ok: false, error: 'Файл пуст' }
  if (buffer.length > limit) {
    return { ok: false, error: `Файл больше лимита: ${buffer.length} > ${limit} байт` }
  }

  if (typeof FormData !== 'function' || typeof Blob !== 'function') {
    return { ok: false, error: 'текущая среда Node.js не поддерживает FormData/Blob' }
  }

  const filename = basename(filePath)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeFor(filename) }), filename)
  form.append('model', String(model ?? '').trim() || DEFAULT_VOICE_MODEL)
  const lang = typeof language === 'string' ? language.trim() : ''
  if (lang !== '') form.append('language', lang)
  form.append('response_format', 'json')

  const timeout = Math.min(positiveNumber(timeoutMs, DEFAULT_VOICE_TIMEOUT_MS), 2_147_483_647)
  let signal
  try {
    signal = AbortSignal.timeout(timeout)
  } catch (error) {
    return { ok: false, error: `Не удалось создать таймаут: ${scrub(error?.message, key)}` }
  }

  let response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, error: `Таймаут запроса (${timeout} мс)` }
    }
    return { ok: false, error: `Сеть: ${scrub(error?.message || String(error), key)}` }
  }

  if (!response || typeof response !== 'object') {
    return { ok: false, error: 'fetch не вернул ответ' }
  }

  const status = Number(response.status) || 0
  const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300

  let raw = ''
  let payload
  try {
    if (typeof response.text === 'function') {
      raw = String((await response.text()) ?? '')
      if (raw.trim() !== '') {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = undefined
        }
      }
    }
    // Fake/non-standard responses may only expose json(); a real Response has
    // already been consumed by text() above, so this call fails harmlessly.
    if (payload === undefined && typeof response.json === 'function') {
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
    }
  } catch (error) {
    return { ok: false, error: `Не удалось прочитать ответ: ${scrub(error?.message, key)}` }
  }

  if (!ok) {
    return {
      ok: false,
      error: scrub(
        describeHttpFailure({
          status,
          statusText: response.statusText,
          payload,
          raw,
        }),
        key,
      ),
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: `Ответ транскрипции не JSON (HTTP ${status})` }
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (text === '') return { ok: false, error: 'Пустой текст в ответе транскрипции' }

  return { ok: true, text }
}

/**
 * Prompt fragment for the agent: a labelled transcript capped at 4000 chars.
 * An empty transcript yields an empty string (nothing to forward).
 *
 * @param {string} transcript
 * @param {{prefix?: string}} [options]
 * @returns {string}
 */
export function voicePromptText(transcript, { prefix = '🎤 Голосовое сообщение' } = {}) {
  const text = String(transcript ?? '').trim()
  if (text === '') return ''
  const label = String(prefix ?? '').trim()
  const composed = label === '' ? text : `${label}:\n${text}`
  return composed.length <= VOICE_PROMPT_LIMIT ? composed : composed.slice(0, VOICE_PROMPT_LIMIT)
}

function enabledFlag(value) {
  if (typeof value === 'string') {
    return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
  }
  return Boolean(value)
}

/**
 * Whether voice transcription can be used with this config.
 * `voiceApiKeyFile` is only checked for presence — it is never read here.
 *
 * Expected fields: `voiceTranscribe`, `voiceEndpoint`, `voiceApiKey` or
 * `voiceApiKeyFile`.
 *
 * @param {object} config
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function voiceConfigured(config) {
  if (!config || typeof config !== 'object') return { ok: false, reason: 'нет настроек плагина' }
  if (!enabledFlag(config.voiceTranscribe)) return { ok: false, reason: 'voiceTranscribe выключен' }

  const endpoint = typeof config.voiceEndpoint === 'string' ? config.voiceEndpoint.trim() : ''
  if (endpoint === '') return { ok: false, reason: 'voiceEndpoint не задан' }
  try {
    resolveVoiceEndpoint(endpoint)
  } catch (error) {
    return { ok: false, reason: `voiceEndpoint невалиден: ${error?.message || String(error)}` }
  }

  const apiKey = typeof config.voiceApiKey === 'string' ? config.voiceApiKey.trim() : ''
  const apiKeyFile = typeof config.voiceApiKeyFile === 'string' ? config.voiceApiKeyFile.trim() : ''
  if (apiKey === '' && apiKeyFile === '') {
    return { ok: false, reason: 'voiceApiKey и voiceApiKeyFile не заданы' }
  }

  return { ok: true }
}
