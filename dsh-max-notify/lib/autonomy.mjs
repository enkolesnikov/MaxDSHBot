/**
 * Autonomous schedule policies.
 *
 * A policy is attached by the user to one durable schedule (task) via
 * `/schedules mode N read-only|auto`. During a scheduled run the plugin matches
 * the live session back to that schedule and answers approval requests without
 * a MAX card:
 *
 *   inherit    — normal behaviour (ask in MAX/GUI, honour timeout);
 *   read-only  — allow known read-only tools, reject everything else;
 *   auto       — allow every tool (dangerous, requires explicit confirmation).
 *
 * Matching is deliberately conservative: direct target-session hits require an
 * active execution, while per-run `new` sessions additionally need a title and
 * a recent delivery receipt. Pure helpers, no DSH imports.
 */

export const AUTONOMY_MODES = Object.freeze(['inherit', 'read-only', 'auto'])

/** Tools that cannot mutate the workspace or run arbitrary commands. */
export const READ_ONLY_TOOLS = Object.freeze(new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'list',
  'find',
  'search',
  'web_search',
  'web_fetch',
]))

const MODE_LABELS = Object.freeze({
  inherit: 'обычный (спрашивать)',
  'read-only': 'read-only (без записи)',
  auto: 'auto (всё разрешено)',
})

export function normalizeAutonomyMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return AUTONOMY_MODES.includes(text) ? text : undefined
}

export function formatAutonomyMode(value) {
  const mode = normalizeAutonomyMode(value) ?? 'inherit'
  return MODE_LABELS[mode]
}

/** Validate a stored policy; only the mode and a display title survive. */
export function normalizePolicy(value) {
  if (!value || typeof value !== 'object') return undefined
  const mode = normalizeAutonomyMode(value.mode)
  if (!mode || mode === 'inherit') return undefined
  return {
    mode,
    title: typeof value.title === 'string' ? value.title.slice(0, 120) : '',
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : undefined,
  }
}

/**
 * Decide one approval under a policy.
 * @returns {{action:'prompt'|'allow'|'deny', reason:string}}
 */
export function classifyAutonomyDecision(mode, toolName) {
  const normalized = normalizeAutonomyMode(mode)
  if (normalized === 'auto') return { action: 'allow', reason: 'auto policy' }
  if (normalized !== 'read-only') return { action: 'prompt', reason: 'inherit policy' }
  const tool = typeof toolName === 'string' ? toolName : ''
  if (READ_ONLY_TOOLS.has(tool)) return { action: 'allow', reason: 'read-only tool' }
  return { action: 'deny', reason: `tool ${tool || '(unknown)'} is not read-only` }
}

function instantMs(value) {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeSessionTitle(value) {
  return String(value ?? '')
    .replace(/\s+·\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase()
}

function titleMatches(sessionTitle, scheduleTitle) {
  const left = normalizeSessionTitle(sessionTitle)
  const right = normalizeSessionTitle(scheduleTitle)
  if (left === '' || right === '') return false
  return left === right || left.startsWith(`${right} `) || left.includes(right)
}

/**
 * Does one normalized schedule cover this live session right now?
 * @param {object} schedule - `{ targetSessionId, involvedSessionIds, title, executionActive, lastDelivery, status }`
 * @param {object} options
 * @returns {boolean}
 */
export function scheduleMatchesSession(schedule, {
  sessionId,
  sessionTitle,
  now = Date.now(),
  titleWindowMs = 30 * 60 * 1000,
} = {}) {
  if (!schedule || typeof schedule !== 'object') return false
  const sid = String(sessionId ?? '')
  if (sid === '') return false
  const direct = schedule.targetSessionId === sid ||
    (Array.isArray(schedule.involvedSessionIds) && schedule.involvedSessionIds.includes(sid))
  if (direct) {
    if (schedule.executionActive === true) return true
    // Some targets (a one-shot `new` session) never set executionActive; a
    // receipt plus a matching title is the fallback below.
  }
  const deliveredAt = instantMs(schedule.lastDelivery?.deliveredAt)
  const recent = deliveredAt !== undefined && Number.isFinite(now) && now - deliveredAt <= titleWindowMs
  if (recent && titleMatches(sessionTitle, schedule.title)) return true
  return false
}

/**
 * Pick the safest matching policy for a session.
 * @param {object} options
 * @param {object} options.policies - scheduleId -> stored policy
 * @param {Array<object>} options.schedules - normalized schedule list
 * @returns {{ok:true, mode:string, scheduleId:string, title:string}|{ok:false}}
 */
export function resolveAutonomyPolicy({
  sessionId,
  sessionTitle,
  schedules,
  policies,
  now = Date.now(),
} = {}) {
  const map = policies && typeof policies === 'object' ? policies : {}
  const list = Array.isArray(schedules) ? schedules : []
  const matches = []
  for (const schedule of list) {
    const id = String(schedule?.id ?? '')
    if (id === '') continue
    const policy = normalizePolicy(map[id])
    if (!policy) continue
    if (schedule.status !== 'active' && schedule.executionActive !== true) continue
    if (!scheduleMatchesSession(schedule, { sessionId, sessionTitle, now })) continue
    matches.push({ scheduleId: id, title: policy.title || schedule.title || '', mode: policy.mode })
  }
  if (matches.length === 0) return { ok: false }
  // Least privilege wins if several schedules point at the same session.
  matches.sort((a, b) => {
    const rank = { 'read-only': 0, auto: 1, inherit: 2 }
    return rank[a.mode] - rank[b.mode]
  })
  return { ok: true, ...matches[0] }
}
