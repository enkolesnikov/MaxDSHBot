/**
 * Safe helpers for the MAX remote command `/schedules`: list, pause, resume,
 * cancel, plus human-readable cards.
 *
 * The DSH Host service (`ctx.get('schedule')`) is passed in by the caller; this
 * module never resolves services itself. Every helper tolerates a missing
 * service, malformed entries and service exceptions, so a MAX command can
 * always answer with text instead of crashing the message loop.
 *
 * MAX markdown has no lists or tables, so cards use plain numbered lines.
 */

/** Human labels for the three durable task states. */
const STATUS_LABELS = Object.freeze({
  active: '🟢 активно',
  paused: '⏸ на паузе',
  ended: '⏹ завершено',
})

/** Human labels for task destinations. */
const TARGET_LABELS = Object.freeze({
  session: 'текущая сессия',
  new_once: 'новая сессия',
  new: 'новая сессия (каждый раз)',
})

/** Short schedule-kind descriptions for entries without extra timing fields. */
const KIND_LABELS = Object.freeze({
  at: 'в указанное время',
  daily: 'ежедневно',
  weekly: 'еженедельно',
  cron: 'по cron-расписанию',
  rrule: 'по правилу RRULE',
})

/** Maximum number of tasks shown in one MAX card. */
const MAX_CARD_ITEMS = 10

/**
 * Format a positive duration in seconds as compact Russian text.
 *
 * @param {unknown} seconds - Raw duration; non-numeric values yield an empty string.
 * @returns {string} Text such as `1 ч 30 мин`, or an empty string.
 */
function formatDuration(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  const total = Math.floor(value)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const rest = total % 60
  const parts = []
  if (days > 0) parts.push(`${days} д`)
  if (hours > 0) parts.push(`${hours} ч`)
  if (minutes > 0) parts.push(`${minutes} мин`)
  if (rest > 0 && days === 0 && hours === 0) parts.push(`${rest} с`)
  return parts.slice(0, 2).join(' ')
}

/**
 * Format an instant as local `ДД.ММ ЧЧ:ММ`.
 *
 * @param {unknown} value - ISO instant or Date.
 * @returns {string} Local date and time, or an em dash for an invalid value.
 */
