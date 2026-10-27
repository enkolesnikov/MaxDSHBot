/**
 * Incoming files from MAX: download attachments sent by the allowlisted owner
 * into the session's workspace inbox and hand their paths to the agent.
 */
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const TYPE_EXTENSION = { image: '.jpg', video: '.mp4', audio: '.mp3', file: '.bin' }
const SAFE_CHARS = /[^A-Za-z0-9._ ()-]+/g

/** Human-readable byte size. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function describeAttachment(attachment) {
  const payload = attachment?.payload ?? {}
  const type = String(attachment?.type ?? 'file')
  const url = payload.url ?? attachment?.url
  const rawName =
    attachment?.filename ??
    payload.filename ??
    payload.name ??
    (type === 'image' && payload.photo_id ? `image-${payload.photo_id}` : `attachment-${Date.now()}`)
  const size = attachment?.size ?? payload.size
  const fallbackExtension = TYPE_EXTENSION[type] ?? TYPE_EXTENSION.file
  return { type, url, name: safeFileName(rawName, fallbackExtension), size }
}

/** Basename + whitelist + fallback extension; prevents path traversal/overwrite. */
export function safeFileName(rawName, fallbackExtension = '.bin') {
  const base = basename(String(rawName ?? '').replace(/\\/g, '/'))
  let cleaned = base.replace(SAFE_CHARS, '_').replace(/^[.\s]+/, '').replace(/\s+/g, ' ').trim()
  if (cleaned === '') cleaned = 'file'
  if (extname(cleaned) === '') cleaned += fallbackExtension
  if (cleaned.length > 80) {
    const ext = extname(cleaned)
    cleaned = `${cleaned.slice(0, 80 - ext.length)}${ext}`
  }
  return cleaned
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * @param {object} options
 * @param {object} options.client - MAX transport with `downloadToFile`.
 * @param {object} options.config - normalized plugin config.
 * @param {object} options.logger
 * @param {(sessionId: string) => Promise<string|undefined>} [options.resolveCwd]
 */
export function createIncoming({ client, config, logger, resolveCwd } = {}) {
  function inboxDirFor(cwd) {
    const configured = typeof config.inboxDir === 'string' ? config.inboxDir.trim() : ''
    if (configured !== '') {
      const expanded = configured.replace(/^~/, homedir()).replaceAll('%cwd%', cwd)
      return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
    }
    return join(cwd, 'max-inbox')
  }

  function buildPrompt(saved, originalText) {
    const lines = saved.map(
      (file) => `• ${file.path} (${file.type}, ${formatBytes(file.bytes)})`,
    )
    const intro = String(originalText ?? '').trim()
    return [
      intro ? `${intro}\n` : '',
      'Пользователь прислал файлы из MAX, они сохранены в рабочей папке:',
      ...lines,
      '',
      'Прочитай их при необходимости (read для текста, read_image для картинок) и продолжи работу.',
    ]
      .join('\n')
      .trim()
  }

  /**
   * Download every attachment into the inbox of the session's working directory.
   * @returns {Promise<{saved: Array<{path, name, type, bytes}>, errors: string[], dir?: string, promptText: string}>}
   */
  async function save(attachments, sessionId) {
    const list = Array.isArray(attachments) ? attachments : []
    if (!config.receiveFiles || list.length === 0) {
      return { saved: [], errors: [], promptText: '' }
    }
    let cwd
    try {
      cwd = (await resolveCwd?.(sessionId)) ?? process.cwd()
    } catch {
      cwd = process.cwd()
    }
    const dir = inboxDirFor(cwd)
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      logger?.warn?.('cannot create MAX inbox %s: %s', dir, error?.message || String(error))
      return { saved: [], errors: [`не удалось создать папку ${dir}`], promptText: '' }
    }

    const maxFiles = Math.max(1, config.maxIncomingFiles ?? 4)
    const maxBytes = Math.max(1024, config.maxIncomingBytes ?? 25 * 1024 * 1024)
    const saved = []
    const errors = []
    for (const attachment of list.slice(0, maxFiles)) {
      const meta = describeAttachment(attachment)
      if (!meta.url) {
        errors.push(`${meta.name}: нет URL для скачивания`)
        continue
      }
      if (typeof meta.size === 'number' && meta.size > maxBytes) {
        errors.push(`${meta.name}: больше лимита (${formatBytes(meta.size)})`)
        continue
      }
      const dest = join(dir, `${timestamp()}-${randomUUID().slice(0, 8)}-${meta.name}`)
      try {
        const result = await client.downloadToFile(meta.url, dest, { maxBytes })
        saved.push({ path: dest, name: meta.name, type: meta.type, bytes: result.bytes })
        logger?.info?.('saved MAX attachment %s (%d bytes)', dest, result.bytes)
      } catch (error) {
        errors.push(`${meta.name}: ${error?.message || String(error)}`)
        logger?.warn?.('cannot download MAX attachment %s: %s', meta.name, error?.message || String(error))
      }
    }
    return { saved, errors, dir, promptText: buildPrompt(saved, '') }
  }

  return { save, buildPrompt, inboxDirFor }
}
