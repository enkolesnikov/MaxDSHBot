/**
 * Interactive decisions over MAX: approvals, agent questions, and inline
 * keyboard callbacks.
 *
 * DSH exposes two host waterfalls — `approval/request` and
 * `user-questions/request`. We register with `prepend`, immediately delegate
 * with `next()` (so the Web GUI keeps its card), and then race the MAX answer
 * against the GUI answer: whichever arrives first wins. The losing channel's
 * card is edited to say where the decision was made.
 */
import { randomUUID } from 'node:crypto'
import {
  formatApprovalCard,
  formatApprovalResult,
  formatQuestionCard,
  truncate,
} from './cards.mjs'
import { PRIORITY } from './limits.mjs'

const APPROVAL_TARGET = 'approval/request'

function isTopLevelAgent(agent) {
  const header = agent?.session?.header
  if (!header) return true
  if (header.origin === 'subagent') return false
  return !(Number(header.delegationDepth ?? 0) > 0)
}

function callbackButton(text, payload) {
  return { type: 'callback', text, payload: JSON.stringify(payload) }
}

function keyboard(rows) {
  return [{ type: 'inline_keyboard', payload: { buttons: rows } }]
}

/**
 * @param {object} options
 * @param {object} options.client - MAX transport client.
 * @param {object} options.config - normalized plugin config.
 * @param {object} options.logger - cordis logger.
 * @param {{chatId?: string, userId?: string}} options.target - send target.
 * @param {(session: object|undefined) => (string|undefined)} options.resolveTitle
 */
