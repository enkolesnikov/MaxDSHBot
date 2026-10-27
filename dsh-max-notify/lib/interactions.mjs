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
export function createInteractions({ client, config, logger, target, resolveTitle } = {}) {
  /** token -> pending interaction */
  const pending = new Map()
  /** chat key -> Set<token> for text-answered questions */
  const questionsByChat = new Map()
  let disposed = false

  const enabled = config?.interactive !== false
  const approvalChannel = config?.approvalChannel ?? 'both'
  const questionChannel = config?.questionChannel ?? 'both'

  function targetQuery() {
    if (target?.chatId !== undefined) return { chatId: target.chatId }
    if (target?.userId !== undefined) return { userId: target.userId }
    return {}
  }

  function chatKey(chatId) {
    return String(chatId ?? target?.chatId ?? target?.userId ?? 'default')
  }

  async function sendCard(text, rows) {
    const params = {
      ...targetQuery(),
      text,
      format: config?.format,
      notify: config?.notify,
      disableLinkPreview: true,
    }
    if (rows) params.attachments = keyboard(rows)
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
    const guiPromise = next()
    if (!enabled || disposed) return guiPromise
    if (approvalChannel === 'gui') return guiPromise
    if (!isTopLevelAgent(request?.agent)) return guiPromise
    if (typeof client.sendMessage !== 'function') return guiPromise

    const token = randomUUID()
    const title = resolveTitle?.(request?.agent?.session)
    const displayReason =
      request?.displayReason?.ru ??
      request?.displayReason?.en ??
      Object.values(request?.displayReason ?? {})[0]
    const text = formatApprovalCard({
      title,
      toolName: request?.toolName,
      reason: displayReason ?? request?.reason,
      callId: request?.callId,
    })

    let messageId
    try {
      messageId = await sendCard(text, [
        [callbackButton('✅ Разрешить', { t: 'ap', tk: token, v: 'allow' })],
        [callbackButton('❌ Отклонить', { t: 'ap', tk: token, v: 'deny' })],
      ])
    } catch (error) {
      logger?.warn?.('cannot send approval card to MAX: %s', error?.message || String(error))
      return guiPromise
    }

    const record = { kind: 'approval', token, messageId, chatId: target?.chatId, resolve: undefined }
    const chatPromise = new Promise((resolve) => {
      record.resolve = resolve
    })
    pending.set(token, record)

    const onAbort = () => {
      if (pending.get(token) === record) {
        pending.delete(token)
        record.resolve('cancelled')
      }
    }
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })

    try {
      const guiOutcome = guiPromise.then(
        (outcome) => ({ from: 'gui', outcome }),
        (error) => ({ from: 'gui-error', error }),
      )
      const winner = await Promise.race([chatPromise.then((outcome) => ({ from: 'chat', outcome })), guiOutcome])

      if (winner.from === 'chat') {
        void guiPromise.catch(() => {})
        await editCard(messageId, formatApprovalResult({ outcome: winner.outcome, toolName: request?.toolName, by: 'max' }))
        return winner.outcome
      }
      if (winner.from === 'gui-error') {
        await editCard(messageId, formatApprovalResult({ outcome: 'unavailable', toolName: request?.toolName }))
        throw winner.error
      }
      await editCard(messageId, formatApprovalResult({ outcome: winner.outcome, toolName: request?.toolName, by: 'gui' }))
      return winner.outcome
    } finally {
      pending.delete(token)
      request?.signal?.removeEventListener?.('abort', onAbort)
    }
  }

  // ── questions ────────────────────────────────────────────────────────────

  function renderQuestionCard(record) {
    return formatQuestionCard({ questions: record.questions, answered: record.answers.size })
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
      record.messageId = await sendCard(renderQuestionCard(record), optionRows(record))
    } catch (error) {
      logger?.warn?.('cannot send question card to MAX: %s', error?.message || String(error))
      return guiPromise
    }

    const chatPromise = new Promise((resolve) => {
      record.resolve = resolve
    })
    pending.set(token, record)
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
      if (winner.from === 'chat') {
        void guiPromise.catch(() => {})
        await editCard(record.messageId, `✅ **Ответ отправлен из MAX**\n\n${truncate(describeAnswers(record), 800)}`)
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
      await editCard(record.messageId, `✅ **Ответ отправлен из MAX**\n\n${truncate(describeAnswers(record), 800)}`)
      pending.delete(token)
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
      try {
        await client.answerCallback(callbackId, { notification: data.v === 'allow' ? '✅ Разрешено' : '⛔ Отклонено' })
      } catch (error) {
        logger?.debug?.('cannot answer approval callback: %s', error?.message || String(error))
      }
      await editCard(
        record.messageId,
        formatApprovalResult({
          outcome: data.v === 'allow' ? 'allowed-once' : 'rejected',
          by: 'max',
        }),
      )
      record.resolve(data.v === 'allow' ? 'allowed-once' : 'rejected')
      return true
    }

    // question option
    const question = record.questions[0]
    const options = Array.isArray(question?.options) ? question.options : []
    const option = options[data.oi]
    if (option) record.answers.set(question.id, { selected: [option.label] })
    if (allAnswered(record)) {
      pending.delete(record.token)
      dropQuestionToken(record)
      try {
        await client.answerCallback(callbackId, { notification: '✅ Ответ отправлен' })
      } catch (error) {
        logger?.debug?.('cannot answer question callback: %s', error?.message || String(error))
      }
      await editCard(record.messageId, `✅ **Ответ отправлен из MAX**\n\n${truncate(describeAnswers(record), 800)}`)
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
      if (record.kind === 'approval') record.resolve('cancelled')
      else if (record.kind === 'question') record.resolve({ answers: answersArray(record) })
    }
    pending.clear()
    questionsByChat.clear()
  }

  return { handleApproval, handleQuestions, handleCallback, tryAnswerText, dispose, APPROVAL_TARGET }
}
