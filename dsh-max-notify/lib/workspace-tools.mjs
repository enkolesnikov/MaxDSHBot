/**
 * Workspace file tools for the MAX remote control: git diff as an attachment
 * and sending one local file from the session's working directory.
 *
 * Pure-ish helpers with injectable `execFile`; no shell execution and no path
 * traversal outside the session cwd unless explicitly allowed.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'

const MAX_DIFF_BYTES = 1024 * 1024
const MAX_SEND_BYTES = 25 * 1024 * 1024
const defaultExecFile = promisify(execFile)

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.heic'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.m4a', '.flac', '.aac'])

/** Map a file extension to a MAX upload type. */
export function classifyUploadType(filePath) {
  const extension = extname(String(filePath ?? '')).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return 'file'
}

function errorText(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error ?? 'unknown error')
}

/**
 * Run `git diff` in a session directory.
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.path]
 * @param {boolean} [options.staged]
 * @param {number} [options.maxBytes]
 * @param {Function} [options.execFileImpl]
 * @returns {Promise<{ok:true, diff:string, truncated:boolean, bytes:number, empty:boolean}|{ok:false, error:string}>}
 */
export async function runGitDiff({
  cwd,
  path,
  staged = false,
  maxBytes = MAX_DIFF_BYTES,
  execFileImpl = defaultExecFile,
} = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return { ok: false, error: 'session cwd is unavailable' }
  if (typeof execFileImpl !== 'function') return { ok: false, error: 'execFile is unavailable' }
  const args = ['-C', cwd, 'diff']
  if (staged === true) args.push('--staged')
  if (typeof path === 'string' && path.trim() !== '') args.push('--', path.trim())
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : MAX_DIFF_BYTES
  let result
  try {
    result = await execFileImpl('git', args, {
      cwd,
      timeout: 20_000,
      maxBuffer: Math.max(limit * 2, 2 * 1024 * 1024),
      encoding: 'utf8',
    })
  } catch (error) {
    const message = errorText(error)
    if (/not a git repository/i.test(message)) return { ok: false, error: 'это не git-репозиторий' }
    return { ok: false, error: `git diff failed: ${message}` }
  }
  const diff = String(result?.stdout ?? '')
  const bytes = Buffer.byteLength(diff, 'utf8')
  if (diff.trim() === '') return { ok: true, diff: '', truncated: false, bytes: 0, empty: true }
  if (bytes > limit) {
    return { ok: true, diff: diff.slice(0, limit) + '\n… diff усечён\n', truncated: true, bytes, empty: false }
  }
  return { ok: true, diff, truncated: false, bytes, empty: false }
}

/**
 * Resolve a file argument relative to the session cwd and enforce boundaries.
 * @returns {{ok:true, path:string, name:string, bytes:number, type:string}|{ok:false, error:string}}
 */
export function resolveSendFile({
  cwd,
  arg,
  maxBytes = MAX_SEND_BYTES,
  allowOutside = false,
} = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return { ok: false, error: 'session cwd is unavailable' }
  const raw = String(arg ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
  if (raw === '') return { ok: false, error: 'укажи путь к файлу: /send <путь>' }

  let root
  try {
    root = realpathSync(cwd)
  } catch (error) {
    return { ok: false, error: `не удалось открыть рабочую папку: ${errorText(error)}` }
  }
  let target
  try {
    target = realpathSync(isAbsolute(raw) ? raw : resolve(root, raw))
  } catch (error) {
    return { ok: false, error: `файл не найден: ${raw}` }
  }
  if (!allowOutside) {
    const inside = target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
    if (!inside) return { ok: false, error: 'путь вне рабочей папки сессии запрещён' }
  }
  let stats
  try {
    stats = statSync(target)
  } catch (error) {
    return { ok: false, error: `не удалось прочитать файл: ${errorText(error)}` }
  }
  if (!stats.isFile()) return { ok: false, error: 'это не файл' }
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : MAX_SEND_BYTES
  if (stats.size > limit) return { ok: false, error: `файл слишком большой: ${formatBytes(stats.size)} (лимит ${formatBytes(limit)})` }
  return {
    ok: true,
    path: target,
    name: basename(target),
    bytes: stats.size,
    type: classifyUploadType(target),
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export const WORKSPACE_LIMITS = Object.freeze({
  maxDiffBytes: MAX_DIFF_BYTES,
  maxSendBytes: MAX_SEND_BYTES,
})
