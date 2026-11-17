/**
 * Shared configuration rules for dsh-max-notify.
 *
 * The GUI settings overlay (`lib/settings.mjs`) and the private-profile config
 * normalizer (`lib/config.mjs`) must accept exactly the same values for the keys
 * they share; only the failure mode differs:
 *
 *  - strict `coerce*` helpers throw and are used by the overlay, which reports
 *    the error to the client and refuses the patch;
 *  - lenient `normalize*`/`asBoolean` helpers fall back to a default and are
 *    used by the plugin config, which must never crash on a typo.
 *
 * Keeping both entry points on the same helpers prevents normalization drift
 * (for example `quietHours: { start: '25:00' }` accepted by the YAML profile but
 * rejected by the GUI). The module is pure: no imports, no I/O, no environment.
 */

/** Strict 24-hour `HH:MM`; `7:5`, `24:00`, `25:00` and `99:99` are rejected. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on'])
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off'])

/** Preset-button limits, shared by the overlay and the config normalizer. */
export const PRESET_LIMITS = Object.freeze({ maxItems: 6, labelMax: 40, promptMax: 500 })

/**
 * Allowlist of editable GUI settings with their type and constraints. Every
 * entry also carries the built-in default used when the overlay has no value.
 * `lib/config.mjs` imports these definitions so both entry points validate the
 * same keys with the same rules.
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

/** Unicode code-point length (what a person perceives as characters). */
export function charLength(value) {
  return Array.from(String(value)).length
}

/**
 * Recognize a boolean-ish value.
 *
 * Accepts booleans, `1`/`0`, and the usual `true/false`, `yes/no`, `on/off`
 * spellings (case-insensitive, trimmed). Returns `undefined` for anything else
 * so callers can choose strict (throw) or lenient (fallback) behaviour.
 *
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
export function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (BOOLEAN_TRUE.has(text)) return true
    if (BOOLEAN_FALSE.has(text)) return false
  }
  return undefined
}

/** Strict boolean parser (settings overlay): throws on unknown values. */
export function coerceBoolean(value) {
  const parsed = parseBoolean(value)
  if (parsed === undefined) throw new Error('must be a boolean')
  return parsed
}

/** Lenient boolean parser (plugin config/voice): unknown values use the fallback. */
export function asBoolean(value, fallback) {
  const parsed = parseBoolean(value)
  return parsed === undefined ? fallback : parsed
}

/** Return strict `HH:MM` text or `undefined` for anything invalid. */
export function normalizeTime(value) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return TIME_RE.test(text) ? text : undefined
}

/** Strict time parser (settings overlay): throws on invalid times. */
export function coerceTime(value) {
  const time = normalizeTime(value)
  if (time === undefined) throw new Error('must be HH:MM (24-hour)')
  return time
}

/** Lenient quiet-hours parser: `{ start, end }` with valid times or `undefined`. */
export function normalizeQuietHours(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const start = normalizeTime(value.start)
  const end = normalizeTime(value.end)
  return start !== undefined && end !== undefined ? { start, end } : undefined
}

/** Strict quiet-hours parser (settings overlay); `null` means "disabled". */
export function coerceQuietHours(value) {
  if (value === null) return null
  const quiet = normalizeQuietHours(value)
  if (!quiet) throw new Error('must be null or { start, end } with HH:MM times')
  return quiet
}

/** Strict integer parser (settings overlay): rejects non-integers/out-of-range. */
export function coerceInteger(value, definition) {
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

/** Strict enum parser (settings overlay): trims/lowercases before matching. */
export function coerceEnum(value, values) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!values.includes(text)) throw new Error(`must be one of ${values.join('|')}`)
  return text
}

/** Strict preset-button parser (settings overlay). */
export function coercePresets(value, definition = PRESET_LIMITS) {
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

/** Strict bounded-string parser (settings overlay). */
export function coerceString(value, definition) {
  if (typeof value !== 'string') throw new Error('must be a string')
  const text = value.trim()
  if (charLength(text) > definition.maxLength) {
    throw new Error(`must be a string of at most ${definition.maxLength} characters`)
  }
  return text
}

/**
 * Validate and coerce one allowlisted setting value against its definition.
 * Throws on invalid input; unknown definition types are rejected as well.
 *
 * @param {{type: string}} definition
 * @param {unknown} value
 * @returns {unknown}
 */
export function coerceValue(definition, value) {
  switch (definition.type) {
    case 'enum':
      return coerceEnum(value, definition.values)
    case 'boolean':
      return coerceBoolean(value)
    case 'time':
      return coerceTime(value)
    case 'quietHours':
      return coerceQuietHours(value)
    case 'integer':
      return coerceInteger(value, definition)
    case 'presets':
      return coercePresets(value, definition)
    case 'string':
      return coerceString(value, definition)
    default:
      throw new Error('unsupported setting type')
  }
}
