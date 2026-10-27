/**
 * Notification policy: normal / errors-only / mute modes, plus quiet hours.
 *
 * Kinds are grouped by urgency:
 *  - critical (approval, question, error) always notify, even in mute/quiet;
 *  - everything else is silenced during quiet hours (sent silently) and either
 *    silenced or dropped in `errors` / `mute` modes.
 */
const MODES = new Set(['all', 'errors', 'mute'])
const CRITICAL = new Set(['approval', 'question', 'error'])

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''))
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

export function createPolicy({ config = {}, state, logger, now = () => Date.now() } = {}) {
  function modeState() {
    let mode = state?.getMode?.() ?? (MODES.has(config.mode) ? config.mode : 'all')
    const until = state?.getMuteUntil?.()
    if (mode === 'mute' && until !== undefined && now() >= until) {
      mode = 'all'
      state?.setMode?.('all')
      state?.setMuteUntil?.(undefined)
    }
    return { mode, until }
  }

  function inQuietHours() {
    const quiet = config.quietHours
    if (!quiet || typeof quiet !== 'object') return false
    const start = parseTime(quiet.start)
    const end = parseTime(quiet.end)
    if (start === undefined || end === undefined || start === end) return false
    const date = new Date(now())
    const minutes = date.getHours() * 60 + date.getMinutes()
    return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  }

  /** @returns {{send: boolean, notify: boolean, reason: string}} */
  function decide(kind) {
    if (CRITICAL.has(kind)) return { send: true, notify: true, reason: 'critical' }
    const { mode } = modeState()
    if (mode === 'mute') return { send: false, notify: false, reason: 'mute' }
    if (mode === 'errors') return { send: true, notify: false, reason: 'errors-only' }
    if (inQuietHours()) return { send: true, notify: false, reason: 'quiet-hours' }
    return { send: true, notify: true, reason: 'normal' }
  }

  function setMode(mode, durationMs) {
    if (!MODES.has(mode)) return false
    state?.setMode?.(mode)
    state?.setMuteUntil?.(mode === 'mute' && durationMs ? now() + durationMs : undefined)
    logger?.info?.('notification mode: %s%s', mode, mode === 'mute' && durationMs ? ` for ${Math.round(durationMs / 60000)}m` : '')
    return true
  }

  function describe() {
    const { mode, until } = modeState()
    const quiet = config.quietHours
    const quietText =
      quiet && quiet.start && quiet.end ? `тихие часы ${quiet.start}–${quiet.end}` : 'тихие часы выключены'
    if (mode === 'mute') {
      const untilText = until ? `до ${new Date(until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
        : 'до /unmute'
      return `🔕 **Режим: mute** ${untilText}\n${quietText}\nКритичные (подтверждения/вопросы/ошибки) всё равно приходят.`
    }
    if (mode === 'errors') {
      return `⚠️ **Режим: только ошибки**\n${quietText}\nОстальные уведомления приходят без push.`
    }
    return `🔔 **Режим: всё**\n${quietText}`
  }

  return { decide, setMode, modeState, inQuietHours, describe, modes: [...MODES] }
}
