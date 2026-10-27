/**
 * @deepseek-ai/dsh-max-notify — forwards the last assistant message of every
 * DSH agent turn to MAX messenger (max.ru) through a bot.
 *
 * It is a plain cordis function plugin: no build step, no runtime dependencies.
 * Hook shape: listen to `session/event`, remember the latest `assistant/message`
 * text per session, and send it once on the matching `turn/end`.
 *
 * Config (profile cordis.patch.yml row `config`, all optional):
 *   botToken, chatId, userId, baseUrl, caFile, format, notify,
 *   disableLinkPreview, includeHeader, includeSessionId, includeSubagents,
 *   maxChars, enabled, dryRun, requestTimeoutMs, maxRetries, minIntervalMs
 *
 * Environment fallbacks: MAX_BOT_TOKEN, MAX_CHAT_ID, MAX_USER_ID, MAX_API_BASE,
 * MAX_CA_FILE, MAX_NOTIFY_DRY_RUN.
 */
import { readFileSync } from 'node:fs'
import { createMaxClient, splitText, MAX_TEXT_LIMIT } from './lib/transport.mjs'
import { extractAssistantText } from './lib/extract.mjs'
import { formatNotification } from './lib/format.mjs'

export const name = 'dsh-max-notify'

/** No DSH services are required: `session/event` is a Context event. */
export const inject = []

