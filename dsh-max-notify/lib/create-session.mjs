/**
 * Resolve the directory for a new session created from MAX.
 *
 * `/new`              → the active session's directory (or the configured default)
 * `/new max`          → `<active cwd>/max` (created if missing)
 * `/new /abs/path`    → that absolute directory (created if missing)
 */
import { isAbsolute, resolve } from 'node:path'

export function resolveSessionDir({ arg, baseCwd, configuredDir, fallbackCwd } = {}) {
  const raw = String(arg ?? '').trim()
  if (raw !== '') {
    return isAbsolute(raw) ? raw : resolve(baseCwd || fallbackCwd || process.cwd(), raw)
  }
  const configured = String(configuredDir ?? '').trim()
  if (configured !== '') {
    return isAbsolute(configured) ? configured : resolve(baseCwd || fallbackCwd || process.cwd(), configured)
  }
  return baseCwd || fallbackCwd || process.cwd()
}
