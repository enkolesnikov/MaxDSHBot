/**
 * Local audit trail for interactive decisions and commands.
 *
 * JSONL at `$DSH_HOME/max-notify/audit.jsonl` (mode 0600). Only metadata is
 * recorded — tool names, outcomes and sources, never message bodies or secrets.
 * Two exceptions are dead-letter webhook records (`kind: 'webhook'`,
 * `action: 'dead-letter'`): they must keep the failing `update` and `error` for
 * post-mortem, so both fields are deep-redacted before the line is appended.
 *
 * Growth is capped best effort: before an append, an audit file larger than
 * 5 MiB is rotated to `<file>.1` (one generation, older content discarded).
 *
 * Best-effort: write failures never break the agent flow.
 */
import { appendFileSync, chmodSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { ensurePrivateDir } from './fs-safe.mjs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { redact, redactDeep } from './redact.mjs'

/** Rotate the audit trail once it grows past this size (one `.1` generation). */
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024

export function resolveAuditFile(config = {}) {
  if (typeof config.auditFile === 'string' && config.auditFile.trim() !== '') return config.auditFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'audit.jsonl')
}

/**
 * Redact the two payload fields that may carry external text. Everything else
 * stays a plain metadata field, so the "metadata only" contract is preserved.
 */
function redactFields(entry) {
  if (!entry || typeof entry !== 'object') return entry
  if (entry.update === undefined && entry.error === undefined) return entry
  const safe = { ...entry }
  if (safe.update !== undefined) safe.update = redactDeep(safe.update)
  if (safe.error !== undefined) {
    safe.error = typeof safe.error === 'string' ? redact(safe.error) : redactDeep(safe.error)
  }
  return safe
}

export function createAudit({ file, enabled = true, logger, now = () => Date.now() } = {}) {
  let path = file
  let warned = false

  function warnOnce(message, error) {
    if (warned) return
    warned = true
    logger?.warn?.(message, path, error?.message || String(error))
  }

  /**
   * Best-effort single-generation rotation. A rotation failure must never stop
   * the audit write itself: the append still happens to the old file.
   */
  function rotateIfNeeded() {
    let size
    try {
      size = statSync(path).size
    } catch {
      return // missing file: append will create it
    }
    if (size <= AUDIT_ROTATE_BYTES) return
    const rotated = `${path}.1`
    try {
      try {
        unlinkSync(rotated)
      } catch {
        // no previous generation
      }
      renameSync(path, rotated)
    } catch (error) {
      warnOnce('cannot rotate MAX audit log %s: %s', error)
    }
  }

  function append(entry) {
    if (!enabled || !path) return
    try {
      ensurePrivateDir(dirname(path))
      rotateIfNeeded()
      appendFileSync(path, `${JSON.stringify(redactFields({ at: now(), ...entry }))}\n`, { mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        // best effort
      }
    } catch (error) {
      warnOnce('cannot append MAX audit log %s: %s', error)
    }
  }

  // `write` historically accepted a raw entry; keep that behavior.
  function write(entry) {
    append(entry)
  }

  return {
    approve: (fields) => append({ kind: 'approval', ...fields }),
    question: (fields) => append({ kind: 'question', ...fields }),
    command: (fields) => append({ kind: 'command', ...fields }),
    write,
    setFile(next) {
      path = next
    },
  }
}
