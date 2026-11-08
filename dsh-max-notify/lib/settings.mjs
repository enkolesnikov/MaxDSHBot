/**
 * Safe settings overlay and GUI for dsh-max-notify.
 *
 * Two host-only surfaces (no DSH client bundle):
 *   GET  /max-notify/settings?token=…       → standalone HTML page
 *   GET  /max-notify/settings.json?token=…  → { ok, values, status, version }
 *   POST /max-notify/settings.json?token=…  → validated overlay saved to JSON
 *
 * Only the allowlisted, non-secret preferences in SETTINGS_KEYS are editable.
 * The overlay lives outside the repository (for example
 * `$DSH_HOME/max-notify/config.json`), is written atomically and always gets
 * mode 0600. Secrets (bot token, API keys) never pass through this module.
 *
 * `createSettingsApi`/`resolveSettingsFile` are kept for the older DSH client
 * page integration, which authenticates before calling the JSON handler; new
 * integrations should use `createSettingsHandler`, which owns token checks, the
 * HTML page and both routes.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SETTINGS_HTML_PATH = '/max-notify/settings'
export const SETTINGS_JSON_PATH = '/max-notify/settings.json'

/** Maximum accepted JSON body for POST, in bytes. */
export const SETTINGS_BODY_LIMIT = 64 * 1024

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on'])
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off'])

/**
 * Allowlist of editable settings with their type and constraints. Every entry
 * also carries the built-in default shown by the page when the overlay has no
 * value yet.
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
  voiceEndpoint: Object.freeze({ type: 'httpsUrl', default: null }),
  voiceModel: Object.freeze({ type: 'string', maxLength: 80, default: 'whisper-1' }),
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

/** Constant-time comparison for equal-length, non-empty secrets. */
export function safeEqual(provided, expected) {
  const left = Buffer.from(String(provided ?? ''))
  const right = Buffer.from(String(expected ?? ''))
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right)
}

function effectiveSettings(file) {
  const saved = loadSettings(file)
  const presets = Array.isArray(saved.buttonsPresets) ? saved.buttonsPresets : SETTINGS_DEFAULTS.buttonsPresets
  return {
    ...SETTINGS_DEFAULTS,
    ...saved,
    quietHours: saved.quietHours ? { ...saved.quietHours } : null,
    buttonsPresets: presets.map((preset) => ({ ...preset })),
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (!res || typeof res.end !== 'function') return
  try {
    res.statusCode = status
    if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
    }
    res.end(JSON.stringify(payload))
  } catch {
    // the response may already be closed
  }
}

