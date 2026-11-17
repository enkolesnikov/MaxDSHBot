/**
 * Compose the text that is sent to MAX for one finished agent turn.
 */
import { describeReason } from './extract.mjs'

/**
 * Last path segment of a working directory: notification headers, status card,
 * session list and workspace picker all show the folder, not the full path.
 * Only `/` and `\` are treated as separators; trailing ones are ignored.
 */
export function folderOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const normalized = cwd.replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).pop() || normalized
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Clock label for notifications and cards: `HH:MM` by default, `HH:MM:SS`
 * when `seconds` is set. Accepts a Date or anything `new Date()` understands;
 * an unparseable value renders as an em dash instead of `NaN:NaN`.
 */
export function formatClock(date, { seconds = false } = {}) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) return '—'
  const clock = `${pad2(value.getHours())}:${pad2(value.getMinutes())}`
  return seconds ? `${clock}:${pad2(value.getSeconds())}` : clock
}

/**
 * Human-readable file size. One implementation for incoming attachments, the
 * `/send` resolver and `/diff` cards.
 *
 * Units are powers of 1024, not 1000: "KB"/"MB"/"GB" are conventional labels
 * for KiB/MiB/GiB (so 1 GB means 1024³ bytes). B/KB/MB keep one decimal; GB
 * keeps two, so files just over a gibibyte do not collapse into "1.0 GB".
 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Compose the MAX message text.
 *
 * @param {object} params
 * @param {string} params.text - assistant reply text.
 * @param {string} [params.cwd] - session working directory.
 * @param {string} [params.title] - session title (preferred over the folder name).
 * @param {string} [params.sessionId] - session id, for the optional short tag.
 * @param {object|string} [params.reason] - turn/end reason.
 * @param {'markdown'|'html'|null} [params.format] - MAX text format; header is styled accordingly.
 * @param {boolean} [params.includeHeader] - include the `DSH · time · folder` line.
 * @param {boolean} [params.includeSessionId] - append a short session tag to the header.
 * @param {'compact'|'detailed'} [params.messageStyle] - header style; compact is the default.
 * @param {Date} [params.now] - clock override (tests).
 * @returns {string}
 */
export function formatNotification({
  text,
  cwd,
  title,
  sessionId,
  reason,
  format = 'markdown',
  includeHeader = true,
  includeSessionId = false,
  messageStyle = 'compact',
  now = new Date(),
} = {}) {
  const body = String(text ?? '').trim()
  if (!includeHeader) return body

  const label = typeof title === 'string' && title.trim() !== '' ? title.trim() : folderOf(cwd)
  const reasonNote = describeReason(reason)

  if (messageStyle === 'detailed') {
    const brand = format === 'html' ? '<b>DSH</b>' : format === 'markdown' ? '**DSH**' : 'DSH'
    const parts = [brand, formatClock(now, { seconds: true })]
    if (label) parts.push(label.length > 60 ? `${label.slice(0, 57)}…` : label)
    if (includeSessionId && typeof sessionId === 'string' && sessionId.length > 0) {
      parts.push(sessionId.length > 12 ? sessionId.slice(-8) : sessionId)
    }
    let header = parts.join(' · ')
    if (reasonNote) header += ` · _${reasonNote}_`
    return body ? `${header}\n\n${body}` : header
  }

  const clock = formatClock(now)
  const parts = [`🕒 ${clock}`]
  if (label) parts.push(label.length > 40 ? `${label.slice(0, 37)}…` : label)
  if (includeSessionId && typeof sessionId === 'string' && sessionId.length > 0) {
    parts.push(sessionId.length > 12 ? sessionId.slice(-8) : sessionId)
  }
  let header = parts.join(' · ')
  if (reasonNote) header += ` · ${reasonNote}`
  return body ? `${header}\n\n${body}` : header
}
