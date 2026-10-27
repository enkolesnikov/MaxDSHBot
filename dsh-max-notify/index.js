/**
 * @deepseek-ai/dsh-max-notify — forwards the last assistant message of every
 * DSH agent turn to MAX messenger (max.ru) through a bot.
 *
 * It is a plain cordis function plugin: no build step, no runtime dependencies.
 * Two halves:
 *  - notifications: listen to `session/event`, remember the latest
 *    `assistant/message` text per session, and send it once on `turn/end`;
 *  - remote control ("Пульт"): long-poll MAX updates, inject prompts into the
 *    active session, answer approvals/questions/commands from inline buttons,
 *    show a live progress card, and forward `present` deliverables as files.
 *
 * Config (profile cordis.patch.yml row `config`, all optional):
 *   botToken, chatId, userId, baseUrl, caFile, format, notify,
 *   disableLinkPreview, includeHeader, includeSessionId, includeSubagents,
 *   maxChars, enabled, dryRun, requestTimeoutMs, maxRetries, minIntervalMs
 *
 * Environment fallbacks: MAX_BOT_TOKEN, MAX_CHAT_ID, MAX_USER_ID, MAX_API_BASE,
 * MAX_CA_FILE, MAX_NOTIFY_DRY_RUN.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createMaxClient, splitText, MAX_TEXT_LIMIT } from './lib/transport.mjs'
import { extractAssistantText } from './lib/extract.mjs'
import { formatNotification } from './lib/format.mjs'
import { createState, resolveStateFile } from './lib/state.mjs'
import { createInteractions } from './lib/interactions.mjs'
import { createProgress } from './lib/progress.mjs'
import { createDeliverables } from './lib/deliverables.mjs'
import { createBot } from './lib/bot.mjs'
import { createPolicy } from './lib/policy.mjs'
import { createObserver } from './lib/observer.mjs'
import { collectMessageImages, extractImageReferences } from './lib/images.mjs'

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
  // remote control ("Пульт")
  polling: true,
  pollTimeoutSec: 25,
  stateFile: undefined,
  interactive: true,
  approvalChannel: 'both',
  questionChannel: 'both',
  buttons: true,
  webUrl: undefined,
  progress: true,
  progressDelayMs: 2500,
  progressThrottleMs: 2000,
  progressTextLimit: 400,
  typing: true,
  deliverables: true,
  registerCommands: true,
  greetOnStart: true,
  // notifications ("Наблюдатель")
  notifySubagents: true,
  notifyJobs: true,
  notifyAwaitedJobs: false,
  notifyGoals: true,
  notifyErrors: true,
  todoProgress: true,
  quietHours: undefined,
  mode: 'all',
  digestEnabled: false,
  digestTime: '21:00',
  forwardImages: true,
  maxImages: 4,
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

function normalizeQuietHours(value) {
  if (!value || typeof value !== 'object') return undefined
  const start = String(value.start ?? '').trim()
  const end = String(value.end ?? '').trim()
  const pattern = /^\d{1,2}:\d{2}$/
  if (!pattern.test(start) || !pattern.test(end)) return undefined
  return { start, end }
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
    polling: asBoolean(merged.polling, DEFAULTS.polling),
    pollTimeoutSec: asInteger(merged.pollTimeoutSec, DEFAULTS.pollTimeoutSec, 0, 90),
    interactive: asBoolean(merged.interactive, DEFAULTS.interactive),
    buttons: asBoolean(merged.buttons, DEFAULTS.buttons),
    progress: asBoolean(merged.progress, DEFAULTS.progress),
    typing: asBoolean(merged.typing, DEFAULTS.typing),
    deliverables: asBoolean(merged.deliverables, DEFAULTS.deliverables),
    registerCommands: asBoolean(merged.registerCommands, DEFAULTS.registerCommands),
    greetOnStart: asBoolean(merged.greetOnStart, DEFAULTS.greetOnStart),
    progressDelayMs: asInteger(merged.progressDelayMs, DEFAULTS.progressDelayMs, 0, 60000),
    progressThrottleMs: asInteger(merged.progressThrottleMs, DEFAULTS.progressThrottleMs, 500, 60000),
    progressTextLimit: asInteger(merged.progressTextLimit, DEFAULTS.progressTextLimit, 100, 3500),
    stateFile: String(merged.stateFile || env.MAX_NOTIFY_STATE_FILE || '').trim() || undefined,
    webUrl: String(merged.webUrl || env.DSH_WEB_URL || '').trim() || undefined,
    notifySubagents: asBoolean(merged.notifySubagents, DEFAULTS.notifySubagents),
    notifyJobs: asBoolean(merged.notifyJobs, DEFAULTS.notifyJobs),
    notifyAwaitedJobs: asBoolean(merged.notifyAwaitedJobs, DEFAULTS.notifyAwaitedJobs),
    notifyGoals: asBoolean(merged.notifyGoals, DEFAULTS.notifyGoals),
    notifyErrors: asBoolean(merged.notifyErrors, DEFAULTS.notifyErrors),
    todoProgress: asBoolean(merged.todoProgress, DEFAULTS.todoProgress),
    digestEnabled: asBoolean(merged.digestEnabled, DEFAULTS.digestEnabled),
    forwardImages: asBoolean(merged.forwardImages, DEFAULTS.forwardImages),
    maxImages: asInteger(merged.maxImages, DEFAULTS.maxImages, 0, 12),
    digestTime: /^\d{2}:\d{2}$/.test(String(merged.digestTime ?? '')) ? String(merged.digestTime) : DEFAULTS.digestTime,
    quietHours: normalizeQuietHours(merged.quietHours),
    mode: ['all', 'errors', 'mute'].includes(merged.mode) ? merged.mode : DEFAULTS.mode,
  }

  const format = typeof config.format === 'string' ? config.format.trim().toLowerCase() : ''
  config.format = format === 'markdown' || format === 'html' ? format : undefined
  const channel = (value) => (value === 'max' || value === 'gui' || value === 'both' ? value : 'both')
  config.approvalChannel = channel(merged.approvalChannel)
  config.questionChannel = channel(merged.questionChannel)

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

  // ── host session/agent access for the remote control ("Пульт") ───────────
  const getService = (serviceName) => {
    try {
      return ctx.get?.(serviceName)
    } catch {
      return undefined
    }
  }
  const titleCache = new Map()
  function titleOf(session) {
    try {
      const title = getService('sessionTitle')?.get?.(session)?.title
      if (typeof title === 'string' && title.trim() !== '') {
        if (session?.id) titleCache.set(String(session.id), title.trim())
        return title.trim()
      }
    } catch {
      // sessionTitle is an optional service
    }
    return session?.id ? titleCache.get(String(session.id)) : undefined
  }
  function titleFor(sessionOrId) {
    if (typeof sessionOrId === 'string' || sessionOrId === undefined) {
      const id = String(sessionOrId ?? '')
      const agent = getService('agents')?.get?.(id)
      if (agent) return titleOf(agent.session) ?? titleCache.get(id)
      return titleCache.get(id)
    }
    return titleOf(sessionOrId)
  }

  async function listSessions() {
    const controller = getService('sessionController')
    if (!controller?.list) return []
    const value = await controller.list({}, new AbortController().signal)
    return (value?.items ?? [])
      .filter((item) => item && !item.blank && item.origin !== 'subagent')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 10)
      .map((item) => ({
        sessionId: item.sessionId,
        running: item.running === true,
        cwd: item.cwd,
        updatedAt: item.updatedAt,
        title: titleFor(String(item.sessionId)),
      }))
  }

  async function statusInfo(sessionId) {
    let summary
    try {
      const controller = getService('sessionController')
      const value = controller?.list ? await controller.list({}, new AbortController().signal) : undefined
      summary = value?.items?.find((item) => item.sessionId === sessionId)
    } catch {
      summary = undefined
    }
    const agent = getService('agents')?.get?.(sessionId)
    return {
      sessionId,
      title: titleFor(sessionId),
      running: summary?.running === true || (agent ? agent.status !== 'idle' : false),
      agentStatus: agent?.status,
      model: agent?.options?.model,
      provider: agent?.options?.provider,
      cwd: summary?.cwd ?? agent?.session?.header?.cwd,
      updatedAt: summary?.updatedAt,
    }
  }

  async function promptSession(sessionId, text) {
    const value = String(text ?? '').trim()
    if (!value) return false
    const controller = getService('sessionController')
    if (controller?.prompt) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 15000)
      timer.unref?.()
      try {
        await controller.prompt(
          { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: value }] },
          abort.signal,
        )
        return true
      } catch (error) {
        logger.warn('sessionController.prompt failed: %s', error?.message || String(error))
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const agent = getService('agents')?.get?.(sessionId)
      if (!agent) return false
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: value }],
        source: { kind: 'user' },
      })
      return true
    } catch (error) {
      logger.warn('agent.followup failed: %s', error?.message || String(error))
      return false
    }
  }

  async function cancelSession(sessionId) {
    const controller = getService('sessionController')
    if (controller?.cancel) {
      try {
        const value = await controller.cancel({ sessionId })
        return value?.accepted !== false
      } catch (error) {
        logger.warn('sessionController.cancel failed: %s', error?.message || String(error))
      }
    }
    const agent = getService('agents')?.get?.(sessionId)
    if (agent) {
      try {
        agent.cancel({ kind: 'user' })
        return true
      } catch {
        // fall through
      }
    }
    return false
  }

  const target = { chatId: config.chatId, userId: config.chatId === undefined ? config.userId : undefined }
  const state = createState({ file: resolveStateFile(config), logger, chatId: config.chatId })
  const policy = createPolicy({ config, state, logger })
  const interactions = createInteractions({
    client,
    config,
    logger,
    target,
    resolveTitle: (session) => titleOf(session),
  })
  const progress = createProgress({ client, config, logger, target, policy })
  const deliverables = createDeliverables({ client, config, logger, target, policy })
  const observer = createObserver({
    client,
    config,
    logger,
    target,
    policy,
    state,
    runtime: { listSessions, titleFor },
  })
  const bot = createBot({
    client,
    config,
    logger,
    state,
    interactions,
    policy,
    observer,
    runtime: { listSessions, statusInfo, promptSession, cancelSession, titleFor },
  })

  /** Paths already sent to MAX by the deliverables pipeline (per session). */
  const imagesSent = new Map()

  function noteSentImages(sessionId, paths) {
    if (!Array.isArray(paths) || paths.length === 0) return
    const key = String(sessionId ?? '')
    const set = imagesSent.get(key) ?? new Set()
    for (const path of paths) set.add(String(path))
    imagesSent.set(key, set)
  }

  /**
   * Images from the final answer: assistant image blocks plus images referenced
   * in the visible markdown (local files relative to the session cwd, or URLs).
   */
  async function collectFinalImages(session, text, message) {
    if (!config.forwardImages || config.maxImages <= 0) return []
    const max = config.maxImages
    const key = String(session?.id ?? '')
    const seen = imagesSent.get(key) ?? new Set()
    const attachments = []

    for (const ref of collectMessageImages(message)) {
      if (attachments.length >= max) break
      try {
        const stored = await getService('attachments')?.readImage?.(ref)
        if (!stored?.data) continue
        const uploaded = await client.uploadMedia({
          buffer: Buffer.from(stored.data),
          filename: ref?.name ?? 'image.png',
          type: 'image',
        })
        attachments.push({ type: 'image', payload: { token: uploaded.token } })
      } catch (error) {
        logger.warn('cannot forward an image from the final message: %s', error?.message || String(error))
      }
    }

    const refs = extractImageReferences(text, session?.header?.cwd)
    for (const file of refs.files) {
      if (attachments.length >= max) break
      if (seen.has(file)) continue
      try {
        const uploaded = await client.uploadMedia({ filePath: file, type: 'image' })
        attachments.push({ type: 'image', payload: { token: uploaded.token } })
        seen.add(file)
      } catch (error) {
        logger.warn('cannot forward image %s: %s', file, error?.message || String(error))
      }
    }
    for (const url of refs.urls) {
      if (attachments.length >= max) break
      attachments.push({ type: 'image', payload: { url } })
    }
    imagesSent.set(key, seen)
    return attachments
  }

  function finalKeyboard(session) {
    if (!config.buttons) return undefined
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return undefined
    const rows = [
      [
        { type: 'callback', text: '▶️ Продолжить', payload: JSON.stringify({ t: 'qa', a: 'cont', s: sessionId }) },
        { type: 'callback', text: '⏹ Стоп', payload: JSON.stringify({ t: 'qa', a: 'stop', s: sessionId }) },
      ],
    ]
    if (config.webUrl) rows.push([{ type: 'link', text: '🖥 Открыть GUI', url: config.webUrl }])
    return [{ type: 'inline_keyboard', payload: { buttons: rows } }]
  }

  async function deliver(session, text, reason, message) {
    if (!(await ensureTargetAllowed())) return
    const decision = policy.decide('final')
    if (!decision.send) {
      logger.debug('final reply suppressed (%s)', decision.reason)
      return
    }
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
    const keyboard = finalKeyboard(session)
    const images = await collectFinalImages(session, text, message)
    const attachments = images.length > 0 || keyboard ? [...images, ...(keyboard ?? [])] : undefined
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      const message = await client.sendMessage({
        chatId: config.chatId,
        userId: config.chatId === undefined ? config.userId : undefined,
        text: chunk,
        format: config.format,
        notify: decision.notify,
        disableLinkPreview: config.disableLinkPreview,
        ...(isLast && attachments ? { attachments } : {}),
      })
      const mid = message?.message?.body?.mid
      logger.debug('MAX message sent%s', mid ? ` (mid ${mid})` : '')
    }
    bot.noteSession?.(String(session.id))
  }

  function onSessionEvent(session, event) {
    if (!session || !event || typeof event.type !== 'string') return
    const id = session.id
    // Session events are enveloped as { type, seq, time, data }.
    const data = event.data ?? {}
    try {
      observer.onSessionEvent(session, event)
    } catch (error) {
      logger.debug('observer failed: %s', error?.message || String(error))
    }
    switch (event.type) {
      case 'turn/start':
        pending.delete(id)
        progress.onTurnStart(session)
        return
      case 'assistant/message': {
        const text = extractAssistantText(data.message)
        if (!text) return
        // The last non-empty assistant message of the current turn wins.
        pending.set(id, { turn: data.turn, text, message: data.message })
        return
      }
      case 'turn/end': {
        progress.onTurnEnd(session)
        const record = pending.get(id)
        pending.delete(id)
        if (!record || record.turn !== data.turn) return
        const kind = data.reason?.kind ?? 'completed'
        if (config.skipReasons.includes(kind)) return
        const text = record.text.trim()
        if (!text) return
        if (!config.includeSubagents && !isTopLevelSession(session)) return
        void enqueue(() => deliver(session, text, data.reason, record.message))
        return
      }
      case 'deliverables/presented': {
        if (!config.deliverables) return
        if (!config.includeSubagents && !isTopLevelSession(session)) return
        const files = Array.isArray(data.files) ? data.files : []
        if (files.length === 0) return
        void deliverables
          .send(files)
          .then((sentPaths) => noteSentImages(session.id, sentPaths))
          .catch((error) => {
            logger.warn('cannot forward deliverables: %s', error?.message || String(error))
          })
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
    if (session?.id) {
      pending.delete(session.id)
      progress.onTurnEnd(session)
    }
  })

  // Live progress from the model stream and the tool pipeline.
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      progress.onStream(payload?.agent?.session, payload?.frame)
    } catch (error) {
      logger.debug('progress stream handler failed: %s', error?.message || String(error))
    }
  })
  ctx.on('tools/pre-execute', (execution, next) => {
    try {
      progress.onTool(execution?.agent?.session, execution)
    } catch {
      // observation only
    }
    return next()
  })

  // "Наблюдатель": subagent/job/goal/error notifications.
  ctx.on('subagent/end', (info) => {
    try {
      observer.onSubagentEnd(info)
    } catch (error) {
      logger.debug('subagent notification failed: %s', error?.message || String(error))
    }
  })
  ctx.on('agent/error', (payload) => {
    try {
      observer.onAgentError(payload)
    } catch (error) {
      logger.debug('error notification failed: %s', error?.message || String(error))
    }
  })
  ctx.on('goal/changed', (payload) => {
    try {
      observer.onGoalChanged(payload)
    } catch (error) {
      logger.debug('goal notification failed: %s', error?.message || String(error))
    }
  })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['jobs'], (jobsCtx) => {
      const jobs = jobsCtx?.get?.('jobs') ?? jobsCtx?.jobs
      if (!jobs?.events?.subscribe) return
      jobsCtx.effect(() => {
        const dispose = jobs.events.subscribe({ owners: 'all' }, (event) => {
          try {
            observer.onJobEvent(event)
          } catch (error) {
            logger.debug('job notification failed: %s', error?.message || String(error))
          }
        })
        return () => dispose()
      })
    })
  }

  // Interactive decisions: approvals and agent questions are answered from MAX
  // (prepend, delegate to the GUI immediately, race both channels).
  if (config.interactive) {
    ctx.on(
      'approval/request',
      (request, next) => interactions.handleApproval(request, next),
      { prepend: true },
    )
    ctx.on(
      'user-questions/request',
      (request, next) => interactions.handleQuestions(request, next),
      { prepend: true },
    )
  }

  // Start the MAX long-polling loop and tear everything down with the plugin.
  // (A minimal test context has no fiber/effect support, so guard the call.)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      void bot.start()
      observer.start()
      return () => {
        bot.stop()
        observer.dispose()
        progress.dispose()
        interactions.dispose()
        state.dispose()
      }
    })
  } else {
    void bot.start()
  }

  const allowedLabels = [
    ...config.allowedUserIds.map((id) => `user ${id}`),
    ...config.allowedChatIds.map((id) => `chat ${id}`),
  ]
  const restrictionLabel = allowedLabels.join(', ')
  const restriction = restrictionLabel ? `; only ${restrictionLabel}` : ''
  logger.info(
    'forwarding each agent reply to MAX %s as %s%s%s%s%s',
    config.chatId !== undefined ? `chat ${config.chatId}` : `user ${config.userId}`,
    config.format ?? 'plain text',
    config.dryRun ? ' (dry-run)' : '',
    restriction,
    config.interactive ? '; remote control on' : '',
    config.digestEnabled ? `; digest at ${config.digestTime}` : '',
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
          `🟢 DSH → MAX: плагин dsh-max-notify подключён${bot}. Сюда приходит последнее сообщение агента после каждого хода; можно писать агенту прямо в этот чат, пользоваться /help и /mode.` +
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
