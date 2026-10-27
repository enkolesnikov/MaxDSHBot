/**
 * MAX side of the remote control ("Пульт"):
 *
 *  - long-polling `GET /updates` with a persisted marker (one poller per token);
 *  - incoming text from the allowlisted owner becomes the next agent prompt
 *    (`sessionController.prompt`), commands drive `/status`, `/stop`,
 *    `/sessions`, `/use`, `/current`, `/help`;
 *  - inline-keyboard callbacks for approvals/questions and for the quick
 *    actions under the final answer.
 */
import { randomUUID } from 'node:crypto'
import {
  formatAccepted,
  formatHelpCard,
  formatSessionsCard,
  formatStatusCard,
  shortSessionId,
  truncate,
} from './cards.mjs'
import { formatBytes } from './incoming.mjs'

const COMMANDS = [
  { name: 'help', description: 'Справка по командам' },
  { name: 'status', description: 'Статус активной сессии' },
  { name: 'stop', description: 'Остановить текущий ход' },
  { name: 'sessions', description: 'Список сессий' },
  { name: 'use', description: 'Выбрать сессию: /use N' },
  { name: 'current', description: 'Текущая сессия' },
  { name: 'mode', description: 'Режим уведомлений: all|errors|mute' },
  { name: 'mute', description: 'Тишина: /mute 30m или /mute 2h' },
  { name: 'unmute', description: 'Вернуть уведомления' },
  { name: 'digest', description: 'Дайджест сейчас' },
]

