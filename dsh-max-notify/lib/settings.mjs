/**
 * Safe settings overlay for dsh-max-notify.
 *
 * Host-only JSON surface (consumed by the DSH client page):
 *   GET  /max-notify/settings.json  → { ok, values, status, version }
 *   POST /max-notify/settings.json  → validated overlay saved to JSON
 *
 * Authentication is handled by the host before `createSettingsApi` is called
 * (see the webServer route registration in index.js); this module never sees secrets.
 * Only the allowlisted, non-secret preferences in SETTINGS_KEYS are editable.
 * The overlay lives outside the repository (for example
 * `$DSH_HOME/max-notify/config.json`), is written atomically, always gets mode
 * 0600 and its directory is forced to 0700 (see `lib/fs-safe.mjs`). Secrets (bot
 * token, API keys) never pass through this module.
 */
import { chmodSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, writePrivateFile } from './fs-safe.mjs'
import { SETTINGS_DEFAULTS, SETTINGS_KEYS, coerceValue } from './settings-validate.mjs'

// The rule table and validators live in the pure `settings-validate.mjs` module
// so `lib/config.mjs` (private profile) applies exactly the same rules as this
// overlay. Re-exported here because the GUI/integration imports them from here.
export { SETTINGS_DEFAULTS, SETTINGS_KEYS }

export const SETTINGS_JSON_PATH = '/max-notify/settings.json'

/** Maximum accepted JSON body for POST, in bytes. */
export const SETTINGS_BODY_LIMIT = 64 * 1024

/** Resolve the overlay path: explicit config path, or `$DSH_HOME/max-notify/config.json`. */
export function resolveSettingsFile(config = {}) {
  if (typeof config.settingsFile === 'string' && config.settingsFile.trim() !== '') return config.settingsFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'config.json')
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
  // Every missing ancestor and the overlay directory itself become 0700, even
  // when created by an older release with a broader mode.
  ensurePrivateDir(directory)
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writePrivateFile(tmp, `${JSON.stringify(sanitized.values, null, 2)}\n`)
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
 * the webServer admission layer (`auth: 'required'`), so the handler itself
 * performs no token check.
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