function formatLocalDate(value) {
  if (value === null || value === undefined || value === '') return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day}.${month} ${hours}:${minutes}`
}

/** Error message for an absent or malformed schedule service. */
const NO_SERVICE = 'Сервис расписаний (dsh-schedule) не подключён'

/**
 * Read an own label from a frozen map, ignoring inherited object members.
 *
 * @param {Record<string, string>} map - Label map.
 * @param {unknown} key - Candidate key.
 * @param {string} fallback - Value for an unknown key.
 * @returns {string} Mapped label or the fallback.
 */
function labelOf(map, key, fallback) {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : fallback
}

/**
 * Normalize one `list()` entry to the fields MAX needs.
 *
 * @param {unknown} entry - Raw task entry from dsh-schedule.
 * @returns {{
 *   id: string,
 *   title: string,
 *   kind: string,
 *   prompt: string,
 *   scheduledAt: string | null,
 *   status: string,
 *   targetKind: string,
 *   executionActive: boolean,
 *   updatedAt: unknown,
 * }} Normalized entry.
 */
function normalizeSchedule(entry) {
  const task = entry && typeof entry === 'object' ? entry : {}
  return {
    id: task.id === undefined || task.id === null ? '' : String(task.id),
    title: typeof task.title === 'string' ? task.title : '',
    kind: typeof task.kind === 'string' ? task.kind : '',
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    scheduledAt: typeof task.scheduledAt === 'string' ? task.scheduledAt : null,
    status: typeof task.status === 'string' && task.status !== '' ? task.status : 'unknown',
    targetKind: typeof task.target?.kind === 'string' ? task.target.kind : '',
    executionActive: task.executionActive === true,
    updatedAt: task.updatedAt ?? null,
  }
}

/**
 * Read a page of scheduled tasks for `/schedules`.
 *
 * @param {object | undefined} scheduleService - The DSH `schedule` service.
 * @param {object} [options] - Page options.
 * @param {boolean} [options.active] - Filter by active state when supplied.
 * @param {number} [options.limit=50] - Page size, clamped to 1..500.
 * @returns {Promise<{ ok: true, items: Array<object>, total: number } | { ok: false, error: string }>}
 *   Normalized page or a human-readable failure.
 */
export async function listSchedules(scheduleService, { active, limit = 50 } = {}) {
  if (typeof scheduleService?.list !== 'function') return { ok: false, error: NO_SERVICE }

  const request = {}
  if (typeof active === 'boolean') request.active = active
  request.limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50

  try {
    const result = await scheduleService.list(request)
    if (!result || typeof result !== 'object') {
      return { ok: false, error: 'Сервис расписаний вернул некорректный ответ' }
    }
    const items = (Array.isArray(result.items) ? result.items : []).map(normalizeSchedule)
    const total = Number.isFinite(result.total) ? result.total : items.length
    return { ok: true, items, total }
  } catch (error) {
    return { ok: false, error: `Не удалось получить список задач: ${errorText(error)}` }
  }
}

/**
 * Pause or resume one task through `scheduleService.edit`.
 *
 * @param {object | undefined} scheduleService - The DSH `schedule` service.
 * @param {object} [options] - Edit options.
 * @param {string} [options.id] - Task id.
 * @param {boolean} [options.active] - Desired state.
 * @param {string | null} [options.expectedUpdatedAt] - Optional optimistic-lock revision.
 * @returns {Promise<{
 *   ok: boolean,
 *   id: string,
 *   active: boolean,
 *   result?: unknown,
 *   error?: string,
 *   code?: string,
 * }>} Operation outcome.
 */
export async function setScheduleActive(scheduleService, { id, active, expectedUpdatedAt } = {}) {
  const taskId = typeof id === 'string' ? id.trim() : ''
  const desired = active === true
  const outcome = { id: taskId, active: desired }

  if (typeof scheduleService?.edit !== 'function') return { ...outcome, ok: false, error: NO_SERVICE }
  if (taskId === '') return { ...outcome, ok: false, error: 'Не указан id задачи' }
  if (typeof active !== 'boolean') return { ...outcome, ok: false, error: 'Параметр active должен быть boolean' }
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null && typeof expectedUpdatedAt !== 'string') {
    return { ...outcome, ok: false, error: 'Параметр expectedUpdatedAt должен быть строкой или null' }
  }

  const request = { id: taskId, action: 'update', patch: { active } }
  if (expectedUpdatedAt !== undefined) request.expectedUpdatedAt = expectedUpdatedAt

  try {
    const result = await scheduleService.edit(request)
    const code = typeof result?.code === 'string' ? result.code : ''
    if (code === 'schedule_not_found') {
      return { ...outcome, ok: false, code, error: 'Задача не найдена' }
    }
    if (code === 'schedule_conflict') {
      return { ...outcome, ok: false, code, error: 'Задача уже изменилась, обновите список' }
    }
    if (code !== '') {
      return { ...outcome, ok: false, code, error: `Не удалось изменить задачу (${code})` }
    }
    return { ...outcome, ok: true, result }
  } catch (error) {
    return { ...outcome, ok: false, error: `Не удалось изменить задачу: ${errorText(error)}` }
  }
}

/**
 * Delete one task through `scheduleService.edit({ action: 'delete' })`.
 *
 * @param {object | undefined} scheduleService - The DSH `schedule` service.
 * @param {object} [options] - Delete options.
 * @param {string} [options.id] - Task id.
 * @param {string | null} [options.expectedUpdatedAt] - Optional optimistic-lock revision.
 * @returns {Promise<{ ok: boolean, id: string, deleted: boolean, error?: string, code?: string }>}
 *   Operation outcome.
 */
export async function deleteSchedule(scheduleService, { id, expectedUpdatedAt } = {}) {
  const taskId = typeof id === 'string' ? id.trim() : ''
  const outcome = { id: taskId, deleted: false }

  if (typeof scheduleService?.edit !== 'function') return { ...outcome, ok: false, error: NO_SERVICE }
  if (taskId === '') return { ...outcome, ok: false, error: 'Не указан id задачи' }
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null && typeof expectedUpdatedAt !== 'string') {
    return { ...outcome, ok: false, error: 'Параметр expectedUpdatedAt должен быть строкой или null' }
  }

  const request = { id: taskId, action: 'delete' }
  if (expectedUpdatedAt !== undefined) request.expectedUpdatedAt = expectedUpdatedAt

  try {
    const result = await scheduleService.edit(request)
    if (result?.deleted === true) return { ...outcome, ok: true, deleted: true }
    const code = typeof result?.code === 'string' ? result.code : ''
    if (code === 'schedule_not_found') {
      return { ...outcome, ok: false, code, error: 'Задача не найдена' }
    }
    if (code === 'schedule_conflict') {
      return { ...outcome, ok: false, code, error: 'Задача уже изменилась, обновите список' }
    }
    if (code !== '') {
      return { ...outcome, ok: false, code, error: `Не удалось удалить задачу (${code})` }
    }
    return { ...outcome, ok: false, error: 'Сервис не подтвердил удаление задачи' }
  } catch (error) {
    return { ...outcome, ok: false, error: `Не удалось удалить задачу: ${errorText(error)}` }
  }
}

/**
 * Describe one task as a single MAX-friendly line.
 *
 * @param {unknown} entry - Raw or normalized task entry; unknown fields are ignored.
 * @returns {string} Line such as `🟢 «Деплой» · ежедневно · 08.11 21:30 · цель: текущая сессия`.
 */
export function describeSchedule(entry) {
  if (!entry || typeof entry !== 'object') return '❔ Задача без данных'

  const task = entry
  const title = typeof task.title === 'string' && task.title.trim() !== '' ? task.title.trim() : 'Без названия'
  const status = labelOf(STATUS_LABELS, task.status, '❔ неизвестный статус')
  const kind = String(task.kind ?? '')

  let kindText
  if (kind === 'after') {
    const duration = formatDuration(task.afterSeconds)
    kindText = duration === '' ? 'через некоторое время' : `через ${duration}`
  } else if (kind === 'every') {
    const duration = formatDuration(task.everySeconds)
    kindText = duration === '' ? 'по интервалу' : `каждые ${duration}`
  } else {
    kindText = labelOf(KIND_LABELS, kind, 'расписание')
  }

  const when = formatLocalDate(task.scheduledAt)
  const targetKind = typeof task.target?.kind === 'string' ? task.target.kind : String(task.targetKind ?? '')
  const target = labelOf(
    TARGET_LABELS,
    targetKind,
    targetKind === '' ? 'не указана' : targetKind,
  )

  const parts = [`${status} «${title}»`, kindText, when, `цель: ${target}`]
  if (task.executionActive === true) parts.push('выполняется')
  return parts.join(' · ')
}

/**
 * Build the `/schedules` card: header, up to ten numbered tasks, command hints.
 *
 * @param {{ items?: unknown[], total?: unknown }} [card] - List result from {@link listSchedules}.
 * @returns {string} Plain-text card for MAX.
 */
export function formatSchedulesCard(card = {}) {
  const items = Array.isArray(card?.items) ? card.items : []
  const lines = ['⏰ Запланированные задачи', '']

  if (items.length === 0) {
    lines.push('Задач нет')
    return lines.join('\n')
  }

  const shown = items.slice(0, MAX_CARD_ITEMS)
  shown.forEach((item, index) => {
    lines.push(`${index + 1}. ${describeSchedule(item)}`)
  })

  const total = Number.isFinite(card?.total) && card.total >= items.length ? card.total : items.length
  const remaining = Math.max(0, total - shown.length)
  if (remaining > 0) lines.push(`… и ещё ${remaining}`)

  lines.push(
    '',
    '/schedules pause N',
    '/schedules resume N',
    '/schedules cancel N',
  )
  return lines.join('\n')
}

/**
 * Extract a printable message from an unknown thrown value.
 *
 * @param {unknown} error - Thrown value.
 * @returns {string} Error message or a generic fallback.
 */
function errorText(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const text = String(error ?? '')
  return text === '' ? 'неизвестная ошибка' : text
}
