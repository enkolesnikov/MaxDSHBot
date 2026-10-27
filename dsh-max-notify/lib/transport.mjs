/**
 * Dependency-free MAX messenger bot API transport (Node >= 20, ESM).
 *
 * MAX API notes (https://dev.max.ru/docs-api):
 *  - Base URL: https://platform-api2.max.ru (NOT platform-api.max.ru).
 *  - Auth: `Authorization: <access_token>` header (query token is unsupported).
 *  - POST /messages?chat_id=<int> | ?user_id=<int>, JSON body
 *    { text, format: 'markdown'|'html'|null, notify, disable_link_preview, attachments }.
 *  - text <= 4000 chars, at most 2 messages/second per chat.
 *  - TLS: the server chains to the Russian Trusted Root CA (Минцифры), which is
 *    missing from most system trust stores, so Node/curl reject it by default.
 *    We ship certs/ca-chain.pem (Russian Trusted Sub CA + Russian Trusted Root CA)
 *    and pass it explicitly via https.request({ ca }).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

export const MAX_API_BASE = 'https://platform-api2.max.ru'
export const MAX_TEXT_LIMIT = 4000
export const MAX_MESSAGES_PER_SECOND = 2

const USER_AGENT = 'dsh-max-notify/0.1.0'
const BUNDLED_CA_URL = new URL('../certs/ca-chain.pem', import.meta.url)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Load the bundled Russian Trusted CA chain; returns undefined when absent. */
export function loadBundledCa() {
  try {
    return readFileSync(fileURLToPath(BUNDLED_CA_URL), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Split text into chunks of at most `limit` UTF-16 code units, preferring
 * paragraph (`\n\n`), then line (`\n`), then sentence, then word boundaries,
 * and never splitting a surrogate pair.
 */
export function splitText(text, limit = MAX_TEXT_LIMIT) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (limit < 16) throw new RangeError('limit must be >= 16')
  if (text.length <= limit) return [text]

  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = -1
    const window = rest.slice(0, limit)
    for (const marker of ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ']) {
      const idx = window.lastIndexOf(marker)
      if (idx >= Math.floor(limit / 2)) {
        cut = idx + marker.length
        break
      }
    }
    if (cut <= 0) cut = limit
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Build an Error carrying HTTP status, MAX error code, response body and retry hint. */
function httpError(status, raw, json, retryAfterMs) {
  const code = json?.code ?? json?.error?.code
  const message = json?.message ?? json?.error?.message ?? raw?.slice(0, 300) ?? `HTTP ${status}`
  const error = new Error(`MAX API ${status}${code ? ` ${code}` : ''}: ${message}`)
  error.name = 'MaxApiError'
  error.status = status
  if (code !== undefined) error.code = code
  error.response = json ?? raw
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs
  return error
}

function parseRetryAfter(header) {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * Create a MAX API client.
 *
 * @param {object} options
 * @param {string} options.token - bot access token (required).
 * @param {string} [options.baseUrl] - API base, default https://platform-api2.max.ru.
 * @param {string|Buffer|Array<string|Buffer>} [options.ca] - explicit CA PEM(s).
 * @param {string} [options.caFile] - PEM file to trust instead of the bundled chain.
 * @param {boolean} [options.insecureTls] - disable TLS verification (debug only).
 * @param {number} [options.timeoutMs] - per-request timeout, default 15000.
 * @param {number} [options.maxRetries] - retries for 429/5xx/network errors, default 3.
 * @param {number} [options.minIntervalMs] - min gap between message sends, default 600.
 * @param {(level: string, message: string, extra?: unknown) => void} [options.log] - optional log sink.
 */
export function createMaxClient(options = {}) {
  const {
    token,
    baseUrl = MAX_API_BASE,
    ca,
    caFile,
    insecureTls = false,
    timeoutMs = 15000,
    maxRetries = 3,
    minIntervalMs = 600,
    log,
  } = options

  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('MAX bot token is required (config.botToken or MAX_BOT_TOKEN)')
  }

  let caValue = ca
  if (caValue === undefined) {
    if (caFile) {
      caValue = readFileSync(caFile, 'utf8')
    } else if (!insecureTls) {
      caValue = loadBundledCa()
      if (caValue === undefined) {
        log?.('warn', 'bundled MAX CA chain not found; falling back to the system trust store')
      }
    }
  }

  const request = ({ method, path, query, body }) =>
    new Promise((resolve, reject) => {
      let url
      try {
        url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
      } catch (error) {
        reject(error)
        return
      }
      if (query) {
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
        }
      }
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
      const headers = {
        Authorization: token,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      }
      if (payload) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(payload.length)
      }
      const req = https.request(
        {
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers,
          ca: caValue,
          rejectUnauthorized: !insecureTls,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let json
            try {
              json = raw ? JSON.parse(raw) : undefined
            } catch {
              json = undefined
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json)
              return
            }
            reject(httpError(res.statusCode, raw, json, parseRetryAfter(res.headers['retry-after'])))
          })
          res.on('error', reject)
        },
      )
      req.on('timeout', () => req.destroy(new Error(`MAX API request timed out after ${timeoutMs}ms`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })

  const RETRIABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])

  async function withRetry(fn) {
    let attempt = 0
    for (;;) {
      try {
        return await fn()
      } catch (error) {
        attempt += 1
        const status = error?.status
        const retriable =
          status === 429 ||
          (typeof status === 'number' && status >= 500 && status < 600) ||
          RETRIABLE_CODES.has(error?.code)
        if (!retriable || attempt > maxRetries) throw error
        const delay = error?.retryAfterMs ?? Math.min(500 * 2 ** attempt, 8000)
        log?.('warn', `MAX API retry ${attempt}/${maxRetries} in ${delay}ms: ${error.message}`)
        await sleep(delay)
      }
    }
  }

  /** GET /me — bot identity; useful as a token sanity check. */
  function getMe() {
    return withRetry(() => request({ method: 'GET', path: 'me' }))
  }

  /** GET /chats/{chatId} — chat metadata; for a dialog it exposes dialog_with_user.user_id. */
  function getChat(chatId) {
    if (chatId === undefined || chatId === null) throw new Error('chatId is required')
    return withRetry(() => request({ method: 'GET', path: `chats/${encodeURIComponent(String(chatId))}` }))
  }

  /** GET /updates — long polling for incoming updates (used by the pairing helper). */
  function getUpdates({ timeout = 0, limit = 100, marker, types } = {}) {
    return withRetry(() =>
      request({
        method: 'GET',
        path: 'updates',
        query: { timeout, limit, marker, types },
      }),
    )
  }

  let lastSendAt = 0

  /**
   * Send one text message (already sized <= 4000 chars).
   * @param {object} params
   * @param {number|string} [params.chatId] - target chat/channel id.
   * @param {number|string} [params.userId] - target user id (dialogs).
   * @param {string} params.text
   * @param {'markdown'|'html'|null} [params.format]
   * @param {boolean} [params.notify]
   * @param {boolean} [params.disableLinkPreview]
   * @param {Array<object>} [params.attachments]
   */
  async function sendMessage({ chatId, userId, text, format, notify, disableLinkPreview, attachments } = {}) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('text is required')
    if (text.length > MAX_TEXT_LIMIT) throw new RangeError(`text exceeds ${MAX_TEXT_LIMIT} chars; use sendText`)
    if (chatId === undefined && userId === undefined) throw new Error('chatId or userId is required')

    const gap = minIntervalMs - (Date.now() - lastSendAt)
    if (gap > 0) await sleep(gap)
    lastSendAt = Date.now()

    const body = { text }
    if (format) body.format = format
    if (notify !== undefined) body.notify = notify
    if (attachments !== undefined) body.attachments = attachments

    const query = chatId !== undefined ? { chat_id: chatId } : { user_id: userId }
    // MAX expects disable_link_preview as a QUERY parameter, not a body field.
    if (disableLinkPreview !== undefined) query.disable_link_preview = disableLinkPreview

    return withRetry(() => request({ method: 'POST', path: 'messages', query, body }))
  }

  /** Send arbitrarily long text, chunked to the 4000-char API limit. */
  async function sendText(params) {
    const { text, ...rest } = params ?? {}
    const chunks = splitText(String(text ?? ''), MAX_TEXT_LIMIT)
    const results = []
    for (const chunk of chunks) {
      results.push(await sendMessage({ ...rest, text: chunk }))
    }
    return results
  }

  return { getMe, getUpdates, getChat, sendMessage, sendText, baseUrl, token }
}

/** Resolve a PEM CA chain path shipped with this package. */
export function bundledCaPath() {
  return fileURLToPath(BUNDLED_CA_URL)
}