function sendHtml(res, status, html) {
  if (!res || typeof res.end !== 'function') return
  try {
    res.statusCode = status
    if (typeof res.setHeader === 'function') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('x-frame-options', 'DENY')
      res.setHeader(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      )
    }
    res.end(html)
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

async function callStatus(getter, logger, label) {
  if (typeof getter !== 'function') return null
  try {
    return await getter()
  } catch (error) {
    logger?.warn?.('cannot read settings %s: %s', label, error?.message || String(error))
    return null
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function formatStatus(status) {
  if (status === null || status === undefined) return '—'
  if (typeof status === 'string') return status
  try {
    return JSON.stringify(status, null, 2)
  } catch {
    return '[status is not serializable]'
  }
}

function checkboxField(id, label, value, hint = '') {
  return `<label class="check"><input type="checkbox" id="${id}"${value ? ' checked' : ''}><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span></label>`
}

function timeField(id, label, value) {
  return `<label class="field"><span>${label}</span><input type="time" id="${id}" value="${escapeHtml(value)}"></label>`
}

function numberField(id, label, value, min, max) {
  return `<label class="field"><span>${label}</span><input type="number" id="${id}" min="${min}" max="${max}" step="1" value="${escapeHtml(value)}"></label>`
}

function textField(id, label, value, { type = 'text', placeholder = '' } = {}) {
  return `<label class="field"><span>${label}</span><input type="${type}" id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" spellcheck="false" autocomplete="off"></label>`
}

function renderSettingsPage({ values, status, version, token }) {
  const quiet = values.quietHours
  const endpoint = `${SETTINGS_JSON_PATH}?token=${encodeURIComponent(token)}`
  const presets = JSON.stringify(values.buttonsPresets, null, 2)
  const modeOptions = SETTINGS_KEYS.mode.values
    .map((mode) => `<option value="${mode}"${values.mode === mode ? ' selected' : ''}>${mode}</option>`)
    .join('')
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>dsh-max-notify · настройки</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0d1015; color: #e6e9ef; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 28px 18px 60px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #93a0b4; margin: 0 0 14px; }
.card { background: #151a22; border: 1px solid #232b38; border-radius: 12px; padding: 18px; margin: 14px 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > span { color: #b9c3d3; font-size: 13px; }
input, select, textarea { background: #0f141c; border: 1px solid #2b3547; color: #e6e9ef; border-radius: 8px; padding: 8px 10px; font: inherit; }
textarea { width: 100%; min-height: 120px; resize: vertical; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
input:focus, select:focus, textarea:focus { outline: 2px solid #2f6fed; outline-offset: 1px; }
input[type=checkbox] { width: 18px; height: 18px; accent-color: #3f8cff; }
.check { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; }
.check small { display: block; color: #7d8899; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; color: #aeb9c9; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: #7d8899; font-size: 13px; }
.actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 18px; }
button { background: #2f6fed; color: #fff; border: 0; border-radius: 9px; padding: 11px 20px; font: inherit; font-weight: 600; cursor: pointer; }
button:hover { background: #3f7df3; }
button:disabled { opacity: .6; cursor: default; }
.ok { color: #4ade80; }
.error { color: #f87171; }
code { color: #c7d2fe; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
<header>
<h1>⚙️ dsh-max-notify</h1>
<p class="muted">Безопасные настройки плагина · версия <b>${escapeHtml(version ?? '—')}</b></p>
</header>
<section class="card">
<h2>Статус</h2>
<pre>${escapeHtml(formatStatus(status))}</pre>
</section>
<form id="settings-form" data-endpoint="${escapeHtml(endpoint)}">
<section class="card">
<h2>Уведомления</h2>
${checkboxField('notify', 'Отправлять уведомления', values.notify)}
<label class="field" style="margin-top:10px"><span>Режим</span><select id="mode">${modeOptions}</select></label>
<div class="grid" style="margin-top:10px">
${timeField('digestTime', 'Время дайджеста', values.digestTime)}
</div>
${checkboxField('digestEnabled', 'Ежедневный дайджест', values.digestEnabled)}
<hr style="border:0;border-top:1px solid #232b38;margin:14px 0">
${checkboxField('quietEnabled', 'Тихие часы', Boolean(quiet), 'Уведомления не отправляются в этом интервале')}
<div class="grid">
${timeField('quietStart', 'Начало', quiet?.start ?? '')}
${timeField('quietEnd', 'Конец', quiet?.end ?? '')}
</div>
</section>
<section class="card">
<h2>Ответы и файлы</h2>
${checkboxField('threads', 'Reply-ветки', values.threads)}
${checkboxField('tableFiles', 'Таблицы отдельными файлами', values.tableFiles)}
<div class="grid">
${numberField('tableMaxFiles', 'Максимум таблиц-файлов', values.tableMaxFiles, 0, 8)}
${numberField('approvalTimeoutMs', 'Таймаут подтверждений, мс', values.approvalTimeoutMs, 0, 600000)}
</div>
${checkboxField('progress', 'Карточка прогресса', values.progress)}
${checkboxField('typing', 'Индикатор «печатает»', values.typing)}
${checkboxField('receiveFiles', 'Принимать файлы из MAX', values.receiveFiles)}
${checkboxField('nativeIncomingImages', 'Нативные входящие изображения', values.nativeIncomingImages)}
</section>
<section class="card">
<h2>Быстрые кнопки</h2>
<label class="field"><span>JSON-массив до 6 пресетов: <code>[{"label":"…","prompt":"…"}]</code></span>
<textarea id="buttonsPresets" spellcheck="false">${escapeHtml(presets)}</textarea></label>
<p class="muted">label ≤ 40 символов, prompt ≤ 500.</p>
</section>
<section class="card">
<h2>Голос</h2>
${checkboxField('voiceTranscribe', 'Транскрибировать голосовые', values.voiceTranscribe, 'Нужен voiceEndpoint и ключ в приватном профиле')}
<div class="grid">
${textField('voiceEndpoint', 'HTTPS endpoint', values.voiceEndpoint ?? '', { type: 'url', placeholder: 'https://…' })}
${textField('voiceModel', 'Модель', values.voiceModel, { placeholder: 'whisper-1' })}
</div>
</section>
<div class="actions">
<button type="submit" id="save">Сохранить</button>
<span id="result" class="muted" role="status"></span>
</div>
</form>
<p class="muted">Значения сохраняются вне репозитория и применяются после перезапуска строки плагина. Секреты здесь не редактируются.</p>
</main>
<script>
(function () {
  var form = document.getElementById('settings-form')
  var result = document.getElementById('result')
  function checked(id) { return document.getElementById(id).checked }
  function text(id) { return document.getElementById(id).value.trim() }
  function number(id) { return Number(document.getElementById(id).value) }
  function show(message, ok) { result.textContent = message; result.className = ok ? 'ok' : 'error' }
  form.addEventListener('submit', async function (event) {
    event.preventDefault()
    var presets
    try {
      presets = JSON.parse(text('buttonsPresets') || '[]')
    } catch (error) {
      show('Пресеты: невалидный JSON', false)
      return
    }
    var payload = {
      mode: text('mode'),
      digestEnabled: checked('digestEnabled'),
      digestTime: text('digestTime'),
      quietHours: checked('quietEnabled') ? { start: text('quietStart'), end: text('quietEnd') } : null,
      threads: checked('threads'),
      tableFiles: checked('tableFiles'),
      tableMaxFiles: number('tableMaxFiles'),
      notify: checked('notify'),
      progress: checked('progress'),
      typing: checked('typing'),
      approvalTimeoutMs: number('approvalTimeoutMs'),
      receiveFiles: checked('receiveFiles'),
      nativeIncomingImages: checked('nativeIncomingImages'),
      buttonsPresets: presets,
      voiceTranscribe: checked('voiceTranscribe'),
      voiceEndpoint: text('voiceEndpoint') || null,
      voiceModel: text('voiceModel')
    }
    var button = document.getElementById('save')
    button.disabled = true
    show('Сохранение…', true)
    try {
      var response = await fetch(form.dataset.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin'
      })
      var data = await response.json().catch(function () { return { ok: false, error: 'HTTP ' + response.status } })
      if (!response.ok || !data.ok) {
        show((data.errors || [data.error || ('HTTP ' + response.status)]).join('; '), false)
        return
      }
      var note = 'Сохранено. Изменения применятся после перезапуска плагина.'
      if (data.ignored && data.ignored.length) note += ' ' + data.ignored.join('; ')
      show(note, true)
    } catch (error) {
      show('Ошибка сети: ' + String(error && error.message ? error.message : error), false)
    } finally {
      button.disabled = false
    }
  })
})()
</script>
</body>
</html>`
}

/**
 * Create the token-protected HTTP handler for the settings page and JSON API.
 *
 * The caller generates the secret token and registers the handler (usually via
 * `webServer.register`) for SETTINGS_HTML_PATH and SETTINGS_JSON_PATH. Every
 * request must carry the token in the query string; a missing or wrong token
 * always gets the same 401 answer.
 *
 * @param {object} options
 * @param {string} options.token - secret token generated at plugin start.
 * @param {string} options.file - JSON overlay path outside the repository.
 * @param {() => object|Promise<object>} [options.getStatus] - page status snapshot.
 * @param {() => string|Promise<string>} [options.getVersion] - plugin version.
 * @param {object} [options.logger]
 * @param {number} [options.maxBytes] - POST body limit, defaults to 64 KiB.
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createSettingsHandler({ token, file, getStatus, getVersion, logger, maxBytes = SETTINGS_BODY_LIMIT } = {}) {
  const expected = typeof token === 'string' ? token : ''
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : SETTINGS_BODY_LIMIT
  return async function handleSettings(req, res) {
    let url
    try {
      url = new URL(String(req?.url ?? '/'), 'http://localhost')
    } catch {
      url = null
    }
    const pathname = (url?.pathname ?? '/').replace(/\/+$/, '') || '/'
    const provided = url?.searchParams.get('token') ?? null
    if (expected === '' || provided === null || !safeEqual(provided, expected)) {
      logger?.warn?.('MAX settings request rejected: missing or invalid token')
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    if (pathname !== SETTINGS_HTML_PATH && pathname !== SETTINGS_JSON_PATH) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const method = String(req?.method ?? '').toUpperCase()

    if (method === 'GET') {
      const values = effectiveSettings(file)
      if (pathname === SETTINGS_HTML_PATH) {
        const status = await callStatus(getStatus, logger, 'status')
        const version = await callStatus(getVersion, logger, 'version')
        sendHtml(res, 200, renderSettingsPage({ values, status, version, token: expected }))
        return
      }
      const status = await callStatus(getStatus, logger, 'status')
      const version = await callStatus(getVersion, logger, 'version')
      sendJson(res, 200, { ok: true, values, status, version })
      return
    }

    if (method === 'POST' && pathname === SETTINGS_JSON_PATH) {
      let raw
      try {
        raw = await readBody(req, limit)
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
        sendJson(res, 400, { ok: false, errors: sanitized.errors, ignored: sanitized.ignored })
        return
      }
      try {
        saveSettings(file, mergeSettings(loadSettings(file), sanitized.values))
        logger?.info?.('MAX settings saved')
        const payload = { ok: true, values: effectiveSettings(file), restartRequired: true }
        if (sanitized.ignored.length > 0) payload.ignored = sanitized.ignored
        sendJson(res, 200, payload)
      } catch (error) {
        logger?.warn?.('cannot save MAX settings: %s', error?.message || String(error))
        sendJson(res, 500, { ok: false, error: 'cannot save settings' })
      }
      return
    }

    sendJson(res, 405, { ok: false, error: 'method not allowed' }, {
      allow: pathname === SETTINGS_HTML_PATH ? 'GET' : 'GET, POST',
    })
  }
}

/**
 * Legacy JSON-only handler for the DSH client page. Authentication is expected
 * to happen before it is called (the host wraps it with
 * `connection.requestRejection`). New integrations should use
 * {@link createSettingsHandler}.
 */
export function createSettingsApi({ file, getValues, getStatus, getVersion, logger } = {}) {
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
      const payload = { ok: true, values: { ...current, ...saved }, restartRequired: true }
      if (sanitized.ignored.length > 0) payload.ignored = sanitized.ignored
      sendJson(res, 200, payload)
    } catch (error) {
      logger?.warn?.('cannot save MAX settings: %s', error?.message || String(error))
      sendJson(res, 500, { ok: false, error: 'cannot save settings' })
    }
  }
}
