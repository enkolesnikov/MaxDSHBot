/**
 * Redact token-like material from log lines.
 *
 * The bot token, upload URLs (`?r=...`), Authorization header values and
 * `MAX_BOT_TOKEN=` assignments must never reach the journal. This is a
 * defence-in-depth filter for log sinks only — payloads are not rewritten.
 */
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g
const UPLOAD_PARAM = /([?&]r=)[A-Za-z0-9_-]{20,}/g
const TOKEN_ASSIGN = /(MAX_BOT_TOKEN\s*=\s*)[^\s"']+/g
const BEARER = /(Authorization\s*[:=]\s*)\S+/gi
const ACCESS_PARAM = /([?&]access_token=)[^&\s]+/g

export function redact(value) {
  if (typeof value !== 'string' || value === '') return value
  return value
    .replace(TOKEN_ASSIGN, '$1<redacted>')
    .replace(BEARER, '$1<redacted>')
    .replace(UPLOAD_PARAM, '$1<redacted>')
    .replace(ACCESS_PARAM, '$1<redacted>')
    .replace(LONG_TOKEN, '<redacted>')
}

/** Wrap a printf-style logger so every string argument is redacted. */
export function wrapLogger(logger) {
  if (!logger || typeof logger !== 'object') return logger
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
