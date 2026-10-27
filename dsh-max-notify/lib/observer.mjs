/**
 * "Наблюдатель": event notifications (subagent / job / goal / error), TODO
 * progress and the daily digest, all routed through the notification policy
 * (quiet hours, errors-only, mute).
 */
import {
  formatDigestCard,
  formatErrorCard,
  formatGoalCard,
  formatJobCard,
  formatSubagentCard,
  formatTodoCard,
  truncate,
} from './cards.mjs'
import { extractAssistantText } from './extract.mjs'

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

export function createObserver({ client, config, logger, target, policy, runtime, state } = {}) {
  let disposed = false
  let queue = Promise.resolve()
  let lastSentAt = 0
  let digestTimer

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
  function send(kind, text) {
    const decision = decide(kind)
    if (!decision.send) {
      logger?.debug?.('notification %s suppressed (%s)', kind, decision.reason)
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
    usage.input += Number(value.inputTokens ?? 0)
    usage.output += Number(value.outputTokens ?? 0)
    usage.total += Number(value.totalTokens ?? (Number(value.inputTokens ?? 0) + Number(value.outputTokens ?? 0)))
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
    send('todo', formatTodoCard({ title, todos: items }))
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
    )
  }

  function onAgentError(payload) {
    if (!config.notifyErrors || disposed) return
    if (!isTopLevel(payload?.agent?.session)) return
    send(
      'error',
      formatErrorCard({
        title: runtime?.titleFor?.(payload?.agent?.session),
        turn: payload?.turn,
        step: payload?.step,
        error: payload?.error,
      }),
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
    )
  }

  function onJobEvent(event) {
    if (!config.notifyJobs || disposed) return
    if (event?.type !== 'settled') return
    if (event.awaited === true && !config.notifyAwaitedJobs) return
    send('job', formatJobCard({ job: event.job }))
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
    const text = formatDigestCard({
      date: new Date().toLocaleDateString('ru-RU'),
      sessions: recent,
      usage: { ...usage },
      goals: [...goals.values()],
      todos: [...todos.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry })),
    })
    send('digest', text)
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

  function start() {
    if (disposed || digestTimer) return
    digestTimer = setInterval(() => {
      void maybeSendDigest().catch((error) =>
        logger?.debug?.('digest check failed: %s', error?.message || String(error)),
      )
    }, 30_000)
    digestTimer.unref?.()
    void maybeSendDigest().catch(() => {})
  }

  function dispose() {
    disposed = true
    if (digestTimer) {
      clearInterval(digestTimer)
      digestTimer = undefined
    }
  }

  return {
    onSessionEvent,
    onSubagentEnd,
    onAgentError,
    onGoalChanged,
    onJobEvent,
    sendDigest,
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
