/**
 * Compose the text that is sent to MAX for one finished agent turn.
 */
import { describeReason } from './extract.mjs'

/** Last path segment of a working directory, used in the notification header. */
function shortCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const normalized = cwd.replace(/[/\\]+$/, '')
  const base = normalized.split(/[/\\]/).pop()
  return base || normalized
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
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
  now = new Date(),
} = {}) {
  const body = String(text ?? '').trim()
  if (!includeHeader) return body

  const brand = format === 'html' ? '<b>DSH</b>' : format === 'markdown' ? '**DSH**' : 'DSH'
  const parts = [brand, formatClock(now)]
  const label = typeof title === 'string' && title.trim() !== '' ? title.trim() : shortCwd(cwd)
  if (label) parts.push(label.length > 60 ? `${label.slice(0, 57)}…` : label)
  if (includeSessionId && typeof sessionId === 'string' && sessionId.length > 0) {
    parts.push(sessionId.length > 12 ? sessionId.slice(-8) : sessionId)
  }
  let header = parts.join(' · ')

  const reasonNote = describeReason(reason)
  if (reasonNote) header += ` · _${reasonNote}_`

  return body ? `${header}\n\n${body}` : header
}
