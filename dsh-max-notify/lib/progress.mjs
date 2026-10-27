/**
 * Live progress card: one MAX message that is edited while the agent works
 * ("⏳ Работаю · 12s · 🔧 bash"), plus a typing indicator. The card is deleted
 * when the turn ends — the final answer arrives as the normal notification.
 */
import { truncate } from './cards.mjs'

function isTopLevelSession(session) {
  const header = session?.header
  if (!header) return true
  if (header.origin === 'subagent') return false
  return !(Number(header.delegationDepth ?? 0) > 0)
}

export function createProgress({ client, config, logger, target } = {}) {
  /** sessionId -> { session, startedAt, text, tool, messageId, timers... } */
  const active = new Map()
  let disposed = false

  const targetQuery = () =>
    target?.chatId !== undefined ? { chatId: target.chatId } : { userId: target?.userId }

  function statusText(record) {
    const elapsed = Math.max(1, Math.round((Date.now() - record.startedAt) / 1000))
    const lines = [`⏳ **Работаю** · ${elapsed}s`]
    if (record.tool) lines.push(`🔧 \`${truncate(record.tool, 60)}\``)
    const tail = String(record.text ?? '').trim()
    if (tail) lines.push('', truncate(tail, config.progressTextLimit))
    return lines.join('\n')
  }

  function stopTimers(record) {
    for (const key of ['createTimer', 'editTimer', 'typingTimer']) {
      if (record[key]) {
        clearTimeout(record[key])
        clearInterval(record[key])
        record[key] = undefined
      }
    }
  }

  async function createCard(record) {
    if (disposed || !active.has(record.id)) return
    try {
      const response = await client.sendMessage({
        ...targetQuery(),
        text: statusText(record),
        format: config.format,
        notify: false,
        disableLinkPreview: true,
      })
      record.messageId = response?.message?.body?.mid
      startTyping(record)
    } catch (error) {
      logger?.debug?.('cannot create progress card: %s', error?.message || String(error))
    }
  }

  function startTyping(record) {
    if (disposed || !config.typing || target?.chatId === undefined) return
    const tick = () => {
      if (disposed || !active.has(record.id)) return
      Promise.resolve(client.sendAction(target.chatId, 'typing_on')).catch(() => {})
    }
    tick()
    record.typingTimer = setInterval(tick, 4000)
    record.typingTimer.unref?.()
  }

  function requestUpdate(record) {
    if (disposed || !active.has(record.id) || !record.messageId) return
    if (record.editTimer) return
    const wait = Math.max(0, config.progressThrottleMs - (Date.now() - record.lastEdit))
    record.editTimer = setTimeout(() => {
      record.editTimer = undefined
      void flush(record)
    }, wait)
    record.editTimer.unref?.()
  }

  async function flush(record) {
    if (disposed || !active.has(record.id) || !record.messageId) return
    record.lastEdit = Date.now()
    try {
      await client.editMessage({
        messageId: record.messageId,
        text: statusText(record),
        format: config.format,
      })
    } catch (error) {
      logger?.debug?.('cannot edit progress card: %s', error?.message || String(error))
    }
  }

  function onTurnStart(session) {
    if (!config.progress || disposed) return
    if (!isTopLevelSession(session) || !session?.id) return
    const id = String(session.id)
    if (active.has(id)) return
    const record = {
      id,
      session,
      startedAt: Date.now(),
      text: '',
      tool: null,
      messageId: undefined,
      lastEdit: 0,
      createTimer: undefined,
      editTimer: undefined,
      typingTimer: undefined,
    }
    active.set(id, record)
    const delay = Math.max(0, config.progressDelayMs ?? 2000)
    if (delay === 0) void createCard(record)
    else {
      record.createTimer = setTimeout(() => {
        record.createTimer = undefined
        void createCard(record)
      }, delay)
      record.createTimer.unref?.()
    }
  }

  function onStream(session, frame) {
    if (!config.progress || disposed) return
    const record = active.get(String(session?.id ?? ''))
    if (!record) return
    if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') {
      record.text = (record.text + frame.chunk.text).slice(-(config.progressTextLimit * 2))
      requestUpdate(record)
    }
  }

  function onTool(session, execution) {
    if (!config.progress || disposed) return
    const record = active.get(String(session?.id ?? ''))
    if (!record) return
    if (execution?.name) record.tool = execution.name
    requestUpdate(record)
  }

  function onTurnEnd(session) {
    const id = String(session?.id ?? '')
    const record = active.get(id)
    if (!record) return
    active.delete(id)
    stopTimers(record)
    if (record.messageId) {
      Promise.resolve(client.deleteMessage(record.messageId)).catch(async () => {
        try {
          await client.editMessage({ messageId: record.messageId, text: '✅ **Готово**', format: config.format })
        } catch {
          // best effort
        }
      })
    }
  }

  function dispose() {
    disposed = true
    for (const record of active.values()) {
      stopTimers(record)
      if (record.messageId) Promise.resolve(client.deleteMessage(record.messageId)).catch(() => {})
    }
    active.clear()
  }

  return { onTurnStart, onStream, onTool, onTurnEnd, dispose }
}