export function createInteractions({ client, config, logger, target, resolveTitle, state, audit } = {}) {
  /** token -> pending interaction */
  const pending = new Map()
  /** chat key -> Set<token> for text-answered questions */
  const questionsByChat = new Map()
  let disposed = false

  const enabled = config?.interactive !== false
  const approvalChannel = config?.approvalChannel ?? 'both'
  const questionChannel = config?.questionChannel ?? 'both'
  const approvalTimeoutMs = Math.max(0, Number(config?.approvalTimeoutMs) || 0)
  const rememberTools = new Set(Array.isArray(config?.approvalRememberTools) ? config.approvalRememberTools : [])
  const rememberMs = Math.max(1000, Number(config?.approvalRememberMs) || 60 * 60 * 1000)

  function targetQuery() {
    if (target?.chatId !== undefined) return { chatId: target.chatId }
    if (target?.userId !== undefined) return { userId: target.userId }
    return {}
  }

  function chatKey(chatId) {
    return String(chatId ?? target?.chatId ?? target?.userId ?? 'default')
  }

  async function sendCard(text, rows, extraAttachments = []) {
    const params = {
      ...targetQuery(),
      text,
      format: config?.format,
      notify: config?.notify,
      disableLinkPreview: true,
      priority: PRIORITY.critical,
    }
    const attachments = []
    if (rows) attachments.push(...keyboard(rows))
    if (Array.isArray(extraAttachments) && extraAttachments.length > 0) attachments.push(...extraAttachments)
    if (attachments.length > 0) params.attachments = attachments
    const response = await client.sendMessage(params)
    return response?.message?.body?.mid
  }

  async function editCard(messageId, text, rows) {
    if (!messageId) return
    try {
      await client.editMessage({
        messageId,
        text,
        format: config?.format,
        attachments: rows ?? [],
      })
    } catch (error) {
      logger?.debug?.('cannot edit MAX card: %s', error?.message || String(error))
    }
  }

  function addQuestionToken(record) {
    const key = chatKey(record.chatId)
    const set = questionsByChat.get(key) ?? new Set()
    set.add(record.token)
    questionsByChat.set(key, set)
  }

  function dropQuestionToken(record) {
    const key = chatKey(record.chatId)
    const set = questionsByChat.get(key)
    if (!set) return
    set.delete(record.token)
    if (set.size === 0) questionsByChat.delete(key)
  }

  function answersArray(record) {
    return record.questions.map((question) => {
      const answer = record.answers.get(question.id) ?? { selected: [] }
      const item = { id: question.id, selected: answer.selected ?? [] }
      if (answer.custom) item.custom = answer.custom
      return item
    })
  }

  function allAnswered(record) {
    return record.questions.every((question) => record.answers.has(question.id))
  }

  // ── approvals ────────────────────────────────────────────────────────────

  async function handleApproval(request, next) {
    if (!enabled || disposed) return next()
    if (approvalChannel === 'gui') return next()
    if (!isTopLevelAgent(request?.agent)) return next()
    if (typeof client.sendMessage !== 'function') return next()

    const toolName = request?.toolName
    // A remembered scope answers before a card is created; the GUI never sees it.
    const rule = state?.approvalRuleFor?.(toolName)
    if (rule) {
      audit?.approve?.({ tool: toolName, outcome: 'allowed-once', source: 'rule' })
      logger?.info?.('MAX approval auto-allowed by rule for %s until %s', toolName, new Date(rule.until).toISOString())
      return 'allowed-once'
    }

    const guiPromise = next()
    const token = randomUUID()
    const title = resolveTitle?.(request?.agent?.session)
    const displayReason =
      request?.displayReason?.ru ??
      request?.displayReason?.en ??
      Object.values(request?.displayReason ?? {})[0]
    const text = formatApprovalCard({
      title,
      toolName,
      reason: displayReason ?? request?.reason,
      callId: request?.callId,
    })

    const rows = [
      [callbackButton('✅ Разрешить', { t: 'ap', tk: token, v: 'allow' })],
      [callbackButton('❌ Отклонить', { t: 'ap', tk: token, v: 'deny' })],
    ]
    if (toolName && rememberTools.has(toolName)) {
      rows.push([callbackButton('♾️ Разрешить и запомнить', { t: 'ap', tk: token, v: 'allow-always' })])
    }

    let messageId
    try {
      messageId = await sendCard(text, rows)
    } catch (error) {
      logger?.warn?.('cannot send approval card to MAX: %s', error?.message || String(error))
      return guiPromise
    }

    const record = { kind: 'approval', token, messageId, chatId: target?.chatId, toolName, resolve: undefined }
    const chatPromise = new Promise((resolve) => {
      record.resolve = resolve
    })
    pending.set(token, record)
    state?.addPendingCard?.({ token, kind: 'approval', messageId, chatId: target?.chatId })

    let timer
    const timeoutPromise =
      approvalTimeoutMs > 0
        ? new Promise((resolve) => {
            timer = setTimeout(() => resolve({ from: 'timeout' }), approvalTimeoutMs)
            timer.unref?.()
          })
        : undefined

    const onAbort = () => {
      if (pending.get(token) === record) {
        pending.delete(token)
        state?.removePendingCard?.(token)
        audit?.approve?.({ tool: record.toolName, outcome: 'cancelled', source: 'abort' })
        record.resolve('cancelled')
      }
    }
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })

    try {
      const guiOutcome = guiPromise.then(
        (outcome) => ({ from: 'gui', outcome }),
        (error) => ({ from: 'gui-error', error }),
      )
      const racers = [chatPromise.then((outcome) => ({ from: 'chat', outcome })), guiOutcome]
      if (timeoutPromise) racers.push(timeoutPromise)
      const winner = await Promise.race(racers)
      // A reload already marked the card stale; do not overwrite it.
      if (disposed) return winner.from === 'chat' ? winner.outcome : 'cancelled'

      if (winner.from === 'timeout') {
        void guiPromise.catch(() => {})
        await editCard(messageId, formatApprovalResult({ outcome: 'rejected', toolName, by: 'timeout' }))
        audit?.approve?.({ tool: toolName, outcome: 'rejected', source: 'timeout' })
        logger?.warn?.('MAX approval timed out after %d ms for %s (rejected)', approvalTimeoutMs, toolName)
        return 'rejected'
      }
      if (winner.from === 'chat') {
        void guiPromise.catch(() => {})
        await editCard(messageId, formatApprovalResult({ outcome: winner.outcome, toolName, by: 'max' }))
        if (!record.audited) audit?.approve?.({ tool: toolName, outcome: winner.outcome, source: 'max' })
        return winner.outcome
      }
      if (winner.from === 'gui-error') {
        await editCard(messageId, formatApprovalResult({ outcome: 'unavailable', toolName }))
        audit?.approve?.({ tool: toolName, outcome: 'unavailable', source: 'gui-error' })
        throw winner.error
      }
      await editCard(messageId, formatApprovalResult({ outcome: winner.outcome, toolName, by: 'gui' }))
      audit?.approve?.({ tool: toolName, outcome: winner.outcome, source: 'gui' })
      return winner.outcome
    } finally {
      if (timer) clearTimeout(timer)
      pending.delete(token)
      state?.removePendingCard?.(token)
      request?.signal?.removeEventListener?.('abort', onAbort)
    }
  }

  // ── questions ────────────────────────────────────────────────────────────

  function renderQuestionCard(record) {
    return formatQuestionCard({ questions: record.questions, answered: record.answers.size })
  }

  /** Plan-mode review arrives through `user-questions` with intent.kind = plan-review. */
  function planQuestionOf(record) {
    const question = record?.questions?.[0]
    return question?.intent?.kind === 'plan-review' ? question : undefined
  }

  function planLabels(record) {
    const question = planQuestionOf(record)
    const options = Array.isArray(question?.options) ? question.options : []
    const approve = question?.intent?.approve ?? options[0]?.label ?? 'Approve'
    const keep = options.find((option) => option?.label !== approve)?.label ?? 'Keep planning'
    return { approve, keep }
  }

  /** Upload the full plan as a .md file; returns the attachment list (best effort). */
  async function planFileAttachments(record) {
    const question = planQuestionOf(record)
    const plan = String(question?.detail ?? '')
    if (plan === '' || typeof client.uploadMedia !== 'function') return []
    try {
      const uploaded = await client.uploadMedia({
        buffer: Buffer.from(plan, 'utf8'),
        filename: 'plan.md',
        type: 'file',
      })
      if (!uploaded?.token) return []
      return [{ type: 'file', payload: { token: uploaded.token } }]
    } catch (error) {
      logger?.warn?.('cannot upload plan.md to MAX: %s', error?.message || String(error))
      return []
    }
  }

  function renderPlanCard(record) {
    const question = planQuestionOf(record)
    const plan = String(question?.detail ?? '')
    const header = question?.header ? `${question.header}: ` : ''
    const lines = ['🧭 **Review плана**', '']
    lines.push(`${header}${question?.question ?? ''}`)
    lines.push('')
    lines.push(truncate(plan, 1800))
    if (plan.length > 1800) lines.push('', '📄 Полный план — в файле `plan.md`.')
    return lines.join('\n')
  }

  function isPlanReview(record) {
    return planQuestionOf(record) !== undefined
  }

  function planAnswerText(record, answer) {
    const { approve } = planLabels(record)
    const selected = answer?.selected?.[0]
    if (selected === approve) return '✅ **План одобрен** — выходим из режима плана.'
    if (answer?.custom) return `📝 **Фидбек отправлен агенту:**\n\n${truncate(answer.custom, 800)}`
    return '📝 **Остаёмся в режиме плана** — правь план дальше.'
  }

  function optionRows(record) {
    if (record.questions.length !== 1) return undefined
    const question = record.questions[0]
    if (question?.multiSelect) return undefined
    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length === 0 || options.length > 8) return undefined
    return options.map((option, index) => [
      callbackButton(truncate(option?.label ?? `Вариант ${index + 1}`, 60), {
        t: 'q',
        tk: record.token,
        oi: index,
      }),
    ])
  }

  async function handleQuestions(request, next) {
    const guiPromise = next()
    if (!enabled || disposed) return guiPromise
    if (questionChannel === 'gui') return guiPromise
    if (!isTopLevelAgent(request?.agent)) return guiPromise
    if (typeof client.sendMessage !== 'function') return guiPromise

    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return guiPromise

    const token = randomUUID()
    const record = {
      kind: 'question',
      token,
      chatId: target?.chatId,
      questions,
      answers: new Map(),
      messageId: undefined,
      resolve: undefined,
    }

    try {
      if (isPlanReview(record)) {
        const attachments = await planFileAttachments(record)
        try {
          record.messageId = await sendCard(renderPlanCard(record), optionRows(record), attachments)
        } catch (error) {
          // Some clients reject a file + inline keyboard in one message; the
          // review card alone is still useful.
          logger?.warn?.('cannot send plan.md with the review card, retrying without the file: %s', error?.message || String(error))
          record.messageId = await sendCard(renderPlanCard(record), optionRows(record))
        }
      } else {
        record.messageId = await sendCard(renderQuestionCard(record), optionRows(record))
      }
    } catch (error) {
      logger?.warn?.('cannot send question card to MAX: %s', error?.message || String(error))
      return guiPromise
    }

    const chatPromise = new Promise((resolve) => {
      record.resolve = resolve
    })
    pending.set(token, record)
    state?.addPendingCard?.({ token, kind: 'question', messageId: record.messageId, chatId: target?.chatId })
    addQuestionToken(record)

    const onAbort = () => {
      if (pending.get(token) === record) {
        pending.delete(token)
        dropQuestionToken(record)
        record.resolve({ answers: answersArray(record) })
      }
    }
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })

    try {
      const guiOutcome = guiPromise.then(
        (answer) => ({ from: 'gui', answer }),
        (error) => ({ from: 'gui-error', error }),
      )
      const winner = await Promise.race([
        chatPromise.then((answer) => ({ from: 'chat', answer })),
        guiOutcome,
      ])
      if (disposed) return { answers: answersArray(record) }
      if (winner.from === 'chat') {
        void guiPromise.catch(() => {})
        if (isPlanReview(record)) {
          const first = record.questions[0]
          await editCard(record.messageId, planAnswerText(record, record.answers.get(first.id)))
        } else {
          await editCard(record.messageId, `✅ **Ответ отправлен из MAX**\n\n${truncate(describeAnswers(record), 800)}`)
        }
        return winner.answer
      }
      if (winner.from === 'gui-error') {
        await editCard(record.messageId, '⚠️ **Ответ не получен (ошибка GUI)**')
        throw winner.error
      }
      await editCard(record.messageId, '🖥 **Ответ дан в GUI**')
      return winner.answer
    } finally {
      pending.delete(token)
      state?.removePendingCard?.(token)
      dropQuestionToken(record)
      request?.signal?.removeEventListener?.('abort', onAbort)
    }
  }

  function describeAnswers(record) {
    return record.questions
      .map((question) => {
        const answer = record.answers.get(question.id)
        if (!answer) return `${question.question}: —`
        const selected = answer.selected?.length ? answer.selected.join(', ') : ''
        const custom = answer.custom ? ` (${answer.custom})` : ''
        return `${question.question}: ${selected}${custom}`
      })
      .join('\n')
  }

  /** Parse a free-text answer for the oldest pending question card in this chat. */
  async function tryAnswerText({ chatId, userId, text } = {}) {
    if (!enabled) return false
    const key = chatKey(chatId)
    const tokens = questionsByChat.get(key)
    if (!tokens || tokens.size === 0) return false
    const token = [...tokens][0]
    const record = pending.get(token)
    if (!record) return false

    const value = String(text ?? '').trim()
    if (value === '') return true
    applyTextAnswer(record, value)

    if (allAnswered(record)) {
      if (isPlanReview(record)) {
        const first = record.questions[0]
        await editCard(record.messageId, planAnswerText(record, record.answers.get(first.id)))
      } else {
        await editCard(record.messageId, `✅ **Ответ отправлен из MAX**\n\n${truncate(describeAnswers(record), 800)}`)
      }
      pending.delete(token)
      state?.removePendingCard?.(token)
      dropQuestionToken(record)
      record.resolve({ answers: answersArray(record) })
    } else {
      await editCard(record.messageId, renderQuestionCard(record))
    }
    return true
  }

  function applyTextAnswer(record, value) {
    const questions = record.questions
    if (questions.length === 1) {
      const question = questions[0]
      const options = Array.isArray(question.options) ? question.options : []
      const asNumber = /^\d+$/.exec(value)
      if (asNumber && options[Number(asNumber[0]) - 1]) {
        record.answers.set(question.id, { selected: [options[Number(asNumber[0]) - 1].label] })
        return
      }
      const byLabel = options.find((option) => String(option?.label ?? '').toLowerCase() === value.toLowerCase())
      if (byLabel) {
        record.answers.set(question.id, { selected: [byLabel.label] })
        return
      }
      if (question.multiSelect) {
        const indexes = value.split(/[\s,;]+/).map((part) => Number(part)).filter((n) => Number.isInteger(n))
        const labels = indexes.map((index) => options[index - 1]?.label).filter(Boolean)
        if (labels.length > 0) {
          record.answers.set(question.id, { selected: labels })
          return
        }
      }
      record.answers.set(question.id, { selected: [], custom: value })
      return
    }

    const tokens = value.split(/[\s,;]+/).filter(Boolean)
    const numeric = tokens.every((part) => /^\d+$/.test(part))
    const allOptioned = questions.every((question) => Array.isArray(question.options) && question.options.length > 0)
    if (numeric && allOptioned && tokens.length === questions.length) {
      questions.forEach((question, index) => {
        const option = question.options[Number(tokens[index]) - 1]
        if (option) record.answers.set(question.id, { selected: [option.label] })
      })
      return
    }
    const next = questions.find((question) => !record.answers.has(question.id))
    if (next) record.answers.set(next.id, { selected: [], custom: value })
  }

  // ── callbacks ────────────────────────────────────────────────────────────

  /**
   * Handle one `message_callback` for approval/question cards.
   * @returns {Promise<boolean>} true when the callback belonged to this module.
   */
  async function handleCallback({ callbackId, payload } = {}) {
    if (!callbackId || typeof payload !== 'string') return false
    let data
    try {
      data = JSON.parse(payload)
    } catch {
      return false
    }
    if (!data || (data.t !== 'ap' && data.t !== 'q')) return false
    const record = pending.get(data.tk)
    if (!record) {
      try {
        await client.answerCallback(callbackId, { notification: 'Это действие уже неактуально.' })
      } catch (error) {
        logger?.debug?.('cannot answer stale callback: %s', error?.message || String(error))
      }
      return true
    }

    if (data.t === 'ap') {
      pending.delete(record.token)
      state?.removePendingCard?.(record.token)
      const allowed = data.v === 'allow' || data.v === 'allow-always'
      const remembered = data.v === 'allow-always' && record.toolName
      if (remembered) {
        state?.setApprovalRule?.(record.toolName, Date.now() + rememberMs)
      }
      try {
        await client.answerCallback(callbackId, {
          notification: remembered ? '✅ Разрешено и запомнено' : allowed ? '✅ Разрешено' : '⛔ Отклонено',
        })
      } catch (error) {
        logger?.debug?.('cannot answer approval callback: %s', error?.message || String(error))
      }
      await editCard(
        record.messageId,
        formatApprovalResult({
          outcome: allowed ? 'allowed-once' : 'rejected',
          toolName: record.toolName,
          by: 'max',
        }) + (remembered ? '\n\n♾️ Правило запомнено для этого инструмента.' : ''),
      )
      record.audited = true
      audit?.approve?.({
        tool: record.toolName,
        outcome: allowed ? 'allowed-once' : 'rejected',
        source: remembered ? 'max-remember' : 'max',
      })
      record.resolve(allowed ? 'allowed-once' : 'rejected')
      return true
    }

    // question option
    const question = record.questions[0]
    const options = Array.isArray(question?.options) ? question.options : []
    const option = options[data.oi]
    if (option) record.answers.set(question.id, { selected: [option.label] })
    if (allAnswered(record)) {
      pending.delete(record.token)
      state?.removePendingCard?.(record.token)
      dropQuestionToken(record)
      try {
        await client.answerCallback(callbackId, { notification: '✅ Ответ отправлен' })
      } catch (error) {
        logger?.debug?.('cannot answer question callback: %s', error?.message || String(error))
      }
      if (isPlanReview(record)) {
        await editCard(record.messageId, planAnswerText(record, record.answers.get(question.id)))
      } else {
        await editCard(record.messageId, `✅ **Ответ отправлен из MAX**\n\n${truncate(describeAnswers(record), 800)}`)
      }
      record.resolve({ answers: answersArray(record) })
    } else {
      try {
        await client.answerCallback(callbackId, { notification: 'Принято' })
      } catch (error) {
        logger?.debug?.('cannot answer question callback: %s', error?.message || String(error))
      }
      await editCard(record.messageId, renderQuestionCard(record))
    }
    return true
  }

  function dispose() {
    disposed = true
    for (const record of pending.values()) {
      state?.removePendingCard?.(record.token)
      if (record.messageId) {
        void editCard(
          record.messageId,
          record.kind === 'approval'
            ? '♻️ **Плагин перезагружен** — прими решение в GUI.'
            : '♻️ **Плагин перезагружен** — ответь в GUI.',
        )
      }
      if (record.kind === 'approval') record.resolve('cancelled')
      else if (record.kind === 'question') record.resolve({ answers: answersArray(record) })
    }
    pending.clear()
    questionsByChat.clear()
  }

  return { handleApproval, handleQuestions, handleCallback, tryAnswerText, dispose, APPROVAL_TARGET }
}
