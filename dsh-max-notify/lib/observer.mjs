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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isTopLevel(session) {
  const header = session?.header
  if (!header) return true
  if (header.origin === 'subagent') return false
  return !(Number(header.delegationDepth ?? 0) > 0)
}

export function createObserver({ client, config, logger, target, policy, runtime, state, outbox } = {}) {
  let disposed = false
  let queue = Promise.resolve()
  let lastSentAt = 0
  let digestTimer
  let budgetTimer
  let budgetInitialTimer

  const usage = { dayKey: localDayKey(), input: 0, output: 0, total: 0 }
  /** sessionId -> goal view */
  const goals = new Map()
  /** sessionId -> { title, todos } */
  const todos = new Map()
  /** sessionId -> { completed, signature } */
  const todoProgress = new Map()

  const targetQuery = () =>
    target?.chatId !== undefined ? { chatId: target.chatId } : { userId: target?.userId }

  function rollUsageDay() {
    const key = localDayKey()
    if (usage.dayKey === key) return
    usage.dayKey = key
    usage.input = 0
    usage.output = 0
    usage.total = 0
  }

  function decide(kind) {
    return policy?.decide?.(kind) ?? { send: true, notify: true, reason: 'no-policy' }
  }

  /** Queue one notification while respecting MAX's 2 messages/second limit. */
  function send(kind, text, { dedupeKey, priority } = {}) {
    const decision = decide(kind)
    if (!decision.send) {
      logger?.debug?.('notification %s suppressed (%s)', kind, decision.reason)
      return
    }
    if (outbox) {
      outbox.enqueue({
        dedupeKey,
        kind,
        priority: priority ?? (kind === 'error' ? PRIORITY.critical : PRIORITY.normal),
        params: {
          ...targetQuery(),
          text,
          format: config.format,
          notify: decision.notify,
          disableLinkPreview: true,
        },
      })
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
          ...targetQuery(),
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
    if (!event || typeof event.type !== 'string') return
    const data = event.data ?? {}
    if (event.type === 'assistant/message') {
      noteUsage(data)
      return
    }
    if (event.type !== 'todo/write') return
    if (!config.todoProgress) return
    if (!isTopLevel(session)) return
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
  }

  function onSubagentEnd(info) {
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
  }

  function onAgentError(payload) {
    if (!config.notifyErrors || disposed) return
    if (!isTopLevel(payload?.agent?.session)) return
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
  }

  function onGoalChanged(payload) {
    if (!config.notifyGoals || disposed) return
    const session = payload?.agent?.session
    if (!isTopLevel(session)) return
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
  }

  function onJobEvent(event) {
    if (!config.notifyJobs || disposed) return
    if (event?.type !== 'settled') return
    if (event.awaited === true && !config.notifyAwaitedJobs) return
    send('job', formatJobCard({ job: event.job }), { dedupeKey: event.job?.id ? `job:${event.job.id}` : undefined })
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
    const text = formatDigestCard({
      date: new Date().toLocaleDateString('ru-RU'),
      sessions: recent,
      usage: { ...usage },
      goals: [...goals.values()],
      todos: [...todos.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry })),
      cost,
    })
    send('digest', text, { dedupeKey: `digest:${localDayKey()}` })
    state?.setDigestDate?.(localDayKey())
  }

  async function maybeSendDigest() {
    if (!config.digestEnabled || disposed) return
    const time = String(config.digestTime ?? '')
    if (!/^\d{2}:\d{2}$/.test(time)) return
    const now = new Date()
    const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (current !== time) return
    if (state?.getDigestDate?.() === localDayKey(now)) return
    await sendDigest()
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
      void maybeSendDigest().catch((error) =>
        logger?.debug?.('digest check failed: %s', error?.message || String(error)),
      )
    }, 30_000)
    digestTimer.unref?.()
    budgetTimer = setInterval(() => {
      void checkBudget().catch((error) =>
        logger?.debug?.('budget check failed: %s', error?.message || String(error)),
      )
    }, 5 * 60_000)
    budgetTimer.unref?.()
    budgetInitialTimer = setTimeout(() => {
      void checkBudget().catch(() => {})
    }, 20_000)
    budgetInitialTimer.unref?.()
    void maybeSendDigest().catch(() => {})
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
    checkBudget,
    start,
    dispose,
    get usage() {
      return { ...usage }
    },
    get goals() {
      return [...goals.values()]
    },
  }
}