const DEFAULTS = {
  enabled: true,
  botToken: undefined,
  botTokenFile: undefined,
  chatId: undefined,
  userId: undefined,
  baseUrl: undefined,
  caFile: undefined,
  format: 'markdown',
  notify: true,
  disableLinkPreview: true,
  includeHeader: true,
  includeSessionId: false,
  includeSubagents: false,
  includeTitle: true,
  allowedUserIds: [],
  allowedChatIds: [],
  skipReasons: ['interrupted', 'forked'],
  notifyOnStart: false,
  maxChars: 3800,
  dryRun: false,
  requestTimeoutMs: 15000,
  maxRetries: 3,
  minIntervalMs: 600,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function asBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function asStringArray(value, fallback) {
  if (Array.isArray(value)) {
    // YAML `[987654321]` yields numbers, `["987654321"]` yields strings — accept both.
    return value
      .filter((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
      .map((item) => String(item).trim())
      .filter(Boolean)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return fallback
}

function asInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  return Math.min(max, Math.max(min, rounded))
}

/** Normalize user config + environment fallbacks into a complete runtime config. */
export function normalizeConfig(raw = {}) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const env = typeof process === 'undefined' ? {} : process.env

  const config = {
    ...merged,
    botToken: String(merged.botToken || env.MAX_BOT_TOKEN || '').trim(),
    botTokenFile: String(merged.botTokenFile || env.MAX_BOT_TOKEN_FILE || '').trim() || undefined,
    chatId: merged.chatId ?? env.MAX_CHAT_ID ?? undefined,
    userId: merged.userId ?? env.MAX_USER_ID ?? undefined,
    baseUrl: String(merged.baseUrl || env.MAX_API_BASE || '').trim() || undefined,
    caFile: String(merged.caFile || env.MAX_CA_FILE || '').trim() || undefined,
    enabled: asBoolean(merged.enabled, DEFAULTS.enabled),
    notify: asBoolean(merged.notify, DEFAULTS.notify),
    disableLinkPreview: asBoolean(merged.disableLinkPreview, DEFAULTS.disableLinkPreview),
    includeHeader: asBoolean(merged.includeHeader, DEFAULTS.includeHeader),
    includeSessionId: asBoolean(merged.includeSessionId, DEFAULTS.includeSessionId),
    includeSubagents: asBoolean(merged.includeSubagents, DEFAULTS.includeSubagents),
    includeTitle: asBoolean(merged.includeTitle, DEFAULTS.includeTitle),
    skipReasons: asStringArray(merged.skipReasons, DEFAULTS.skipReasons),
    notifyOnStart: asBoolean(merged.notifyOnStart, DEFAULTS.notifyOnStart),
    dryRun: asBoolean(merged.dryRun, asBoolean(env.MAX_NOTIFY_DRY_RUN, DEFAULTS.dryRun)),
    maxChars: asInteger(merged.maxChars, DEFAULTS.maxChars, 200, MAX_TEXT_LIMIT),
    requestTimeoutMs: asInteger(merged.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 120000),
    maxRetries: asInteger(merged.maxRetries, DEFAULTS.maxRetries, 0, 10),
    minIntervalMs: asInteger(merged.minIntervalMs, DEFAULTS.minIntervalMs, 0, 60000),
  }

  const format = typeof config.format === 'string' ? config.format.trim().toLowerCase() : ''
  config.format = format === 'markdown' || format === 'html' ? format : undefined

  config.allowedUserIds = asStringArray(merged.allowedUserIds ?? env.MAX_ALLOWED_USER_IDS, DEFAULTS.allowedUserIds)
  config.allowedChatIds = asStringArray(merged.allowedChatIds ?? env.MAX_ALLOWED_CHAT_IDS, DEFAULTS.allowedChatIds)

  if (config.chatId !== undefined && config.chatId !== null) {
    config.chatId = String(config.chatId).trim() || undefined
  }
  if (config.userId !== undefined && config.userId !== null) {
    config.userId = String(config.userId).trim() || undefined
  }
  return config
}

/** True when this session belongs to a top-level agent (subagent children are skipped by default). */
export function isTopLevelSession(session) {
  const header = session?.header
  if (!header) return true
  if (header.origin === 'subagent') return false
  const depth = Number(header.delegationDepth ?? 0)
  return !(Number.isFinite(depth) && depth > 0)
}

/** Serialized sender with a minimum gap between messages (MAX: max 2 messages/second). */
function createSendQueue({ minIntervalMs, logger }) {
  let tail = Promise.resolve()
  let lastAt = 0
  const enqueue = (task) => {
    tail = tail.then(async () => {
      const wait = minIntervalMs - (Date.now() - lastAt)
      if (wait > 0) await sleep(wait)
      lastAt = Date.now()
      try {
        await task()
      } catch (error) {
        logger.warn('failed to forward a reply to MAX: %s', error?.stack || error?.message || String(error))
      }
    })
    return tail
  }
  return enqueue
}

/** Read a bot token from a plain token file or a `.env`-style file containing MAX_BOT_TOKEN=... */
export function readTokenFile(path) {
  const text = readFileSync(path, 'utf8')
  const match = /^\s*MAX_BOT_TOKEN\s*=\s*(.+?)\s*$/m.exec(text)
  const value = match ? match[1] : text
  return value.replace(/^(['"])(.*)\1$/, '$2').trim()
}

/**
 * Cordis plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 * @param {object} [deps] - test seams (`createClient`).
 */
export function apply(ctx, rawConfig = {}, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger('max-notify')
  const createClient = deps.createClient ?? createMaxClient

  if (config.enabled && !config.botToken && config.botTokenFile) {
    try {
      config.botToken = readTokenFile(config.botTokenFile)
    } catch (error) {
      logger.warn('cannot read botTokenFile %s: %s', config.botTokenFile, error?.message || String(error))
    }
  }

  if (!config.enabled) {
    logger.info('disabled by config (enabled: false)')
    return
  }
  if (!config.botToken) {
    logger.warn('no MAX bot token (config.botToken / MAX_BOT_TOKEN); notifications stay off')
    return
  }
  if (config.chatId === undefined && config.userId === undefined) {
    logger.warn('no MAX target (config.chatId / MAX_CHAT_ID or config.userId); notifications stay off')
    return
  }

  let client
  try {
    client = createClient({
      token: config.botToken,
      baseUrl: config.baseUrl,
      caFile: config.caFile,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      minIntervalMs: config.minIntervalMs,
      log: (level, message) => logger[level === 'warn' ? 'warn' : 'debug'](message),
    })
  } catch (error) {
    logger.warn('cannot create the MAX client: %s', error?.message || String(error))
    return
  }

  const enqueue = createSendQueue({ minIntervalMs: config.minIntervalMs, logger })

  /**
   * Recipient allowlist: when allowedUserIds/allowedChatIds are configured, the
   * plugin refuses to send anywhere else. A dialog chat must belong to an
   * allowed user; anything unresolvable fails closed.
   */
  let targetCheckPromise
  async function resolveTargetPolicy() {
    const allowedUsers = new Set(config.allowedUserIds)
    const allowedChats = new Set(config.allowedChatIds)
    if (allowedUsers.size === 0 && allowedChats.size === 0) {
      return { allowed: true, reason: 'no allowlist configured' }
    }
    if (config.chatId !== undefined) {
      const targetChat = String(config.chatId)
      if (allowedChats.has(targetChat)) return { allowed: true, reason: `chat ${targetChat} is allowlisted` }
      let chat
      try {
        if (typeof client.getChat !== 'function') throw new Error('transport has no getChat')
        chat = await client.getChat(targetChat)
      } catch (error) {
        return { allowed: false, reason: `cannot verify chat ${targetChat}: ${error?.message || String(error)}` }
      }
      const type = chat?.type
      if (type !== 'dialog') {
        return { allowed: false, reason: `chat ${targetChat} is ${type ?? 'unknown'}, not a personal dialog` }
      }
      const peer = chat?.dialog_with_user?.user_id ?? chat?.dialog_with_user?.user?.user_id
      if (peer === undefined || peer === null) {
        return { allowed: false, reason: `dialog ${targetChat} has no peer user id` }
      }
      const peerId = String(peer)
      return allowedUsers.has(peerId)
        ? { allowed: true, reason: `dialog peer user ${peerId} is allowlisted` }
        : { allowed: false, reason: `dialog peer user ${peerId} is not in allowedUserIds` }
    }
    if (config.userId !== undefined) {
      const targetUser = String(config.userId)
      return allowedUsers.has(targetUser)
        ? { allowed: true, reason: `user ${targetUser} is allowlisted` }
        : { allowed: false, reason: `user ${targetUser} is not in allowedUserIds` }
    }
    return { allowed: false, reason: 'no target configured' }
  }

  function ensureTargetAllowed() {
    if (targetCheckPromise === undefined) {
      targetCheckPromise = resolveTargetPolicy().then((result) => {
        if (result.allowed) logger.info('recipient check passed: %s', result.reason)
        else logger.warn('sending blocked by allowlist: %s', result.reason)
        return result.allowed
      })
    }
    return targetCheckPromise
  }
  /** sessionId -> { turn, text } — latest assistant text of the open turn. */
  const pending = new Map()

  function resolveTitle(session) {
    if (!config.includeTitle) return undefined
    try {
      const snapshot = ctx.get?.('sessionTitle')?.get?.(session)
      const title = snapshot?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
    } catch {
      return undefined
    }
  }

  async function deliver(session, text, reason) {
    if (!(await ensureTargetAllowed())) return
    const payload = formatNotification({
      text,
      cwd: session?.header?.cwd,
      title: resolveTitle(session),
      sessionId: session?.id,
      reason,
      format: config.format,
      includeHeader: config.includeHeader,
      includeSessionId: config.includeSessionId,
    })
    const chunks = splitText(payload, MAX_TEXT_LIMIT).slice(0, 8)
    if (config.dryRun) {
      logger.info('[dry-run] would send %d chunk(s) to MAX: %s', chunks.length, chunks[0]?.slice(0, 120))
      return
    }
    for (const chunk of chunks) {
      const message = await client.sendMessage({
        chatId: config.chatId,
        userId: config.chatId === undefined ? config.userId : undefined,
        text: chunk,
        format: config.format,
        notify: config.notify,
        disableLinkPreview: config.disableLinkPreview,
      })
      const mid = message?.message?.body?.mid
      logger.debug('MAX message sent%s', mid ? ` (mid ${mid})` : '')
    }
  }

  function onSessionEvent(session, event) {
    if (!session || !event || typeof event.type !== 'string') return
    const id = session.id
    // Session events are enveloped as { type, seq, time, data }.
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        pending.delete(id)
        return
      case 'assistant/message': {
        const text = extractAssistantText(data.message)
        if (!text) return
        // The last non-empty assistant message of the current turn wins.
        pending.set(id, { turn: data.turn, text })
        return
      }
      case 'turn/end': {
        const record = pending.get(id)
        pending.delete(id)
        if (!record || record.turn !== data.turn) return
        const kind = data.reason?.kind ?? 'completed'
        if (config.skipReasons.includes(kind)) return
        const text = record.text.trim()
        if (!text) return
        if (!config.includeSubagents && !isTopLevelSession(session)) return
        void enqueue(() => deliver(session, text, data.reason))
        return
      }
      default:
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session, event)
    } catch (error) {
      logger.warn('session/event handler failed: %s', error?.stack || error?.message || String(error))
    }
  })
  ctx.on('session/disposed', (session) => {
    if (session?.id) pending.delete(session.id)
  })

  const allowedLabels = [
    ...config.allowedUserIds.map((id) => `user ${id}`),
    ...config.allowedChatIds.map((id) => `chat ${id}`),
  ]
  const restrictionLabel = allowedLabels.join(', ')
  const restriction = restrictionLabel ? `; only ${restrictionLabel}` : ''
  logger.info(
    'forwarding each agent reply to MAX %s as %s%s%s',
    config.chatId !== undefined ? `chat ${config.chatId}` : `user ${config.userId}`,
    config.format ?? 'plain text',
    config.dryRun ? ' (dry-run)' : '',
    restriction,
  )

  // Optional one-shot "plugin is alive" message, useful right after installation.
  if (config.notifyOnStart) {
    void enqueue(async () => {
      if (!(await ensureTargetAllowed())) return
      let bot = ''
      try {
        const me = await client.getMe()
        bot = me?.username ? ` @${me.username}` : ''
      } catch {
        // identity is optional
      }
      await client.sendMessage({
        chatId: config.chatId,
        userId: config.chatId === undefined ? config.userId : undefined,
        text:
          `🟢 DSH → MAX: плагин dsh-max-notify подключён${bot}. Дальше сюда будет приходить последнее сообщение агента после каждого хода.` +
          (config.allowedUserIds.length > 0 || config.allowedChatIds.length > 0
            ? ` Отправка ограничена: только ${restrictionLabel}.`
            : ''),
        format: config.format,
        notify: config.notify,
        disableLinkPreview: true,
      })
      logger.info('startup notification sent to MAX')
    })
  }
}
