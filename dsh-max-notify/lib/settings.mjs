/**
 * Safe settings overlay for dsh-max-notify.
 *
 * Host-only JSON surface (consumed by the DSH client page):
 *   GET  /max-notify/settings.json  → { ok, values, status, version }
 *   POST /max-notify/settings.json  → validated overlay saved to JSON
 *
 * Authentication is handled by the host before `createSettingsApi` is called
 * (see index.js `connection.requestRejection`); this module never sees secrets.
 * Only the allowlisted, non-secret preferences in SETTINGS_KEYS are editable.
 * The overlay lives outside the repository (for example
 * `$DSH_HOME/max-notify/config.json`), is written atomically and always gets
 * mode 0600. Secrets (bot token, API keys) never pass through this module.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SETTINGS_JSON_PATH = '/max-notify/settings.json'

/** Maximum accepted JSON body for POST, in bytes. */
export const SETTINGS_BODY_LIMIT = 64 * 1024

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on'])
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off'])

/**
 * Allowlist of editable settings with their type and constraints. Every entry
 * also carries the built-in default used when the overlay has no value yet.
 */
export const SETTINGS_KEYS = Object.freeze({
  mode: Object.freeze({ type: 'enum', values: Object.freeze(['all', 'errors', 'mute']), default: 'all' }),
  digestEnabled: Object.freeze({ type: 'boolean', default: false }),
  digestTime: Object.freeze({ type: 'time', default: '21:00' }),
  quietHours: Object.freeze({ type: 'quietHours', default: null }),
  threads: Object.freeze({ type: 'boolean', default: true }),
  tableFiles: Object.freeze({ type: 'boolean', default: true }),
  tableMaxFiles: Object.freeze({ type: 'integer', min: 0, max: 8, default: 4 }),
  notify: Object.freeze({ type: 'boolean', default: true }),
  progress: Object.freeze({ type: 'boolean', default: true }),
  typing: Object.freeze({ type: 'boolean', default: true }),
  messageStyle: Object.freeze({ type: 'enum', values: Object.freeze(['compact', 'detailed']), default: 'compact' }),
  notifySubagents: Object.freeze({ type: 'boolean', default: false }),
  notifyJobs: Object.freeze({ type: 'boolean', default: false }),
  notifyGoals: Object.freeze({ type: 'boolean', default: false }),
  notifyErrors: Object.freeze({ type: 'boolean', default: true }),
  todoProgress: Object.freeze({ type: 'boolean', default: false }),
  approvalTimeoutMs: Object.freeze({ type: 'integer', min: 0, max: 600000, default: 120000 }),
  receiveFiles: Object.freeze({ type: 'boolean', default: true }),
  nativeIncomingImages: Object.freeze({ type: 'boolean', default: true }),
  buttonsPresets: Object.freeze({
    type: 'presets',
    maxItems: 6,
    labelMax: 40,
    promptMax: 500,
    default: Object.freeze([]),
  }),
  voiceTranscribe: Object.freeze({ type: 'boolean', default: false }),
  voiceTts: Object.freeze({ type: 'boolean', default: false }),
  voiceTtsMode: Object.freeze({ type: 'enum', values: Object.freeze(['off', 'short', 'always']), default: 'short' }),
  voiceTtsVoice: Object.freeze({ type: 'string', maxLength: 80, default: 'alloy' }),
  voiceTtsModel: Object.freeze({ type: 'string', maxLength: 80, default: 'gpt-4o-mini-tts' }),
  voiceTtsMaxChars: Object.freeze({ type: 'integer', min: 20, max: 2000, default: 600 }),
})

/** Built-in defaults derived from {@link SETTINGS_KEYS}. */
export const SETTINGS_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(SETTINGS_KEYS).map(([key, definition]) => [key, definition.default])),
)

/** Resolve the overlay path: explicit config path, or `$DSH_HOME/max-notify/config.json`. */
export function resolveSettingsFile(config = {}) {
  if (typeof config.settingsFile === 'string' && config.settingsFile.trim() !== '') return config.settingsFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'config.json')
}

