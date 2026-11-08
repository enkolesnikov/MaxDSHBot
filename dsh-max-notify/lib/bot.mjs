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
  formatApprovalPolicyCard,
  formatBudgetCard,
  formatCostStatusLine,
  formatHelpCard,
  formatModelsCard,
  formatPlanStateCard,
  formatSearchCard,
  formatSessionsCard,
  formatSettingsCard,
  formatStatusCard,
  formatWorkspacesCard,
  shortSessionId,
  truncate,
} from './cards.mjs'
import { formatBytes } from './incoming.mjs'
import { deleteSchedule, formatSchedulesCard, listSchedules, setScheduleActive } from './schedules.mjs'

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
  { name: 'budget', description: 'Стоимость и бюджет' },
  { name: 'digest', description: 'Дайджест сейчас' },
  { name: 'new', description: 'Новая сессия: /new [папка]' },
  { name: 'model', description: 'Модель: /model или /model N' },
  { name: 'rename', description: 'Переименовать сессию: /rename <название>' },
  { name: 'fork', description: 'Ответвить сессию от текущей' },
  { name: 'compact', description: 'Сжать историю сессии' },
  { name: 'plan', description: 'Режим плана: /plan | /plan off' },
  { name: 'search', description: 'Поиск по сессиям: /search <текст>' },
  { name: 'archive', description: 'Архивировать текущую сессию' },
  { name: 'pin', description: 'Закрепить текущую сессию' },
  { name: 'unpin', description: 'Открепить текущую сессию' },
  { name: 'workspace', description: 'Рабочие папки: /workspace [N|add path]' },
  { name: 'approve', description: 'Политика подтверждений' },
  { name: 'schedules', description: 'Расписания: /schedules [pause|resume|cancel N]' },
  { name: 'settings', description: 'Эффективные настройки плагина' },
  { name: 'health', description: 'Здоровье плагина и очередь' },
  { name: 'version', description: 'Версия плагина' },
  { name: 'ping', description: 'Проверка отклика' },
]

