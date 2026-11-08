/**
 * Local audit trail for interactive decisions and commands.
 *
 * JSONL at `$DSH_HOME/max-notify/audit.jsonl` (mode 0600). Only metadata is
 * recorded — tool names, outcomes and sources, never message bodies or secrets.
 * Best-effort: write failures never break the agent flow.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function resolveAuditFile(config = {}) {
  if (typeof config.auditFile === 'string' && config.auditFile.trim() !== '') return config.auditFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'audit.jsonl')
}

export function createAudit({ file, enabled = true, logger, now = () => Date.now() } = {}) {
  let path = file
  let warned = false

  function write(entry) {
    if (!enabled || !path) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify({ at: now(), ...entry })}\n`, { mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        // best effort
      }
    } catch (error) {
      if (!warned) {
        warned = true
        logger?.warn?.('cannot append MAX audit log %s: %s', path, error?.message || String(error))
      }
    }
  }

  return {
    approve: (fields) => write({ kind: 'approval', ...fields }),
    question: (fields) => write({ kind: 'question', ...fields }),
    command: (fields) => write({ kind: 'command', ...fields }),
    write,
    setFile(next) {
      path = next
    },
  }
}