function charLength(value) {
  return Array.from(value).length
}

function normalizeTime(value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return TIME_RE.test(text) ? text : undefined
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (BOOLEAN_TRUE.has(text)) return true
    if (BOOLEAN_FALSE.has(text)) return false
  }
  throw new Error('must be a boolean')
}

function coerceInteger(value, definition) {
  const raw = typeof value === 'string' ? value.trim() : value
  if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('must be an integer')
  if (typeof raw === 'string' && !/^-?\d+$/.test(raw)) throw new Error('must be an integer')
  const number = Number(raw)
  if (!Number.isInteger(number)) throw new Error('must be an integer')
  if (number < definition.min || number > definition.max) {
    throw new Error(`must be between ${definition.min} and ${definition.max}`)
  }
  return number
}

function coercePresets(value, definition) {
  if (!Array.isArray(value)) throw new Error('must be an array of { label, prompt } objects')
  if (value.length > definition.maxItems) throw new Error(`supports at most ${definition.maxItems} items`)
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`item ${index + 1} must be a { label, prompt } object`)
    }
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (label === '' || charLength(label) > definition.labelMax) {
      throw new Error(`item ${index + 1} label must be 1..${definition.labelMax} characters`)
    }
    if (prompt === '' || charLength(prompt) > definition.promptMax) {
      throw new Error(`item ${index + 1} prompt must be 1..${definition.promptMax} characters`)
    }
    return { label, prompt }
  })
}

function coerceHttpsUrl(value) {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('must be an https:// URL or null')
  const text = value.trim()
  if (text === '') return null
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('must be a valid https:// URL or null')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    throw new Error('must be an https:// URL or null')
  }
  return text
}

function coerceValue(definition, value) {
  switch (definition.type) {
    case 'enum': {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (!definition.values.includes(text)) throw new Error(`must be one of ${definition.values.join('|')}`)
      return text
    }
    case 'boolean':
      return coerceBoolean(value)
    case 'time': {
      const time = normalizeTime(value)
      if (time === undefined) throw new Error('must be HH:MM (24-hour)')
      return time
    }
    case 'quietHours': {
      if (value === null) return null
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('must be null or { start, end } with HH:MM times')
      }
      const start = normalizeTime(value.start)
      const end = normalizeTime(value.end)
      if (start === undefined || end === undefined) {
        throw new Error('must be null or { start, end } with HH:MM times')
      }
      return { start, end }
    }
    case 'integer':
      return coerceInteger(value, definition)
    case 'presets':
      return coercePresets(value, definition)
    case 'httpsUrl':
      return coerceHttpsUrl(value)
    case 'string': {
      if (typeof value !== 'string') throw new Error('must be a string')
      const text = value.trim()
      if (charLength(text) > definition.maxLength) {
        throw new Error(`must be a string of at most ${definition.maxLength} characters`)
      }
      return text
    }
    default:
      throw new Error('unsupported setting type')
  }
}

/**
 * Validate and coerce a partial settings patch.
 *
 * Known keys are validated and type-coerced (`"true"` → `true`, `"4"` → `4`).
 * Unknown keys are never copied and are reported in `ignored`; they do not make
 * the patch invalid. `ok` is false only when at least one allowlisted key has an
 * invalid value, while `values` still contains the valid keys of the patch.
 *
 * @param {unknown} patch
 * @returns {{ok: boolean, values: object, errors: string[], ignored: string[]}}
 */
export function sanitizeSettingsPatch(patch) {
  const values = {}
  const errors = []
  const ignored = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, values, errors: ['patch must be a JSON object'], ignored }
  }
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(SETTINGS_KEYS, key)) {
      ignored.push(`unknown setting "${key}" ignored`)
      continue
    }
    try {
      values[key] = coerceValue(SETTINGS_KEYS[key], patch[key])
    } catch (error) {
      errors.push(`${key}: ${error?.message || String(error)}`)
    }
  }
  return { ok: errors.length === 0, values, errors, ignored }
}

