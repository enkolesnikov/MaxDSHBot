/**
 * Private filesystem primitives for plugin data.
 *
 * Why a helper instead of `mkdirSync(dir, { recursive: true, mode: 0o700 })`:
 *  - the requested mode of a *newly created* directory is masked by the process
 *    umask, so a permissive umask can strip owner bits from every component;
 *  - an *existing* directory is never re-tightened: one created by an older
 *    release or by the operator with 0755/0777 keeps exposing private file names
 *    even after the plugin "fixed" its permissions;
 *  - with the recursive call it is impossible to tell created components from
 *    pre-existing ones (relevant for the safety rule below).
 *
 * Permission policy:
 *  - every component this helper creates gets exactly 0700 — the mode is applied
 *    by `mkdir` and re-applied by `chmod` immediately, so an unusual umask cannot
 *    leave a directory without owner access (chmod is done before the next
 *    component is created, which is what makes umask 0777 survivable);
 *  - the target directory itself is tightened to 0700 even when it already
 *    exists (an inbox/overlay dir from an older release may be 0755);
 *  - existing *ancestors above* the first created component are deliberately left
 *    untouched: the chain may contain `/tmp`, the user's home or the repository
 *    root, and chmodding those while saving a plugin file would be destructive.
 *    Only the target and the components created for it are chmodded.
 *
 * chmod is best effort and never throws: filesystems without POSIX modes (FAT,
 * some network mounts) or an existing path owned by somebody else (EPERM) must
 * not stop the caller from writing the actual file, which is still attempted
 * with mode 0600. Directory creation failures ARE propagated: without the
 * directory the caller cannot continue.
 */
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, parse, resolve } from 'node:path'

/** Mode for directories that hold private plugin data (state, settings, inbox). */
export const PRIVATE_DIR_MODE = 0o700

/** Mode for files that hold private plugin data (state, settings, heartbeat). */
export const PRIVATE_FILE_MODE = 0o600

function assertPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`)
}

/** Best-effort chmod: permission tightening must never break a save. */
function tighten(path, mode) {
  try {
    chmodSync(path, mode)
  } catch {
    // Best effort: see the module comment (FAT/network mounts, EPERM, ...).
  }
}

function notADirectoryError(path) {
  const error = new Error(`not a directory: ${path}`)
  error.code = 'ENOTDIR'
  error.path = path
  return error
}

/**
 * Create `dir` and every missing ancestor with mode 0700, then tighten the final
 * directory to 0700. Already existing directories above the created chain are
 * never chmodded. Idempotent and safe to call before every write.
 *
 * @param {string} dir directory path (absolute or relative to `cwd`)
 * @param {{mode?: number}} [options]
 * @returns {string} the resolved absolute directory path
 * @throws {TypeError} for an empty/non-string path
 * @throws {NodeJS.ErrnoException} when a component exists but is not a directory
 *   or cannot be created
 */
export function ensurePrivateDir(dir, { mode = PRIVATE_DIR_MODE } = {}) {
  assertPath(dir, 'directory path')
  const target = resolve(dir)

  // Collect the missing tail of the path, stopping at the first existing
  // directory (or at a non-directory, which is an error).
  const missing = []
  let current = target
  for (;;) {
    let stats
    try {
      stats = statSync(current)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (stats) {
      if (!stats.isDirectory()) throw notADirectoryError(current)
      break
    }
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) break // filesystem root: nothing above it
    current = parent
  }

  // Create from the topmost missing component down; chmod each one before
  // creating the next so an aggressive umask cannot lock us out of our own path.
  for (const path of missing.reverse()) {
    try {
      mkdirSync(path, { mode })
    } catch (error) {
      // A concurrent writer may have won the race; an existing directory is fine.
      if (error?.code !== 'EEXIST') throw error
      const stats = statSync(path)
      if (!stats.isDirectory()) throw notADirectoryError(path)
    }
    tighten(path, mode)
  }

  // Tighten a pre-existing target as well (e.g. `max-notify` from 1.8 with 0755).
  // The filesystem root itself is never chmodded.
  if (target !== parse(target).root) tighten(target, mode)

  return target
}

/**
 * Convenience for small, idempotent private snapshots (heartbeat, settings
 * overlay): ensures the 0700 parent directory, writes the file with mode 0600
 * and tightens an existing file to 0600. Not atomic — callers that need
 * crash-safety must keep using their own tmp file + rename.
 *
 * @param {string} file file path (absolute or relative to `cwd`)
 * @param {string|Buffer|Uint8Array} data
 * @param {{mode?: number}} [options]
 * @returns {string} the resolved absolute file path
 */
export function writePrivateFile(file, data, { mode = PRIVATE_FILE_MODE } = {}) {
  assertPath(file, 'file path')
  const target = resolve(file)
  ensurePrivateDir(dirname(target))
  writeFileSync(target, data, { mode })
  tighten(target, mode)
  return target
}
