/**
 * "Наблюдатель": event notifications (subagent / job / goal / error), TODO
 * progress and the daily digest, all routed through the notification policy
 * (quiet hours, errors-only, mute).
 */
import {
  formatBudgetAlertCard,
  formatDigestCard,
  formatErrorCard,
  formatGoalCard,
  formatJobCard,
  formatSubagentCard,
  formatTodoCard,
  truncate,
} from './cards.mjs'
import { extractAssistantText } from './extract.mjs'
import { PRIORITY } from './limits.mjs'
import { createLruMap } from './lru.mjs'
import { isTopLevelSession } from './session-kind.mjs'
import { targetQuery } from './target.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Upper bound for the per-session goal/TODO caches below. */
const CACHE_MAX = 500

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function createObserver({ client, config, logger, target, policy, runtime, state, outbox, now } = {}) {
  let disposed = false
  let queue = Promise.resolve()
  let lastSentAt = 0
  let digestTimer
  let budgetTimer
  let budgetInitialTimer
  // Injectable wall clock: digest window tests must not depend on the real time.
  const clock = typeof now === 'function' ? now : () => Date.now()
  const dayKey = () => localDayKey(new Date(clock()))

  const usage = { dayKey: dayKey(), input: 0, output: 0, total: 0 }
  /** sessionId -> goal view (LRU-bounded) */
  const goals = createLruMap({ max: CACHE_MAX })
  /** sessionId -> { title, todos } (LRU-bounded) */
  const todos = createLruMap({ max: CACHE_MAX })
  /** sessionId -> { completed, signature } (LRU-bounded) */
  const todoProgress = createLruMap({ max: CACHE_MAX })

  function rollUsageDay() {
    const key = dayKey()
    if (usage.dayKey === key) return
    usage.dayKey = key
    usage.input = 0
    usage.output = 0
    usage.total = 0
  }

  function decide(kind) {
    return policy?.decide?.(kind) ?? { send: true, notify: true, reason: 'no-policy' }
  }

  /**
   * Run one notification handler body. index.js keeps a last-resort try/catch
   * around these handlers (logged at debug): catching here keeps an unexpected
   * failure visible at warn, logs exactly one line per failure and stops the
   * outer debug catch from double-reporting it.
   */
  function guarded(message, body) {
    try {
      return body()
    } catch (error) {
      logger?.warn?.(message, error?.message || String(error))
      return undefined
    }
  }

  /**
   * Run one scheduled check (digest/budget). Failures are real failures, not
   * expected "service absent" outcomes (those return a value), so each failed
   * run is reported once at warn instead of being hidden at debug.
   */
  function runCheck(label, check) {
    return check().catch((error) => logger?.warn?.('%s check failed: %s', label, error?.message || String(error)))
  }

  /** Queue one notification while respecting MAX's 2 messages/second limit. */
  function send(kind, text, { dedupeKey, priority } = {}) {
    const decision = decide(kind)
    if (!decision.send) {
      logger?.debug?.('notification %s suppressed (%s)', kind, decision.reason)
      return
    }
    if (outbox) {
      const queued = outbox.enqueue({
        dedupeKey,
        kind,
        priority: priority ?? (kind === 'error' ? PRIORITY.critical : PRIORITY.normal),
        params: {
          ...targetQuery(target),
          text,
          format: config.format,
          notify: decision.notify,
          disableLinkPreview: true,
        },
      })
      if (queued === false) {
        logger?.warn?.('MAX notification %s was not queued (duplicate or queue cap)', kind)
      }
      void outbox.flush().catch((error) => logger?.warn?.('outbox flush failed: %s', error?.message || String(error)))
      return
    }
    queue = queue
      .then(async () => {
        if (disposed) return
        const wait = 600 - (Date.now() - lastSentAt)
        if (wait > 0) await sleep(wait)
        lastSentAt = Date.now()
        await client.sendMessage({
          ...targetQuery(target),
          text,
          format: config.format,
          notify: decision.notify,
          disableLinkPreview: true,
        })
      })
      .catch((error) => logger?.warn?.('cannot send %s notification: %s', kind, error?.message || String(error)))
  }

  function noteUsage(data) {
    const value = data?.usage
    if (!value) return
    rollUsageDay()
    const input = Number(value.inputTokens ?? 0)
    const output = Number(value.outputTokens ?? 0)
    usage.input += input
    usage.output += output
    // `totalTokens` may include provider cache reads, which dwarfs the real
    // request size — report the visible request/response sum instead.
    usage.total += input + output
  }

  function onSessionEvent(session, event) {
    guarded('observer failed: %s', () => {
      if (!event || typeof event.type !== 'string') return
      const data = event.data ?? {}
      if (event.type === 'assistant/message') {
        noteUsage(data)
        return
      }
      if (event.type !== 'todo/write') return
      if (!config.todoProgress) return
      if (!isTopLevelSession(session)) return
      const items = Array.isArray(data.todos) ? data.todos : []
      const sessionId = String(session?.id ?? '')
      const title = runtime?.titleFor?.(session)
      todos.set(sessionId, { title, todos: items })
      const completed = items.filter((item) => item?.status === 'completed').length
      const previous = todoProgress.get(sessionId)
      if (previous && previous.completed === completed) return
      todoProgress.set(sessionId, { completed })
      send('todo', formatTodoCard({ title, todos: items }), {
        dedupeKey: `todo:${sessionId}:${completed}:${items.length}`,
      })
    })
  }

  function onSubagentEnd(info) {
    guarded('subagent notification failed: %s', () => {
      if (!config.notifySubagents || disposed) return
      const excerpt = extractAssistantText({ content: info?.lastAssistantMessage })
      send(
        'subagent',
        formatSubagentCard({
          childId: info?.id,
          stopReason: info?.stopReason,
          excerpt,
        }),
        { dedupeKey: info?.id ? `subagent:${info.id}` : undefined },
      )
    })
  }

  function onAgentError(payload) {
    guarded('error notification failed: %s', () => {
      if (!config.notifyErrors || disposed) return
      if (!isTopLevelSession(payload?.agent?.session)) return
      const errorSession = String(payload?.agent?.session?.id ?? '')
      send(
        'error',
        formatErrorCard({
          title: runtime?.titleFor?.(payload?.agent?.session),
          turn: payload?.turn,
          step: payload?.step,
          error: payload?.error,
        }),
        { dedupeKey: `error:${errorSession}:${payload?.turn ?? ''}:${payload?.step ?? ''}`, priority: PRIORITY.critical },
      )
    })
  }

  function onGoalChanged(payload) {
    guarded('goal notification failed: %s', () => {
      if (!config.notifyGoals || disposed) return
      const session = payload?.agent?.session
      if (!isTopLevelSession(session)) return
      const change = payload?.change ?? {}
      const operation = change.operation
      if (operation === 'edit' || operation === 'clear') return
      const sessionId = String(session?.id ?? '')
      if (change.goal) goals.set(sessionId, change.goal)
      else goals.delete(sessionId)
      send(
        'goal',
        formatGoalCard({
          title: runtime?.titleFor?.(session),
          goal: change.goal,
          operation,
        }),
        { dedupeKey: `goal:${sessionId}:${operation}:${change.goal?.id ?? ''}` },
      )
    })
  }

  function onJobEvent(event) {
    guarded('job notification failed: %s', () => {
      if (!config.notifyJobs || disposed) return
      if (event?.type !== 'settled') return
      if (event.awaited === true && !config.notifyAwaitedJobs) return
      send('job', formatJobCard({ job: event.job }), { dedupeKey: event.job?.id ? `job:${event.job.id}` : undefined })
    })
  }

  async function sendDigest() {
    if (disposed) return
    rollUsageDay()
    let sessions = []
    try {
      sessions = (await runtime?.listSessions?.()) ?? []
    } catch (error) {
      logger?.warn?.('cannot collect sessions for the digest: %s', error?.message || String(error))
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const recent = sessions.filter((item) => !item.updatedAt || item.updatedAt >= cutoff)
    const cost = await runtime?.costSnapshot?.()
    const pendingCards = state?.listPendingCards?.() ?? []
    const pending = {
      approvals: pendingCards.filter((card) => card?.kind === 'approval').length,
      questions: pendingCards.filter((card) => card?.kind === 'question').length,
    }
    const text = formatDigestCard({
      date: new Date(clock()).toLocaleDateString('ru-RU'),
      sessions: recent,
      usage: { ...usage },
      goals: [...goals.values()],
      todos: [...todos.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry })),
      cost,
      pending,
    })
    send('digest', text, { dedupeKey: `digest:${dayKey()}` })
    state?.setDigestDate?.(dayKey())
  }

  /** Epoch ms of today's configured digest time, or `undefined` for bad input. */
  function scheduledDigestAt(atMs) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(config.digestTime ?? ''))
    if (!match) return undefined
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) return undefined
    const scheduled = new Date(atMs)
    scheduled.setHours(hours, minutes, 0, 0)
    return scheduled.getTime()
  }

  /**
   * Send the daily digest once it is due.
   *
   * "Due" means `now >= configured time` and the digest was not sent yet today,
   * not an exact HH:MM match: a blocked event loop, a restart at 09:01 or a
   * missed 30 s timer tick must not silently skip the whole day. Repeats are
   * prevented by the persisted `digestDate` (restart-safe) and by the
   * `digest:<day>` outbox dedupe key.
   */
  async function maybeSendDigest() {
    if (!config.digestEnabled || disposed) return false
    const at = clock()
    if (state?.getDigestDate?.() === dayKey()) return false
    const scheduled = scheduledDigestAt(at)
    if (scheduled === undefined || at < scheduled) return false
    await sendDigest()
    return true
  }

  /** Send one alert per threshold per budget period (persisted across reloads). */
  async function checkBudget() {
    if (disposed || config?.budgetAlertEnabled === false) return { sent: 0 }
    const status = await runtime?.budgetStatus?.()
    if (!status?.available || status.budget?.enabled !== true) return { sent: 0, skipped: 'budget disabled or ledger unavailable' }
    const percent = status.budget.percent
    if (!Number.isFinite(percent)) return { sent: 0 }
    const configured = Array.isArray(config.budgetAlertThresholds) ? config.budgetAlertThresholds : []
    const thresholds = (configured.length > 0 ? configured : [80, 100])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0 && value <= 1000)
      .sort((a, b) => a - b)
    const alerts = state?.getBudgetAlerts?.() ?? {}
    let sent = 0
    for (const threshold of thresholds) {
      if (percent < threshold) continue
      const key = `${status.budget.periodKey}:${threshold}`
      if (alerts[key]) continue
      alerts[key] = Date.now()
      sent += 1
      send(threshold >= 100 ? 'error' : 'budget', formatBudgetAlertCard({ threshold, status }), {
        dedupeKey: `budget:${key}`,
        priority: threshold >= 100 ? PRIORITY.critical : PRIORITY.normal,
      })
    }
    if (sent > 0) {
      const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000
      for (const [key, at] of Object.entries(alerts)) {
        if (!Number.isFinite(Number(at)) || Number(at) < cutoff) delete alerts[key]
      }
      state?.setBudgetAlerts?.(alerts)
      logger?.info?.('budget alert(s) sent: %d (percent %s)', sent, percent)
    }
    return { sent }
  }

  function start() {
    if (disposed || digestTimer) return
    digestTimer = setInterval(() => {
      void runCheck('digest', maybeSendDigest)
    }, 30_000)
    digestTimer.unref?.()
    budgetTimer = setInterval(() => {
      void runCheck('budget', checkBudget)
    }, 5 * 60_000)
    budgetTimer.unref?.()
    budgetInitialTimer = setTimeout(() => {
      void runCheck('budget', checkBudget)
    }, 20_000)
    budgetInitialTimer.unref?.()
    void runCheck('digest', maybeSendDigest)
  }

  /**
   * Drop every cached view of one finished session (goal, TODO title/items and
   * the last reported TODO progress). Called by index.js on `session/disposed`
   * so long-running hosts do not keep disposed sessions in memory.
   */
  function clearSession(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return false
    goals.delete(id)
    todos.delete(id)
    todoProgress.delete(id)
    return true
  }

  function dispose() {
    disposed = true
    if (digestTimer) {
      clearInterval(digestTimer)
      digestTimer = undefined
    }
    if (budgetTimer) {
      clearInterval(budgetTimer)
      budgetTimer = undefined
    }
    if (budgetInitialTimer) {
      clearTimeout(budgetInitialTimer)
      budgetInitialTimer = undefined
    }
  }

  return {
    onSessionEvent,
    onSubagentEnd,
    onAgentError,
    onGoalChanged,
    onJobEvent,
    sendDigest,
    maybeSendDigest,
    checkBudget,
    clearSession,
    start,
    dispose,
    get usage() {
      return { ...usage }
    },
    get goals() {
      return [...goals.values()]
    },
    /** Sizes of the bounded per-session caches (observability/tests). */
    get cacheSizes() {
      return { goals: goals.size, todos: todos.size, todoProgress: todoProgress.size }
    },
  }
}