/**
 * Read the settings overlay. A missing file, invalid JSON or a non-object root
 * yields `{}`; unknown keys are dropped and invalid known values are skipped.
 */
export function loadSettings(file) {
  if (typeof file !== 'string' || file === '') return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return sanitizeSettingsPatch(parsed).values
  } catch {
    return {}
  }
}

/**
 * Persist the overlay atomically (tmp file + rename) with mode 0600. Only
 * allowlisted valid keys are written; invalid values make the call throw rather
 * than silently overwrite the file with a partial patch.
 *
 * @returns {object} the sanitized values that were written.
 */
export function saveSettings(file, values) {
  if (typeof file !== 'string' || file.trim() === '') throw new TypeError('settings file path is required')
  const sanitized = sanitizeSettingsPatch(values)
  if (!sanitized.ok) throw new Error(`invalid settings: ${sanitized.errors.join('; ')}`)
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(sanitized.values, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // the tmp file may not exist
    }
    throw error
  }
  return sanitized.values
}

/**
 * Return a new config with the valid allowlisted overrides applied. Unknown and
 * invalid override keys are ignored; the source config is never mutated.
 */
export function mergeSettings(config, overrides) {
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const { values } = sanitizeSettingsPatch(overrides)
  return { ...base, ...values }
}

function sendJson(res, status, payload) {
  if (!res || typeof res.end !== 'function') return
  try {
    res.statusCode = status
    if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
    }
    res.end(JSON.stringify(payload))
  } catch {
    // the response may already be closed
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
      req.resume?.()
    }
    const declared = Number(req?.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      const error = new Error(`settings body exceeds ${limit} bytes`)
      error.status = 413
      fail(error)
      return
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        const error = new Error(`settings body exceeds ${limit} bytes`)
        error.status = 413
        fail(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    req.on('aborted', () => {
      const error = new Error('request aborted')
      error.status = 400
      fail(error)
    })
  })
}

/**
 * JSON-only handler for the DSH client page. Authentication is expected to
 * happen before it is called: the host wraps it with
 * `connection.requestRejection`, so the handler itself performs no token check.
 */
export function createSettingsApi({ file, getValues, getStatus, getVersion, logger, onSave } = {}) {
  const snapshot = async (getter) => (typeof getter === 'function' ? await getter() : undefined)
  return async function settingsApi(req, res) {
    const method = String(req?.method ?? '').toUpperCase()
    if (method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        values: (await snapshot(getValues)) ?? {},
        status: (await snapshot(getStatus)) ?? {},
        version: await snapshot(getVersion),
      })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let raw
    try {
      raw = await readBody(req, SETTINGS_BODY_LIMIT)
    } catch (error) {
      const tooLarge = error?.status === 413
      sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        error: tooLarge ? 'request body too large' : 'cannot read request body',
      })
      return
    }
    let patch
    try {
      patch = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON' })
      return
    }
    const sanitized = sanitizeSettingsPatch(patch)
    if (!sanitized.ok) {
      sendJson(res, 400, {
        ok: false,
        error: sanitized.errors.join('; '),
        errors: sanitized.errors,
        ignored: sanitized.ignored,
      })
      return
    }
    try {
      const saved = saveSettings(file, mergeSettings(loadSettings(file), sanitized.values))
      const current = (await snapshot(getValues)) ?? {}
      let applied
      let restartRequired = true
      if (typeof onSave === 'function') {
        try {
          const outcome = await onSave(saved)
          applied = outcome?.applied
          restartRequired = outcome?.restartRequired === true
        } catch (error) {
          logger?.warn?.('cannot apply MAX settings live: %s', error?.message || String(error))
        }
      }
      const payload = { ok: true, values: { ...current, ...saved }, restartRequired }
      if (applied) payload.applied = applied
      if (sanitized.ignored.length > 0) payload.ignored = sanitized.ignored
      sendJson(res, 200, payload)
    } catch (error) {
      logger?.warn?.('cannot save MAX settings: %s', error?.message || String(error))
      sendJson(res, 500, { ok: false, error: 'cannot save settings' })
    }
  }
}
