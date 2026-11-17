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
 * a recent delivery receipt. Titles match exactly or as an anchored prefix with
 * a clear word boundary — never as a free substring. A schedule that declares
 * session identity is matched by identity only: a fresh delivery plus a title
 * can never grant access to a different session, nor grant `auto` on its own.
 * Pure helpers, no DSH imports.
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

/** Any non-letter/non-number character is a clear title boundary. */
const TITLE_BOUNDARY = /[^\p{L}\p{N}]/u

function titleMatches(sessionTitle, scheduleTitle) {
  const left = normalizeSessionTitle(sessionTitle)
  const right = normalizeSessionTitle(scheduleTitle)
  if (left === '' || right === '') return false
  if (left === right) return true
  if (!left.startsWith(right)) return false
  // Anchored prefix only: "ci" may prefix "ci build", but must never match
  // "circleci" or "Redeploy" through a free substring search.
  return TITLE_BOUNDARY.test(left.charAt(right.length))
}

function sessionIdentity(schedule, sid) {
  const target = String(schedule.targetSessionId ?? '')
  const involved = Array.isArray(schedule.involvedSessionIds)
    ? schedule.involvedSessionIds.map((id) => String(id ?? ''))
    : []
  return {
    declared: target !== '' || involved.some((id) => id !== ''),
    matched: target === sid || involved.includes(sid),
  }
}

/**
 * Detailed match for one normalized schedule and one live session.
 * @returns {{matched:boolean, identityVerified:boolean}}
 */
function matchDetails(schedule, {
  sessionId,
  sessionTitle,
  now = Date.now(),
  titleWindowMs = 30 * 60 * 1000,
} = {}) {
  if (!schedule || typeof schedule !== 'object') return { matched: false, identityVerified: false }
  const sid = String(sessionId ?? '')
  if (sid === '') return { matched: false, identityVerified: false }
  const identity = sessionIdentity(schedule, sid)
  // A schedule that names its session(s) is bound to them. Never fall back to
  // title+time on an identity mismatch — that is how an unrelated session was
  // able to inherit an `auto` policy.
  if (identity.declared && !identity.matched) return { matched: false, identityVerified: false }
  if (identity.matched && schedule.executionActive === true) {
    return { matched: true, identityVerified: true }
  }
  // Some targets (a one-shot `new` session) never set executionActive. The
  // receipt+title fallback is allowed only with no declared identity or with a
  // verified identity match — never in place of one.
  const deliveredAt = instantMs(schedule.lastDelivery?.deliveredAt)
  const recent = deliveredAt !== undefined && Number.isFinite(now) &&
    deliveredAt <= now && now - deliveredAt <= titleWindowMs
  if (recent && titleMatches(sessionTitle, schedule.title)) {
    return { matched: true, identityVerified: identity.matched }
  }
  return { matched: false, identityVerified: false }
}

/**
 * Does one normalized schedule cover this live session right now?
 * @param {object} schedule - `{ targetSessionId, involvedSessionIds, title, executionActive, lastDelivery, status }`
 * @param {object} options
 * @returns {boolean}
 */
export function scheduleMatchesSession(schedule, options = {}) {
  return matchDetails(schedule, options).matched
}

/**
 * Pick the safest matching policy for a session.
 * @param {object} options
 * @param {object} options.policies - scheduleId -> stored policy
 * @param {Array<object>} options.schedules - normalized schedule list
 * A title+time match without a verified session identity demotes `auto` to
 * `inherit`: read-only keeps its safe behaviour, but `auto` is never granted
 * on a title alone.
 * @returns {{ok:true, mode:string, scheduleId:string, title:string, identityVerified:boolean}|{ok:false}}
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
    const match = matchDetails(schedule, { sessionId, sessionTitle, now })
    if (!match.matched) continue
    matches.push({
      scheduleId: id,
      title: policy.title || schedule.title || '',
      // Only `auto` needs an identity-verified match; a title-only `auto`
      // becomes inherit. `read-only` keeps its safe allow/deny behaviour.
      mode: match.identityVerified || policy.mode !== 'auto' ? policy.mode : 'inherit',
      identityVerified: match.identityVerified,
    })
  }
  if (matches.length === 0) return { ok: false }
  // Least privilege wins if several schedules point at the same session.
  matches.sort((a, b) => {
    const rank = { 'read-only': 0, auto: 1, inherit: 2 }
    return rank[a.mode] - rank[b.mode]
  })
  return { ok: true, ...matches[0] }
}
