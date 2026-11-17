/**
 * Redact token-like material from log lines.
 *
 * The bot token, webhook secret, voice/STT/TTS keys, upload URLs (`?r=...`),
 * Authorization header values and `MAX_BOT_TOKEN=` assignments must never reach
 * the journal. This is a defence-in-depth filter for log sinks only — payloads
 * are not rewritten.
 *
 * Three layers:
 *  1. runtime secrets registered via `registerSecret()` / `wrapLogger(logger, secrets)`
 *     are masked by exact (literal) match anywhere in the text;
 *  2. known secret-shaped assignments/prefixes (including 32+ char values in
 *     secret-like contexts such as `secret: ...` or `api_key=...`);
 *  3. a conservative 40+ char generic token catch-all, so ordinary 32-char
 *     hashes are left alone.
 */
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g
const UPLOAD_PARAM = /([?&]r=)[A-Za-z0-9_-]{20,}/g
const TOKEN_ASSIGN = /(MAX_BOT_TOKEN\s*=\s*)[^\s"']+/g
const BEARER = /(Authorization\s*[:=]\s*)\S+/gi
const ACCESS_PARAM = /([?&]access_token=)[^&\s]+/g

// 32+ char value only when the surrounding words say "secret": an ordinary
// MD5/SHA-like hash in free text is not touched by this rule.
const SECRET_VALUE = /(\b(?:secret|token|key|password|passwd|pwd|api[_-]?key|access[_-]?token)\b\s*[:=]?\s*["']?)([A-Za-z0-9_-]{32,})\b/gi
// Provider-shaped prefixes are secrets by construction, independent of context.
const PREFIXED_SECRET = /\b(?:sk|rk|ghp|gho|ghu|ghs|ghr|github_pat|npm|xox[baprs]|AIza|ya29)[_-][A-Za-z0-9_-]{20,}/g

const REDACTED = '<redacted>'
const registeredSecrets = new Set()

/** Minimum length for a registered secret: short values would destroy logs. */
const REGISTER_MIN_LENGTH = 8

/**
 * Register an actual runtime secret (webhook secret, bot token, voice key…).
 * Matching is literal (no regex), so any characters are safe. Returns true when
 * the value was added, false when it was too short, empty or already known.
 */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < REGISTER_MIN_LENGTH) return false
  if (registeredSecrets.has(value)) return false
  registeredSecrets.add(value)
  return true
}

/** Drop all registered secrets (test/reset helper). */
export function clearSecrets() {
  registeredSecrets.clear()
}

/** Number of currently registered runtime secrets. */
export function registeredSecretCount() {
  return registeredSecrets.size
}

function registeredSorted() {
  // Longest first: a token that contains another registered token must be
  // masked as a whole, not leave a recognizable tail behind.
  return [...registeredSecrets].sort((a, b) => b.length - a.length)
}

export function redact(value) {
  if (typeof value !== 'string' || value === '') return value
  let text = value
  for (const secret of registeredSorted()) {
    if (text.includes(secret)) text = text.split(secret).join(REDACTED)
  }
  return text
    .replace(TOKEN_ASSIGN, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(UPLOAD_PARAM, `$1${REDACTED}`)
    .replace(ACCESS_PARAM, `$1${REDACTED}`)
    .replace(SECRET_VALUE, `$1${REDACTED}`)
    .replace(PREFIXED_SECRET, REDACTED)
    .replace(LONG_TOKEN, REDACTED)
}

/**
 * Wrap a printf-style logger so every string argument is redacted.
 *
 * `secrets` (optional) accepts a single string, an array of strings, or an
 * object with a `secrets: [...]` array; every value is passed to
 * `registerSecret()` so callers can wire runtime credentials in one place:
 *
 *   const logger = wrapLogger(ctx.logger('max-notify'), [
 *     config.botToken, config.webhookSecret, config.voiceApiKey,
 *     config.voiceTtsApiKey,
 *   ])
 */
export function wrapLogger(logger, secrets) {
  if (!logger || typeof logger !== 'object') return logger
  let values
  if (Array.isArray(secrets)) values = secrets
  else if (secrets && typeof secrets === 'object' && Array.isArray(secrets.secrets)) values = secrets.secrets
  else if (secrets !== undefined && secrets !== null) values = [secrets]
  else values = []
  for (const value of values) registerSecret(value)
  const wrapped = {}
  for (const level of ['error', 'warn', 'info', 'debug']) {
    wrapped[level] = (format, ...args) => {
      const safeFormat = redact(String(format))
      const safeArgs = args.map((arg) => (typeof arg === 'string' ? redact(arg) : arg))
      logger[level]?.(safeFormat, ...safeArgs)
    }
  }
  return wrapped
}