const UPDATE_TYPES = 'message_created,message_callback,bot_started,bot_added,bot_removed'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createBot({
  client,
  config,
  logger,
  state,
  interactions,
  runtime,
  policy,
  observer,
  health,
  version,
  outbox,
  limiter,
  audit,
} = {}) {
  let running = false
  let disposed = false
  let commandsRegistered = false
  /** chatKey -> ordered session ids for `/use N` */
  const choices = new Map()
  /** chatKey -> numbered model list for `/model N` */
  const modelChoices = new Map()
  /** chatKey -> numbered workspace list for `/workspace N` */
  const workspaceChoices = new Map()
  /** chatKey -> { policy, at } pending `/approve <policy> confirm` */
  const approvalConfirms = new Map()
  /** chatKey -> normalized schedule list for `/schedules <action> N` */
  const scheduleChoices = new Map()
  /** chatKey -> { id, at } pending `/schedules cancel N confirm` */
  const scheduleCancels = new Map()
  /** workspace path chosen for subsequent `/new` calls */
  let preferredWorkspacePath
  /** chatKey -> token bucket for incoming flood protection */
  const incomingBuckets = new Map()
  /** chatKey -> last "too fast" warning */
  const incomingWarnedAt = new Map()

  function allowIncoming(key) {
    const perMinute = Math.max(1, Number(config.incomingPerMinute) || 30)
    const burst = Math.max(1, Number(config.incomingBurst) || 10)
    const at = Date.now()
    let bucket = incomingBuckets.get(key)
    if (!bucket) {
      bucket = { tokens: burst, last: at }
      incomingBuckets.set(key, bucket)
    }
    const elapsedMs = at - bucket.last
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, elapsedMs / 1000) * (perMinute / 60))
    bucket.last = at
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return true
    }
    return false
  }

  async function warnTooFast(chatId) {
    const key = chatKey(chatId)
    const at = Date.now()
    if (incomingWarnedAt.has(key) && at - incomingWarnedAt.get(key) < 5 * 60 * 1000) return
    incomingWarnedAt.set(key, at)
    await reply(chatId, '⏳ Слишком часто. Подожди немного — команды и сообщения ограничены, чтобы не зациклить агента.')
  }

  function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0)
    const seconds = Math.floor(value / 1000)
    if (seconds < 60) return `${seconds} с`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} мин`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} ч ${minutes % 60} мин`
    return `${Math.floor(hours / 24)} д ${hours % 24} ч`
  }

  function formatRelative(timestamp) {
    if (!Number.isFinite(timestamp)) return 'никогда'
    return `${formatDuration(Date.now() - timestamp)} назад`
  }

  function healthCard() {
    const snapshot = health?.snapshot?.() ?? {}
    const outboxStats = outbox?.snapshot?.() ?? {}
    const limiterStats = limiter?.snapshot?.() ?? {}
    const lines = [
      `🩺 *dsh-max-notify* v${version ?? '?'}`,
      `⏱ uptime: ${formatDuration(snapshot.uptimeMs)}`,
      `📡 transport: ${snapshot.transport === 'webhook' || snapshot.webhookActive ? 'webhook' : 'long polling'}`,
      `📡 polling: ${snapshot.pollStopped ? `остановлен (${snapshot.pollStoppedReason ?? 'ошибка'})` : 'работает'}`,
      `🕒 последний poll: ${formatRelative(snapshot.lastPollAt)}`,
      `📥 последнее обновление: ${formatRelative(snapshot.lastUpdateAt)}`,
      `📤 outbox: ${outboxStats.pending ?? 0} в очереди, доставлено ${outboxStats.sent ?? 0}, ошибок ${outboxStats.failed ?? 0}`,
      `🚦 limiter: очередь ${limiterStats.queueDepth ?? 0}, ожиданий ${limiterStats.waits ?? 0}, 429-паузы…`,
      `🛡 allowlist: ${(config.allowedUserIds ?? []).length} users / ${(config.allowedChatIds ?? []).length} chats`,
      `🧩 режим: ${policy?.describe?.() ?? '—'}`,
    ]
    if (snapshot.webhookActive) {
      lines.push(
        `🔗 webhook: ${snapshot.webhookSubscribed ? 'подписан' : 'подписка не подтверждена'} · очередь ${snapshot.webhookQueueDepth ?? 0}`,
      )
      if (snapshot.webhookSubscriptionError) lines.push(`⚠️ webhook: ${truncate(snapshot.webhookSubscriptionError, 300)}`)
    }
    if (snapshot.lastError) lines.push(`⚠️ последняя ошибка: ${truncate(snapshot.lastError, 300)}`)
    return lines.join('\n')
  }

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
    const card = formatStatusCard(info)
    const snapshot = await runtime.costSnapshot?.()
    if (!snapshot) return card
    const sessionAmount = await runtime.costForSession?.(sessionId)
    return `${card}\n${formatCostStatusLine({ snapshot, sessionAmount })}`
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
    audit?.command?.({ command: name, chatId })

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
        let items = await listSessions()
        const active = state?.sessionFor?.(chatId) ?? (await activeSession(chatId))
        if (active && !items.some((item) => String(item.sessionId) === String(active))) {
          const info = (await runtime.statusInfo?.(active)) ?? {}
          items = [
            {
              sessionId: active,
              title: info.title,
              running: info.running ?? false,
              cwd: info.cwd,
              updatedAt: info.updatedAt ?? Date.now(),
            },
            ...items,
          ]
        }
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
      case 'new': {
        const active = await activeSession(chatId)
        const created = await runtime.createSession?.(active, arg.trim() || undefined)
        if (!created?.ok) {
          await reply(chatId, `❌ Не удалось создать сессию: ${created?.error || 'неизвестная ошибка'}`)
          return true
        }
        state?.setSession?.(chatId, created.sessionId)
        await reply(
          chatId,
          `🆕 Сессия создана: \`${shortSessionId(created.sessionId)}\`\n📁 ${created.cwd}\n\nНапиши задачу — она уйдёт в эту сессию.`,
        )
        return true
      }
      case 'health': {
        await reply(chatId, healthCard())
        return true
      }
      case 'version': {
        await reply(
          chatId,
          `🛠 dsh-max-notify v${version ?? '?'}\nNode ${process.version}\nDSH: host plugin (long polling)`,
        )
        return true
      }
      case 'ping': {
        const startedAt = Date.now()
        await reply(chatId, `🏓 pong · ${Date.now() - startedAt} мс`)
        return true
      }
      case 'model': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const listed = (await runtime.listModels?.()) ?? { items: [], failures: [] }
        const models = listed.items ?? []
        if (arg === '' || arg === 'list') {
          modelChoices.set(chatKey(chatId), models)
          const current = await runtime.currentModel?.(sessionId)
          await reply(chatId, formatModelsCard({ current, models, failures: listed.failures }))
          return true
        }
        let picked
        if (/^\d+$/.test(arg)) {
          let cached = modelChoices.get(chatKey(chatId))
          if (!cached) {
            cached = models
            modelChoices.set(chatKey(chatId), cached)
          }
          picked = cached[Number(arg) - 1]
        } else {
          const normalized = arg.trim()
          const [provider, model] = normalized.includes('/') ? normalized.split('/') : ['', normalized]
          picked = models.find(
            (item) =>
              (provider === '' || item.provider === provider) &&
              (item.model === model || `${item.provider}/${item.model}` === normalized),
          )
        }
        if (!picked) {
          await reply(chatId, `Не нашёл модель «${truncate(arg, 80)}». Посмотри список: /model`)
          return true
        }
        const selected = await runtime.selectModel?.(sessionId, { provider: picked.provider, model: picked.model })
        if (!selected?.ok) {
          await reply(chatId, `❌ Не удалось переключить модель: ${selected?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        await reply(chatId, `🧠 Модель: \`${picked.provider}/${picked.model}\` — ${truncate(picked.name ?? picked.model, 80)}`)
        return true
      }
      case 'rename': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const title = arg.trim()
        if (title === '') {
          await reply(chatId, 'Использование: `/rename новое название`')
          return true
        }
        const renamed = await runtime.renameSession?.(sessionId, title)
        if (!renamed?.ok) {
          await reply(chatId, `❌ Не удалось переименовать: ${renamed?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        await reply(chatId, `✏️ Сессия переименована: «${truncate(renamed.title ?? title, 120)}»`)
        return true
      }
      case 'fork': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const forked = await runtime.forkSession?.(sessionId)
        if (!forked?.ok || !forked.sessionId) {
          await reply(chatId, `❌ Не удалось ответвить: ${forked?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        state?.setSession?.(chatId, forked.sessionId)
        await reply(chatId, `🌿 Создана ветка: \`${shortSessionId(forked.sessionId)}\`\nОна стала активной.`)
        return true
      }
      case 'compact': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const result = await runtime.runCommand?.(sessionId, '/compact')
        if (!result?.ok) {
          await reply(chatId, `❌ Сжатие не удалось: ${result?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        await reply(chatId, `🗜 ${truncate(result.text ?? 'История сжата.', 800)}`)
        return true
      }
      case 'plan': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const requested = arg.trim().toLowerCase()
        if (requested === 'status' || requested === '?') {
          const view = await runtime.planState?.(sessionId)
          if (!view?.ok) {
            await reply(chatId, `❌ ${view?.error ?? 'режим плана недоступен'}`)
            return true
          }
          await reply(chatId, formatPlanStateCard({ active: view.active, pending: view.pending }))
          return true
        }
        const active = requested !== 'off'
        const result = await runtime.setPlanMode?.(sessionId, active)
        if (!result?.ok) {
          await reply(chatId, `❌ ${result?.error ?? 'режим плана недоступен'}`)
          return true
        }
        await reply(chatId, formatPlanStateCard({ active: result.active, pending: result.pending, action: result.state }))
        return true
      }
      case 'search': {
        const query = arg.trim()
        if (query === '') {
          await reply(chatId, 'Использование: `/search текст запроса`')
          return true
        }
        const found = await runtime.searchSessions?.(query)
        if (!found?.ok) {
          await reply(chatId, `❌ Поиск не удался: ${found?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        choices.set(
          chatKey(chatId),
          found.items.map((item) => item.sessionId),
        )
        await reply(chatId, formatSearchCard({ query, items: found.items }))
        return true
      }
      case 'archive': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const archived = await runtime.archiveSession?.(sessionId)
        if (!archived?.ok) {
          await reply(chatId, `❌ Не удалось архивировать: ${archived?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        state?.forgetSession?.(chatId)
        const items = await listSessions()
        const next = items[0]
        if (next) {
          state?.setSession?.(chatId, next.sessionId)
          await reply(
            chatId,
            `📦 Сессия \`${shortSessionId(sessionId)}\` в архиве.\n▶️ Активная: ${next.title ? `«${truncate(next.title, 80)}»` : `\`${shortSessionId(next.sessionId)}\``}`,
          )
        } else {
          await reply(chatId, `📦 Сессия \`${shortSessionId(sessionId)}\` в архиве. Активных сессий не осталось.`)
        }
        return true
      }
      case 'pin':
      case 'unpin': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const pinned = name === 'pin'
        const result = await runtime.pinSession?.(sessionId, pinned)
        if (!result?.ok) {
          await reply(chatId, `❌ Не удалось: ${result?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        await reply(chatId, pinned ? '📌 Сессия закреплена.' : '📌 Сессия откреплена.')
        return true
      }
      case 'workspace': {
        const registry = (await runtime.listWorkspaces?.()) ?? []
        if (arg === '' || arg === 'list') {
          workspaceChoices.set(chatKey(chatId), registry)
          await reply(chatId, formatWorkspacesCard({ items: registry, activePath: preferredWorkspacePath }))
          return true
        }
        if (/^add\s+/i.test(arg)) {
          const path = arg.replace(/^add\s+/i, '').trim()
          if (path === '') {
            await reply(chatId, 'Использование: `/workspace add /path/to/dir`')
            return true
          }
          const created = await runtime.createWorkspace?.(path)
          if (!created?.ok) {
            await reply(chatId, `❌ Не удалось добавить папку: ${created?.error ?? 'неизвестная ошибка'}`)
            return true
          }
          await reply(chatId, `📁 Папка добавлена: \`${truncate(created.path ?? path, 200)}\``)
          return true
        }
        if (/^\d+$/.test(arg)) {
          let cached = workspaceChoices.get(chatKey(chatId))
          if (!cached) {
            cached = registry
            workspaceChoices.set(chatKey(chatId), cached)
          }
          const picked = cached[Number(arg) - 1]
          if (!picked) {
            await reply(chatId, `Укажи номер из /workspace (сейчас ${cached.length}).`)
            return true
          }
          preferredWorkspacePath = picked.path
          runtime.setPreferredWorkspace?.(picked.path)
          await reply(chatId, `📁 Новые сессии (/new) будут в \`${truncate(picked.path, 200)}\``)
          return true
        }
        await reply(chatId, 'Использование: `/workspace`, `/workspace N`, `/workspace add /path/to/dir`')
        return true
      }
      case 'approve': {
        const sessionId = await activeSession(chatId)
        if (!sessionId) {
          await reply(chatId, 'Нет активной сессии.')
          return true
        }
        const tokens = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
        if (tokens.length === 0 || tokens[0] === 'status' || tokens[0] === '?') {
          const result = await runtime.getApprovalPolicy?.(sessionId)
          if (!result?.ok) {
            await reply(chatId, `❌ ${result?.error ?? 'политика недоступна'}`)
            return true
          }
          await reply(
            chatId,
            formatApprovalPolicyCard({ policy: result.policy, override: result.override, title: runtime.titleFor?.(sessionId) }),
          )
          return true
        }
        const policy = tokens[0]
        if (policy !== 'ask' && policy !== 'never') {
          await reply(chatId, 'Использование: `/approve`, `/approve ask`, `/approve never`')
          return true
        }
        const key = chatKey(chatId)
        const pending = approvalConfirms.get(key)
        const confirmed = tokens.includes('confirm')
        if (!confirmed || !pending || pending.policy !== policy || Date.now() - pending.at > 60_000) {
          approvalConfirms.set(key, { policy, at: Date.now() })
          await reply(
            chatId,
            `⚠️ Политика \`${policy}\` изменит поведение approvals. Подтверди в течение минуты: \`/approve ${policy} confirm\``,
          )
          return true
        }
        approvalConfirms.delete(key)
        const result = await runtime.setApprovalPolicy?.(sessionId, policy)
        if (!result?.ok) {
          await reply(chatId, `❌ Не удалось изменить политику: ${result?.error ?? 'неизвестная ошибка'}`)
          return true
        }
        await reply(chatId, `🔐 Политика подтверждений: \`${policy}\``)
        return true
      }
      case 'budget':
      case 'cost': {
        const status = (await runtime.budgetStatus?.()) ?? (await runtime.costSnapshot?.())
        await reply(chatId, formatBudgetCard({ status }))
        return true
      }
      case 'schedules': {
        const service = runtime.scheduleService?.()
        const tokens = arg.trim().split(/\s+/).filter(Boolean)
        const action = (tokens[0] ?? 'list').toLowerCase()
        if (action === 'list' || tokens.length === 0) {
          const result = await listSchedules(service)
          if (!result.ok) {
            await reply(chatId, `❌ ${result.error}`)
            return true
          }
          scheduleChoices.set(chatKey(chatId), result.items.slice(0, 10))
          await reply(chatId, formatSchedulesCard(result))
          return true
        }
        const indexMatch = /^(\d+)$/.exec(tokens[1] ?? '')
        if (!indexMatch) {
          await reply(chatId, 'Использование: `/schedules`, `/schedules pause N`, `/schedules resume N`, `/schedules cancel N [confirm]`')
          return true
        }
        let items = scheduleChoices.get(chatKey(chatId))
        if (!items) {
          const result = await listSchedules(service)
          if (!result.ok) {
            await reply(chatId, `❌ ${result.error}`)
            return true
          }
          items = result.items
          scheduleChoices.set(chatKey(chatId), items)
        }
        const item = items[Number(indexMatch[1]) - 1]
        if (!item?.id) {
          await reply(chatId, `Нет задачи №${indexMatch[1]} — обнови список: /schedules`)
          return true
        }
        if (action === 'cancel' || action === 'delete') {
          const confirmed = tokens.includes('confirm')
          const key = chatKey(chatId)
          const pending = scheduleCancels.get(key)
          if (!confirmed || !pending || pending.id !== item.id || Date.now() - pending.at > 60_000) {
            scheduleCancels.set(key, { id: item.id, at: Date.now() })
            await reply(chatId, `🗑 Удалить задачу «${truncate(item.title || item.id, 80)}»? Подтверди: \`/schedules cancel ${indexMatch[1]} confirm\``)
            return true
          }
          scheduleCancels.delete(key)
          const deleted = await deleteSchedule(service, { id: item.id, expectedUpdatedAt: item.updatedAt })
          if (!deleted.ok) {
            await reply(chatId, `❌ ${deleted.error}`)
            return true
          }
          scheduleChoices.delete(key)
          await reply(chatId, `🗑 Задача удалена: «${truncate(item.title || item.id, 80)}»`)
          return true
        }
        if (action === 'pause' || action === 'resume') {
          const desired = action === 'resume'
          const result = await setScheduleActive(service, {
            id: item.id,
            active: desired,
            expectedUpdatedAt: item.updatedAt,
          })
          if (!result.ok) {
            await reply(chatId, `❌ ${result.error}`)
            return true
          }
          scheduleChoices.delete(chatKey(chatId))
          await reply(chatId, `${desired ? '▶️ Возобновлена' : '⏸ Поставлена на паузу'}: «${truncate(item.title || item.id, 80)}»`)
          return true
        }
        await reply(chatId, 'Использование: `/schedules`, `/schedules pause N`, `/schedules resume N`, `/schedules cancel N [confirm]`')
        return true
      }
      case 'settings': {
        const settings = runtime.settingsSummary?.() ?? {}
        await reply(chatId, formatSettingsCard(settings))
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
      if (data.a === 'preset') {
        const preset = (config.buttonsPresets ?? [])[Number(data.i)]
        if (!preset || !sessionId) {
          await client.answerCallback(callbackId, { notification: 'Пресет больше недоступен.' })
          return true
        }
        await client.answerCallback(callbackId, { notification: `📨 ${preset.label}` })
        const ok = await runtime.promptSession?.(sessionId, preset.prompt)
        if (!ok) await reply(undefined, '❌ Не удалось отправить пресет.')
        return true
      }
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

  /** Unwrap the forwarded message payload when MAX provides one. */
  function forwardedPayload(message) {
    const link = message?.link ?? message?.body?.link
    if (!link || link.type !== 'forward') return undefined
    const nested = link.message ?? link.forwardedMessage ?? link.forwarded_message
    if (!nested || typeof nested !== 'object') return undefined
    const body = nested.body ?? nested
    const text = String(body?.text ?? '').trim()
    const attachments = Array.isArray(body?.attachments) ? body.attachments : []
    if (text === '' && attachments.length === 0) return undefined
    return { text, attachments }
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
    if (config.interactive === false) return
    if (!allowIncoming(chatKey(chatId))) {
      await warnTooFast(chatId)
      return
    }
    // A MAX reply is routed back to the session that produced the quoted message.
    const link = message.link ?? message.body?.link
    const replyMid = link?.type === 'reply' ? link.mid : undefined
    const replySession = replyMid ? state?.findSessionByMid?.(replyMid) : undefined
    if (replySession) {
      state?.setSession?.(chatId, replySession)
      logger?.debug?.('MAX reply routed to session %s', replySession)
    }
    const forwarded = forwardedPayload(message)
    let text = String(message.body?.text ?? '').trim()
    let attachments = Array.isArray(message.body?.attachments) ? message.body.attachments : []
    if (forwarded) {
      if (text === '' && forwarded.text !== '') text = `↪️ Пересланное сообщение:\n${forwarded.text}`
      if (attachments.length === 0) attachments = forwarded.attachments
    }
    if (interactions?.tryAnswerText && (await interactions.tryAnswerText({ chatId, userId, text }))) return
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
    if (!config.registerCommands || commandsRegistered) return
    commandsRegistered = true
    try {
      await client.setCommands(COMMANDS)
      logger?.info?.('registered %d MAX bot commands', COMMANDS.length)
    } catch (error) {
      commandsRegistered = false
      logger?.debug?.('cannot register MAX bot commands: %s', error?.message || String(error))
    }
  }

  /** Stable dedupe key for one MAX update (at-least-once polling). */
  function updateKey(update) {
    const type = update?.update_type
    const chatId = update?.chat_id ?? update?.message?.recipient?.chat_id
    switch (type) {
      case 'message_created': {
        const mid = update?.message?.body?.mid
        return mid === undefined ? undefined : `msg:${chatId}:${mid}`
      }
      case 'message_callback': {
        const callbackId = update?.callback?.callback_id
        return callbackId === undefined ? undefined : `cb:${callbackId}`
      }
      case 'bot_started':
        return `start:${chatId}:${update?.timestamp ?? update?.user?.user_id ?? ''}`
      case 'bot_added':
      case 'bot_removed':
        return `${type}:${chatId}:${update?.timestamp ?? ''}`
      default:
        return undefined
    }
  }

  /** Apply one update with persisted dedupe (used by polling and webhook). */
  async function applyUpdate(update) {
    const key = updateKey(update)
    if (key && state?.hasProcessed?.(key)) return false
    await handleUpdate(update)
    if (key) state?.markProcessed?.(key)
    return true
  }

  /** One long-poll iteration; returns `{primed, count, handled}` (exposed for tests). */
  async function pollOnce() {
    const params = {
      timeout: Math.max(0, Math.min(90, config.pollTimeoutSec ?? 25)),
      limit: 100,
      types: UPDATE_TYPES,
    }
    if (state?.marker === undefined) {
      const response = await client.getUpdates(params)
      state?.setMarker?.(response?.marker)
      runtime?.healthUpdate?.({ lastPollAt: Date.now() })
      return { primed: true, count: 0, handled: 0 }
    }
    const polledAt = Date.now()
    runtime?.healthUpdate?.({ lastPollAt: polledAt })
    const response = await client.getUpdates({ ...params, marker: state.marker })
    const updates = Array.isArray(response?.updates) ? response.updates : []
    let handled = 0
    for (const update of updates) {
      // A handler failure must leave the marker untouched: the batch is retried
      // and already handled updates are skipped by their dedupe keys.
      if (await applyUpdate(update)) handled += 1
    }
    if (response?.marker !== undefined) state?.setMarker?.(response.marker)
    if (updates.length > 0) runtime?.healthUpdate?.({ lastUpdateAt: Date.now() })
    return { primed: false, count: updates.length, handled }
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
          runtime?.healthUpdate?.({ pollStopped: true, pollStoppedReason: 'unauthorized (401)' })
          runtime?.healthFail?.(error, { stopped: true, reason: 'unauthorized (401)' })
          running = false
          return
        }
        if (status === 405 || status === 409) {
          logger?.warn?.(
            'MAX polling stopped (%s): long polling is disabled while a webhook subscription is active',
            status,
          )
          runtime?.healthUpdate?.({ pollStopped: true, pollStoppedReason: 'webhook subscription active (405/409)' })
          runtime?.healthFail?.(error, { stopped: true, reason: 'webhook subscription active (405/409)' })
          running = false
          return
        }
        logger?.warn?.('MAX polling error: %s', error?.message || String(error))
        runtime?.healthFail?.(error)
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30000)
      }
    }
  }

  async function start() {
    if (disposed || config.interactive === false) return
    if (!config.botToken) return
    if (config.chatId === undefined && config.userId === undefined) return
    void registerCommands()
    if (!config.polling) {
      logger?.info?.('MAX long polling is disabled (webhook transport)')
      return
    }
    if (typeof client.getUpdates !== 'function') return
    if (running) return
    running = true
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
    applyUpdate,
    updateKey,
    handleCommand,
    noteSession,
    isAllowed,
    registerCommands,
  }
}

export { COMMANDS }