const UPDATE_TYPES = 'message_created,message_callback,bot_started,bot_added,bot_removed'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createBot({ client, config, logger, state, interactions, runtime, policy, observer } = {}) {
  let running = false
  let disposed = false
  /** chatKey -> ordered session ids for `/use N` */
  const choices = new Map()

  function targetQuery() {
    if (config.chatId !== undefined) return { chatId: config.chatId }
    if (config.userId !== undefined) return { userId: config.userId }
    return {}
  }

  function chatKey(chatId) {
    return String(chatId ?? config.chatId ?? config.userId ?? 'default')
  }

  function isAllowed(userId, chatId) {
    const users = new Set(config.allowedUserIds ?? [])
    const chats = new Set(config.allowedChatIds ?? [])
    if (users.size === 0 && chats.size === 0) return true
    if (userId !== undefined && userId !== null && users.has(String(userId))) return true
    if (chatId !== undefined && chatId !== null && chats.has(String(chatId))) return true
    return false
  }

  async function reply(chatId, text, extra = {}) {
    try {
      const response = await client.sendMessage({
        ...(chatId !== undefined ? { chatId } : targetQuery()),
        text,
        format: config.format,
        notify: config.notify,
        disableLinkPreview: true,
        ...extra,
      })
      return response?.message?.body?.mid
    } catch (error) {
      logger?.warn?.('cannot send MAX message: %s', error?.message || String(error))
      return undefined
    }
  }

  async function listSessions() {
    try {
      const items = (await runtime.listSessions?.()) ?? []
      return items.filter((item) => item && !item.blank && item.origin !== 'subagent')
    } catch (error) {
      logger?.warn?.('cannot list sessions: %s', error?.message || String(error))
      return []
    }
  }

  async function activeSession(chatId) {
    const stored = state?.sessionFor?.(chatId)
    if (stored) return stored
    const items = await listSessions()
    const picked = items.find((item) => item.running) ?? items[0]
    if (picked?.sessionId) {
      state?.setSession?.(chatId, picked.sessionId)
      return picked.sessionId
    }
    return undefined
  }

  async function describeSession(sessionId) {
    const info = (await runtime.statusInfo?.(sessionId)) ?? { sessionId }
    return formatStatusCard(info)
  }

  function parseDurationMs(value, fallbackMs) {
    const match = /^(\d+)\s*([mh])?$/i.exec(String(value ?? '').trim())
    if (!match) return fallbackMs
    const amount = Number(match[1])
    const unit = (match[2] ?? 'm').toLowerCase()
    return amount * (unit === 'h' ? 60 : 1) * 60 * 1000
  }

  async function handleCommand(text, { chatId } = {}) {
    const match = /^\/([a-z0-9_-]+)/i.exec(text)
    if (!match) return false
    const name = match[1].toLowerCase()
    const arg = text.slice(match[0].length).trim()

    switch (name) {
      case 'start':
      case 'help': {
        await reply(chatId, formatHelpCard())
        return true
      }
      case 'status': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) await reply(chatId, 'Нет активной сессии. Открой GUI или напиши агенту первым сообщением.')
        else await reply(chatId, await describeSession(sessionId))
        return true
      }
      case 'current': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) await reply(chatId, 'Нет активной сессии.')
        else await reply(chatId, await describeSession(sessionId))
        return true
      }
      case 'stop': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const ok = await runtime.cancelSession?.(sessionId)
        await reply(chatId, ok ? `⏹ Остановлено: \`${shortSessionId(sessionId)}\`` : 'Нечего останавливать (агент не работает).')
        return true
      }
      case 'sessions': {
        const items = await listSessions()
        const active = state?.sessionFor?.(chatId) ?? (await activeSession(chatId))
        choices.set(chatKey(chatId), items.map((item) => item.sessionId))
        await reply(chatId, formatSessionsCard({ items, activeId: active }))
        return true
      }
      case 'use': {
        let items = choices.get(chatKey(chatId))
        if (!items) {
          const sessions = await listSessions()
          items = sessions.map((item) => item.sessionId)
          choices.set(chatKey(chatId), items)
        }
        const index = Number(arg) - 1
        if (!Number.isInteger(index) || index < 0 || index >= items.length) {
          await reply(chatId, `Укажи номер из /sessions (сейчас ${items.length}).`)
          return true
        }
        const sessionId = items[index]
        state?.setSession?.(chatId, sessionId)
        await reply(chatId, `▶️ Активная сессия: \`${shortSessionId(sessionId)}\``)
        return true
      }
      case 'mode': {
        if (!policy) {
          await reply(chatId, 'Режимы уведомлений недоступны (нет policy).')
          return true
        }
        const requested = arg.toLowerCase()
        if (requested === 'all' || requested === 'errors' || requested === 'mute') {
          policy.setMode(requested)
          await reply(chatId, policy.describe())
          return true
        }
        await reply(chatId, `${policy.describe()}\n\nИспользование: /mode all|errors|mute`)
        return true
      }
      case 'mute': {
        if (!policy) {
          await reply(chatId, 'Режимы уведомлений недоступны (нет policy).')
          return true
        }
        const durationMs = parseDurationMs(arg, 2 * 60 * 60 * 1000)
        policy.setMode('mute', durationMs)
        await reply(chatId, policy.describe())
        return true
      }
      case 'unmute': {
        if (!policy) {
          await reply(chatId, 'Режимы уведомлений недоступны (нет policy).')
          return true
        }
        policy.setMode('all')
        await reply(chatId, policy.describe())
        return true
      }
      case 'digest': {
        if (!observer?.sendDigest) {
          await reply(chatId, 'Дайджест недоступен.')
          return true
        }
        await observer.sendDigest()
        await reply(chatId, '📊 Дайджест отправлен.')
        return true
      }
      default: {
        await reply(chatId, `Неизвестная команда \`/${name}\`.\n\n${formatHelpCard()}`)
        return true
      }
    }
  }

  async function handleIncomingFiles({ chatId, attachments, text }) {
    if (!config.receiveFiles) {
      await reply(chatId, '📎 Приём файлов отключён (`receiveFiles: false`).')
      return
    }
    const sessionId = await activeSession(chatId)
    if (!sessionId) {
      await reply(chatId, '📎 Нет активной сессии — файл не сохранён. Открой GUI или выбери сессию через `/sessions`.')
      return
    }
    if (!runtime?.saveIncoming) {
      await reply(chatId, '📎 Приём файлов недоступен.')
      return
    }
    let result
    try {
      result = await runtime.saveIncoming(attachments, sessionId)
    } catch (error) {
      logger?.warn?.('cannot save incoming MAX files: %s', error?.message || String(error))
      await reply(chatId, `❌ Не удалось сохранить файлы: ${error?.message || String(error)}`)
      return
    }
    const saved = result?.saved ?? []
    const errors = result?.errors ?? []
    if (saved.length === 0) {
      await reply(
        chatId,
        `❌ Не удалось сохранить файлы${errors.length > 0 ? `:\n• ${errors.join('\n• ')}` : '.'}`,
      )
      return
    }
    const filesText = saved.map((file) => `• ${file.path} (${file.type}, ${formatBytes(file.bytes)})`).join('\n')
    const promptText = `${text ? `${text}\n\n` : ''}${result?.promptText ?? ''}`.trim()
    const accepted = await runtime.promptSession?.(sessionId, promptText)
    const tail = errors.length > 0 ? `\n⚠️ ${errors.join('; ')}` : ''
    await reply(
      chatId,
      accepted
        ? `📎 Сохранено: ${saved.length}\n${filesText}\n📨 Передано агенту${tail}`
        : `📎 Сохранено: ${saved.length}\n${filesText}\n❌ Не удалось передать агенту${tail}`,
    )
  }

  async function handlePrompt(chatId, text) {
    const sessionId = await activeSession(chatId)
    if (!sessionId) {
      await reply(chatId, 'Нет активной сессии. Открой GUI или используй `/sessions`.')
      return
    }
    const accepted = await runtime.promptSession?.(sessionId, text)
    if (accepted) {
      state?.setSession?.(chatId, sessionId)
      const title = runtime.titleFor?.(sessionId)
      await reply(chatId, formatAccepted({ title, text }))
    } else {
      await reply(chatId, '❌ Не удалось отправить сообщение в сессию (она недоступна или конфликтует с другим писателем).')
    }
  }

  async function handleQuickAction({ callbackId, payload }) {
    if (typeof payload !== 'string') return false
    let data
    try {
      data = JSON.parse(payload)
    } catch {
      return false
    }
    if (!data || data.t !== 'qa') return false
    const sessionId = typeof data.s === 'string' ? data.s : undefined
    try {
      if (data.a === 'cont' && sessionId) {
        await client.answerCallback(callbackId, { notification: '📨 Продолжаю…' })
        const ok = await runtime.promptSession?.(sessionId, 'продолжай')
        if (!ok) await reply(undefined, '❌ Не удалось продолжить сессию.')
        return true
      }
      if (data.a === 'stop') {
        await client.answerCallback(callbackId, { notification: '⏹ Останавливаю…' })
        const ok = sessionId ? await runtime.cancelSession?.(sessionId) : false
        if (!ok) await reply(undefined, 'Нечего останавливать.')
        return true
      }
    } catch (error) {
      logger?.warn?.('quick action failed: %s', error?.message || String(error))
      return true
    }
    return false
  }

  async function handleCallback(update) {
    const callback = update.callback ?? {}
    const callbackId = callback.callback_id
    if (!callbackId) return
    const payload = callback.payload
    const userId = callback.user?.user_id ?? update.message?.sender?.user_id
    const chatId = update.message?.recipient?.chat_id ?? update.chat_id
    if (!isAllowed(userId, chatId)) {
      try {
        await client.answerCallback(callbackId, { notification: 'Нет доступа.' })
      } catch {
        // ignore
      }
      return
    }
    try {
      if (interactions?.handleCallback && (await interactions.handleCallback({ callbackId, payload }))) return
      if (await handleQuickAction({ callbackId, payload })) return
      await client.answerCallback(callbackId, { notification: 'Действие устарело.' })
    } catch (error) {
      logger?.warn?.('cannot handle MAX callback: %s', error?.message || String(error))
    }
  }

  async function handleMessageCreated(update) {
    const message = update.message
    if (!message || message.sender?.is_bot) return
    const chatId = update.chat_id ?? message.recipient?.chat_id
    const userId = message.sender?.user_id
    if (!isAllowed(userId, chatId)) {
      logger?.warn?.('ignored MAX message from non-allowlisted user %s', userId)
      return
    }
    const text = String(message.body?.text ?? '').trim()
    if (interactions?.tryAnswerText && (await interactions.tryAnswerText({ chatId, userId, text }))) return
    const attachments = Array.isArray(message.body?.attachments) ? message.body.attachments : []
    if (attachments.length > 0) {
      await handleIncomingFiles({ chatId, attachments, text })
      return
    }
    if (text === '') return
    if (text.startsWith('/')) {
      await handleCommand(text, { chatId, userId })
      return
    }
    await handlePrompt(chatId, text)
  }

  async function handleUpdate(update) {
    if (!update || typeof update.update_type !== 'string') return
    switch (update.update_type) {
      case 'bot_started': {
        if (!isAllowed(update.user?.user_id, update.chat_id)) return
        if (config.greetOnStart) await reply(update.chat_id, formatHelpCard())
        return
      }
      case 'message_created':
        await handleMessageCreated(update)
        return
      case 'message_callback':
        await handleCallback(update)
        return
      case 'bot_added':
        logger?.info?.('bot added to MAX chat %s', update.chat_id)
        return
      case 'bot_removed':
        logger?.warn?.('bot removed from MAX chat %s', update.chat_id)
        return
      default:
        return
    }
  }

  async function registerCommands() {
    if (!config.registerCommands) return
    try {
      await client.setCommands(COMMANDS)
      logger?.info?.('registered %d MAX bot commands', COMMANDS.length)
    } catch (error) {
      logger?.debug?.('cannot register MAX bot commands: %s', error?.message || String(error))
    }
  }

  /** One long-poll iteration; returns `{primed, count}` (exposed for tests). */
  async function pollOnce() {
    const params = {
      timeout: Math.max(0, Math.min(90, config.pollTimeoutSec ?? 25)),
      limit: 100,
      types: UPDATE_TYPES,
    }
    if (state?.marker === undefined) {
      const response = await client.getUpdates(params)
      state?.setMarker?.(response?.marker)
      return { primed: true, count: 0 }
    }
    const response = await client.getUpdates({ ...params, marker: state.marker })
    if (response?.marker !== undefined) state?.setMarker?.(response.marker)
    const updates = Array.isArray(response?.updates) ? response.updates : []
    for (const update of updates) {
      try {
        await handleUpdate(update)
      } catch (error) {
        logger?.warn?.('cannot handle MAX update: %s', error?.message || String(error))
      }
    }
    return { primed: false, count: updates.length }
  }

  async function pollLoop() {
    let backoffMs = 1000
    while (running && !disposed) {
      try {
        await pollOnce()
        backoffMs = 1000
        await sleep(200)
      } catch (error) {
        const status = error?.status
        if (status === 401) {
          logger?.warn?.('MAX polling stopped: unauthorized (check MAX_BOT_TOKEN)')
          running = false
          return
        }
        if (status === 405 || status === 409) {
          logger?.warn?.(
            'MAX polling stopped (%s): long polling is disabled while a webhook subscription is active',
            status,
          )
          running = false
          return
        }
        logger?.warn?.('MAX polling error: %s', error?.message || String(error))
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30000)
      }
    }
  }

  async function start() {
    if (disposed || !config.polling) return
    if (!config.botToken) return
    if (config.chatId === undefined && config.userId === undefined) return
    if (typeof client.getUpdates !== 'function') return
    if (running) return
    running = true
    void registerCommands()
    void pollLoop()
    logger?.info?.('MAX polling started (long poll)')
  }

  function stop() {
    running = false
    disposed = true
  }

  /** Remember the session that just produced a forwarded reply (default target). */
  function noteSession(sessionId) {
    if (config.chatId === undefined || !sessionId) return
    if (!state?.sessionFor?.(config.chatId)) state?.setSession?.(config.chatId, sessionId)
  }

  return {
    start,
    stop,
    pollOnce,
    handleUpdate,
    handleCommand,
    noteSession,
    isAllowed,
    registerCommands,
  }
}

export { COMMANDS }
