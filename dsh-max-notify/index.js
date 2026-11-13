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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createMaxClient, splitText, MAX_TEXT_LIMIT } from './lib/transport.mjs'
import { DEFAULTS, normalizeConfig } from './lib/config.mjs'

export { DEFAULTS, normalizeConfig }
import { extractAssistantText } from './lib/extract.mjs'
import { formatNotification } from './lib/format.mjs'
import { formatBriefingCard } from './lib/cards.mjs'
import { createState, resolveStateFile } from './lib/state.mjs'
import { createInteractions } from './lib/interactions.mjs'
import { normalizeAutonomyMode, resolveAutonomyPolicy } from './lib/autonomy.mjs'
import { listSchedules } from './lib/schedules.mjs'
import { createProgress } from './lib/progress.mjs'
import { createDeliverables } from './lib/deliverables.mjs'
import { createBot } from './lib/bot.mjs'
import { createPolicy } from './lib/policy.mjs'
import { createObserver } from './lib/observer.mjs'
import { collectMessageImages } from './lib/images.mjs'
import { createForwarding } from './lib/forwarding.mjs'
import { buildTableFiles } from './lib/tables.mjs'
import {
  createSettingsApi,
  loadSettings,
  mergeSettings,
  resolveSettingsFile,
} from './lib/settings.mjs'
import { readImageParts } from './lib/media.mjs'
import { transcribeAudio, voiceConfigured, voicePromptText } from './lib/voice.mjs'
import { shouldSpeak, speakableText, synthesizeSpeech, ttsConfigured } from './lib/tts.mjs'
import { classifyUploadType, formatBytes, resolveSendFile, runGitDiff } from './lib/workspace-tools.mjs'
import { createIncoming } from './lib/incoming.mjs'
import { resolveSessionDir } from './lib/create-session.mjs'
import { archivedIdsOf, filterArchivedSessions } from './lib/sessions.mjs'
import { createLimiter } from './lib/limits.mjs'
import { createOutbox, resolveOutboxFile } from './lib/outbox.mjs'
import { createHealth } from './lib/health.mjs'
import { createAudit, resolveAuditFile } from './lib/audit.mjs'
import { createCostMeter, resolveCostLedgerFile } from './lib/cost-meter.mjs'
import { createWebhookHandler, ensureWebhookSubscription, removeWebhookSubscription } from './lib/webhook.mjs'
import { wrapLogger } from './lib/redact.mjs'

export const name = 'dsh-max-notify'

/** No DSH services are required: `session/event` is a Context event. */
export const inject = []

/** Plugin version, read once from the package manifest (used by `/version` and health). */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const baseConfig = normalizeConfig(rawConfig)
  const settingsFilePath = resolveSettingsFile(baseConfig)
  let config = mergeSettings(baseConfig, loadSettings(settingsFilePath))
  const logger = wrapLogger(ctx.logger('max-notify'))
  const createClient = deps.createClient ?? createMaxClient

  if (config.enabled && !config.botToken && config.botTokenFile) {
    try {
      config.botToken = readTokenFile(config.botTokenFile)
    } catch (error) {
      logger.warn('cannot read botTokenFile %s: %s', config.botTokenFile, error?.message || String(error))
    }
  }
  if (config.enabled && !config.voiceTtsApiKey && config.voiceTtsApiKeyFile) {
    try {
      config.voiceTtsApiKey = readTokenFile(config.voiceTtsApiKeyFile)
    } catch (error) {
      logger.warn('cannot read voiceTtsApiKeyFile %s: %s', config.voiceTtsApiKeyFile, error?.message || String(error))
    }
  }
  if (config.enabled && !config.voiceApiKey && config.voiceApiKeyFile) {
    try {
      config.voiceApiKey = readTokenFile(config.voiceApiKeyFile)
    } catch (error) {
      logger.warn('cannot read voiceApiKeyFile %s: %s', config.voiceApiKeyFile, error?.message || String(error))
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

  const limiter = createLimiter({
    perChatPerSecond: config.ratePerChatPerSecond,
    globalPerSecond: config.rateGlobalPerSecond,
    logger,
  })
  const health = createHealth({ version: VERSION })

  let client
  try {
    client = createClient({
      token: config.botToken,
      baseUrl: config.baseUrl,
      caFile: config.caFile,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      minIntervalMs: config.minIntervalMs,
      limiter,
      log: (level, message) => logger[level === 'warn' ? 'warn' : 'debug'](message),
    })
  } catch (error) {
    logger.warn('cannot create the MAX client: %s', error?.message || String(error))
    return
  }

  // Guard every outbound path (finals, approvals, errors, progress, files,
  // TTS, /send, /diff) with the same recipient allowlist. The raw client is
  // kept for host-only reads such as getChat/getSubscriptions.
  const rawClient = client
  const guardedClientMethods = new Set([
    'sendMessage',
    'sendText',
    'sendWithAttachments',
    'editMessage',
    'deleteMessage',
    'answerCallback',
    'sendAction',
    'uploadMedia',
  ])
  client = new Proxy(rawClient, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || !guardedClientMethods.has(property)) return value
      return async (...args) => {
        if (!(await ensureTargetAllowed())) {
          throw new Error('MAX recipient is not allowlisted; outbound request blocked')
        }
        const result = await value.apply(target, args)
        if (property === 'sendMessage' || property === 'sendText' || property === 'sendWithAttachments') {
          health.update({ lastSendAt: Date.now() })
        }
        return result
      }
    },
  })

  const enqueue = createSendQueue({ minIntervalMs: config.minIntervalMs, logger })

  // Fail-closed remote control: without an allowlist anyone could drive the
  // agent. Notifications stay on; polling/commands/approvals are disabled
  // unless the operator explicitly opts out with `allowUnlistedUsers`.
  const hasAllowlist = config.allowedUserIds.length > 0 || config.allowedChatIds.length > 0
  if (config.interactive && !hasAllowlist && !config.allowUnlistedUsers) {
    config.interactive = false
    config.polling = false
    logger.warn(
      'remote control disabled: allowedUserIds/allowedChatIds are empty. Set an allowlist or allowUnlistedUsers: true to enable commands/approvals.',
    )
  }
  if (!config.interactive) config.polling = false

  /**
   * Recipient allowlist: when allowedUserIds/allowedChatIds are configured, the
   * plugin refuses to send anywhere else. A dialog chat must belong to an
   * allowed user; anything unresolvable fails closed.
   */
  let targetCheckPromise
  let targetCheckResult
  let targetCheckAt = 0
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
        return {
          allowed: false,
          transient: true,
          reason: `cannot verify chat ${targetChat}: ${error?.message || String(error)}`,
        }
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
    // Successful verification and deterministic policy denials are cached.
    // A transient getChat failure is retried after a short cooldown instead of
    // disabling outbound messages until the next plugin restart.
    if (targetCheckResult?.allowed === true) return Promise.resolve(true)
    if (targetCheckResult && targetCheckResult.transient !== true) return Promise.resolve(false)
    if (targetCheckResult?.transient === true && Date.now() - targetCheckAt < 10_000) return Promise.resolve(false)
    if (targetCheckPromise) return targetCheckPromise
    targetCheckPromise = resolveTargetPolicy()
      .then((result) => {
        targetCheckAt = Date.now()
        if (result.allowed) {
          targetCheckResult = result
          logger.info('recipient check passed: %s', result.reason)
        } else if (result.transient !== true) {
          targetCheckResult = result
          logger.warn('sending blocked by allowlist: %s', result.reason)
        } else {
          targetCheckResult = result
          logger.warn('cannot verify recipient yet; will retry: %s', result.reason)
        }
        return result.allowed
      })
      .finally(() => {
        targetCheckPromise = undefined
      })
    return targetCheckPromise
  }
  /** sessionId -> { turn, text } — latest assistant text of the open turn. */
  const pending = new Map()
  /** sessionId -> { turn, refs } — image blocks seen in tool results during the turn. */
  const pendingToolImages = new Map()

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

  /** Title of a cold session from its projection cache (or `undefined`). */
  async function coldTitle(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return undefined
    const cached = titleCache.get(id)
    if (cached) return cached
    const controller = getService('sessionController')
    if (!controller?.projections) return undefined
    try {
      const value = await controller.projections({ sessionId: id }, AbortSignal.timeout(2500))
      const title = value?.kind === 'sequenced' ? value.values?.title : value?.values?.title
      if (typeof title === 'string' && title.trim() !== '') {
        titleCache.set(id, title.trim())
        return title.trim()
      }
    } catch {
      // projection reads are best-effort
    }
    return undefined
  }

  async function listSessions() {
    const controller = getService('sessionController')
    if (!controller?.list) return []
    const value = await controller.list({}, new AbortController().signal)
    const items = (value?.items ?? []).filter(
      (item) => item && !item.blank && item.origin !== 'subagent',
    )
    const archived = archivedIdsOf(getService('workspaceRegistry'))
    const summaries = filterArchivedSessions(items, archived)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 10)
    return Promise.all(
      summaries.map(async (item) => {
        const hinted = item?.projections?.values?.title
        let title = titleFor(String(item.sessionId)) ?? (typeof hinted === 'string' && hinted.trim() !== '' ? hinted.trim() : undefined)
        if (!title) title = await coldTitle(item.sessionId)
        return {
          sessionId: item.sessionId,
          running: item.running === true,
          cwd: item.cwd,
          updatedAt: item.updatedAt,
          title,
        }
      }),
    )
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

  /** Resolve (or resume) the live Agent for a session; undefined when unavailable. */
  async function liveAgent(sessionId) {
    const controller = getService('sessionController')
    if (controller?.resolveAgent) {
      try {
        const result = await controller.resolveAgent(sessionId)
        if (result?.agent) return result.agent
        if (result?.error) {
          logger.warn('cannot resolve session %s: %s', sessionId, result.error?.code ?? 'unknown')
          return undefined
        }
      } catch (error) {
        logger.warn('resolveAgent failed for %s: %s', sessionId, error?.message || String(error))
      }
    }
    return getService('agents')?.get?.(sessionId)
  }

  /** Execute one slash command against the session's live agent. */
  async function runCommand(sessionId, line) {
    const commands = getService('commands')
    if (!commands?.execute) return { ok: false, error: 'сервис команд недоступен' }
    const agent = await liveAgent(sessionId)
    if (!agent) return { ok: false, error: 'сессия недоступна: не удалось активировать агента' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90000)
    timer.unref?.()
    try {
      const execution = await commands.execute(agent, line, [], controller.signal)
      if (!execution) return { ok: false, error: `команда ${line} не найдена` }
      const result = execution.result ?? {}
      return {
        ok: result.kind !== 'error',
        text: result.text,
        kind: result.kind,
      }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  async function modelCatalog() {
    const controller = getService('sessionController')
    if (!controller?.modelCatalog) return undefined
    try {
      return await controller.modelCatalog()
    } catch (error) {
      logger.warn('modelCatalog failed: %s', error?.message || String(error))
      return undefined
    }
  }

  async function listModels() {
    const catalog = await modelCatalog()
    if (!catalog) return { items: [], failures: [] }
    const items = []
    for (const group of catalog.groups ?? []) {
      for (const model of group.models ?? []) {
        items.push({
          provider: group.id,
          providerName: group.name,
          model: model.id,
          name: model.name ?? model.id,
          reasoning: model.reasoning?.efforts ?? [],
        })
      }
    }
    return { items: items.slice(0, 30), failures: catalog.failures ?? [], default: catalog.default }
  }

  async function currentModel(sessionId) {
    const agent = getService('agents')?.get?.(sessionId)
    const info = await statusInfo(sessionId)
    return {
      provider: agent?.options?.provider ?? info.provider,
      model: agent?.options?.model ?? info.model,
      reasoningEffort: agent?.options?.reasoningEffort,
    }
  }

  async function selectModel(sessionId, selection) {
    const controller = getService('sessionController')
    if (!controller?.selectModel) return { ok: false, error: 'выбор модели недоступен' }
    try {
      const value = await controller.selectModel({ sessionId, ...selection })
      return { ok: true, selection: value?.selected ?? selection }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function renameSession(sessionId, title) {
    const controller = getService('sessionController')
    if (!controller?.rename) return { ok: false, error: 'переименование недоступно' }
    try {
      const value = await controller.rename({ sessionId, title })
      titleCache.set(String(sessionId), value?.title ?? title)
      return { ok: true, title: value?.title ?? title }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function forkSession(sessionId) {
    const controller = getService('sessionController')
    if (!controller?.fork) return { ok: false, error: 'fork недоступен' }
    try {
      const value = await controller.fork({ sessionId })
      return { ok: true, sessionId: value?.sessionId }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function searchSessions(query) {
    const controller = getService('sessionController')
    if (!controller?.search) return { ok: false, error: 'поиск недоступен' }
    try {
      const value = await controller.search({ query }, AbortSignal.timeout(15000))
      const items = await Promise.all(
        (value?.items ?? []).map(async (item) => ({
          sessionId: item.sessionId,
          snippet: item.snippet,
          title: titleFor(String(item.sessionId)) ?? (await coldTitle(item.sessionId)),
        })),
      )
      return { ok: true, items, hasMore: value?.hasMore === true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function archiveSession(sessionId) {
    const registry = getService('workspaceRegistry')
    if (!registry?.archiveSession) return { ok: false, error: 'архив недоступен' }
    try {
      await registry.archiveSession(sessionId)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function pinSession(sessionId, pinned) {
    const registry = getService('workspaceRegistry')
    const method = pinned ? 'pinSession' : 'unpinSession'
    if (!registry?.[method]) return { ok: false, error: 'pin недоступен' }
    try {
      await registry[method](sessionId)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  function listWorkspaces() {
    const registry = getService('workspaceRegistry')
    if (!registry?.list) return []
    try {
      return registry.list().map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
      }))
    } catch {
      return []
    }
  }

  async function createWorkspace(path, title) {
    const registry = getService('workspaceRegistry')
    if (!registry?.create) return { ok: false, error: 'workspace-сервис недоступен' }
    try {
      const workspace = await registry.create(path, title)
      return { ok: true, path: workspace?.path, title: workspace?.title }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function getApprovalPolicy(sessionId) {
    const service = getService('approval')
    if (!service?.overrideOf) return { ok: false, error: 'политика approvals недоступна' }
    const agent = getService('agents')?.get?.(sessionId) ?? (await liveAgent(sessionId))
    if (!agent?.session) return { ok: false, error: 'сессия недоступна' }
    const override = service.overrideOf(agent.session)
    return { ok: true, policy: override ?? 'ask', override: override !== undefined }
  }

  async function setApprovalPolicy(sessionId, policy) {
    const service = getService('approval')
    if (!service?.setPolicy) return { ok: false, error: 'политика approvals недоступна' }
    const agent = getService('agents')?.get?.(sessionId) ?? (await liveAgent(sessionId))
    if (!agent) return { ok: false, error: 'сессия недоступна' }
    service.setPolicy(agent, policy)
    return { ok: true, policy }
  }

  async function setPlanMode(sessionId, active) {
    const planMode = getService('planMode')
    if (!planMode?.set) return { ok: false, error: 'plan-mode не смонтирован в профиле' }
    const agent = getService('agents')?.get?.(sessionId) ?? (await liveAgent(sessionId))
    if (!agent) return { ok: false, error: 'сессия недоступна' }
    try {
      const state = planMode.set(agent, active === true)
      const view = planMode.get?.(agent) ?? { active: active === true }
      return { ok: true, state, ...view }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function planState(sessionId) {
    const planMode = getService('planMode')
    if (!planMode?.get) return { ok: false, error: 'plan-mode не смонтирован в профиле' }
    const agent = getService('agents')?.get?.(sessionId) ?? (await liveAgent(sessionId))
    if (!agent) return { ok: false, error: 'сессия недоступна' }
    try {
      return { ok: true, ...planMode.get(agent) }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  function settingsSummary() {
    return {
      version: VERSION,
      transport: webhookActive ? 'webhook' : 'polling',
      interactive: config.interactive,
      allowlist: { users: config.allowedUserIds.length, chats: config.allowedChatIds.length },
      mode: config.mode,
      digest: config.digestEnabled ? config.digestTime : undefined,
      quietHours: config.quietHours,
      threads: config.threads,
      tableFiles: config.tableFiles,
      approvalTimeoutMs: config.approvalTimeoutMs,
      receiveFiles: config.receiveFiles,
      voiceTranscribe: config.voiceTranscribe,
      voiceTts: config.voiceTts,
      voiceTtsMode: config.voiceTtsMode,
      autonomyEnabled: config.autonomyEnabled,
      outboxEnabled: config.outboxEnabled,
      costMeterEnabled: config.costMeterEnabled,
      budgetAlertEnabled: config.budgetAlertEnabled,
      buttonsPresets: config.buttonsPresets.length,
    }
  }

  function settingsValues() {
    return {
      mode: config.mode,
      digestEnabled: config.digestEnabled,
      digestTime: config.digestTime,
      quietHours: config.quietHours,
      notify: config.notify,
      progress: config.progress,
      typing: config.typing,
      messageStyle: config.messageStyle,
      notifySubagents: config.notifySubagents,
      notifyJobs: config.notifyJobs,
      notifyGoals: config.notifyGoals,
      notifyErrors: config.notifyErrors,
      todoProgress: config.todoProgress,
      threads: config.threads,
      tableFiles: config.tableFiles,
      tableMaxFiles: config.tableMaxFiles,
      approvalTimeoutMs: config.approvalTimeoutMs,
      receiveFiles: config.receiveFiles,
      nativeIncomingImages: config.nativeIncomingImages,
      voiceTranscribe: config.voiceTranscribe,
      voiceEndpoint: config.voiceEndpoint,
      voiceModel: config.voiceModel,
      voiceTts: config.voiceTts,
      voiceTtsMode: config.voiceTtsMode,
      voiceTtsVoice: config.voiceTtsVoice,
      voiceTtsModel: config.voiceTtsModel,
      voiceTtsMaxChars: config.voiceTtsMaxChars,
      autonomyEnabled: config.autonomyEnabled,
      buttonsPresets: config.buttonsPresets,
    }
  }

  function settingsStatus() {
    return {
      version: VERSION,
      transport: webhookActive ? 'webhook' : 'polling',
      webhookSubscribed,
      interactive: config.interactive,
      allowlist: { users: config.allowedUserIds.length, chats: config.allowedChatIds.length },
    }
  }

  let preferredWorkspacePath

  function setPreferredWorkspace(path) {
    preferredWorkspacePath = typeof path === 'string' && path !== '' ? path : undefined
  }

  function targetParams(extra = {}) {
    return {
      chatId: config.chatId,
      userId: config.chatId === undefined ? config.userId : undefined,
      format: config.format,
      notify: config.notify,
      disableLinkPreview: config.disableLinkPreview,
      ...extra,
    }
  }

  async function uploadAndSendAudio({ buffer, format = 'mp3', caption = '🔊', dedupeKey } = {}) {
    const uploaded = await client.uploadMedia({ buffer, filename: `speech.${format}`, type: 'audio' })
    if (!uploaded?.token) return { ok: false, error: 'MAX upload returned no audio token' }
    try {
      if (config.chatId !== undefined && typeof client.sendAction === 'function') {
        await client.sendAction(config.chatId, 'sending_audio')
      }
    } catch {
      // action is cosmetic
    }
    const params = targetParams({
      text: caption,
      attachments: [{ type: 'audio', payload: { token: uploaded.token } }],
    })
    if (outbox) {
      const result = await outbox.deliverNow(params, { dedupeKey, kind: 'tts' })
      return result?.queued ? { ok: false, error: result.error, queued: true } : { ok: true }
    }
    await client.sendMessage(params)
    return { ok: true }
  }

  async function say(text) {
    const value = String(text ?? '').trim()
    if (value === '') return { ok: false, error: 'пустой текст' }
    const check = ttsConfigured(config)
    if (!check.ok) return { ok: false, error: `TTS не настроен: ${check.reason}` }
    const result = await synthesizeSpeech({
      text: value,
      endpoint: config.voiceTtsEndpoint || config.voiceEndpoint,
      apiKey: config.voiceTtsApiKey || config.voiceApiKey,
      model: config.voiceTtsModel,
      voice: config.voiceTtsVoice,
      format: config.voiceTtsFormat,
      speed: config.voiceTtsSpeed,
      maxChars: Math.max(1000, config.voiceTtsMaxChars),
    })
    if (!result.ok) return { ok: false, error: result.error }
    try {
      return await uploadAndSendAudio({ buffer: result.buffer, format: config.voiceTtsFormat, caption: '🔊' })
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function diffSession(sessionId, { staged = false, path } = {}) {
    const info = await statusInfo(sessionId)
    if (!info?.cwd) return { ok: false, error: 'рабочая папка сессии недоступна' }
    const result = await runGitDiff({ cwd: info.cwd, staged, path })
    if (!result.ok) return result
    if (result.empty) return { ok: true, empty: true }
    try {
      const uploaded = await client.uploadMedia({
        buffer: Buffer.from(result.diff, 'utf8'),
        filename: 'diff.patch',
        type: 'file',
      })
      await client.sendMessage(targetParams({
        text: `📄 git diff${staged ? ' (staged)' : ''}: ${result.bytes} байт${result.truncated ? ' (усечён)' : ''}`,
        attachments: [{ type: 'file', payload: { token: uploaded.token } }],
      }))
      return { ok: true, bytes: result.bytes, truncated: result.truncated }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  async function sendFileFromSession(sessionId, arg) {
    const info = await statusInfo(sessionId)
    if (!info?.cwd) return { ok: false, error: 'рабочая папка сессии недоступна' }
    const resolved = resolveSendFile({ cwd: info.cwd, arg, allowOutside: config.fileSendAllowOutside })
    if (!resolved.ok) return resolved
    try {
      const uploaded = await client.uploadMedia({
        filePath: resolved.path,
        filename: resolved.name,
        type: resolved.type,
      })
      await client.sendMessage(targetParams({
        text: `📎 ${resolved.name} · ${formatBytes(resolved.bytes)}`,
        attachments: [{
          type: resolved.type === 'image' ? 'image' : resolved.type === 'audio' ? 'audio' : 'file',
          payload: { token: uploaded.token },
        }],
      }))
      return { ok: true, name: resolved.name, bytes: resolved.bytes }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
  }

  /** Apply allowlisted settings to the live config without a row restart. */
  function applyRuntimeSettings(values = {}) {
    const safe = [
      'mode', 'digestEnabled', 'digestTime', 'quietHours', 'notify', 'progress', 'typing',
      'messageStyle', 'notifySubagents', 'notifyJobs', 'notifyGoals', 'notifyErrors', 'todoProgress',
      'threads', 'tableFiles', 'tableMaxFiles', 'approvalTimeoutMs', 'receiveFiles',
      'nativeIncomingImages', 'voiceTranscribe', 'voiceTts', 'voiceTtsMode', 'voiceTtsVoice',
      'voiceTtsModel', 'voiceTtsMaxChars', 'buttonsPresets',
    ]
    const applied = {}
    const restartRequired = []
    for (const key of Object.keys(values)) {
      if (!safe.includes(key)) {
        restartRequired.push(key)
        continue
      }
      config[key] = values[key]
      applied[key] = values[key]
      if (key === 'mode') state.setMode?.(values[key])
    }
    return { applied, restartRequired: restartRequired.length > 0 }
  }

  async function briefing() {
    let sessions = []
    try {
      sessions = (await listSessions()) ?? []
    } catch (error) {
      logger.warn('cannot list sessions for briefing: %s', error?.message || String(error))
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const recent = sessions.filter((item) => !item.updatedAt || item.updatedAt >= cutoff)
    const pendingCards = state.listPendingCards?.() ?? []
    const pending = {
      approvals: pendingCards.filter((card) => card?.kind === 'approval').length,
      questions: pendingCards.filter((card) => card?.kind === 'question').length,
    }
    let schedules = []
    const service = getService('schedule')
    if (service?.list) {
      try {
        const result = await listSchedules(service, { active: true, limit: 5 })
        if (result.ok) schedules = result.items
      } catch (error) {
        logger.warn('cannot list schedules for briefing: %s', error?.message || String(error))
      }
    }
    return formatBriefingCard({
      sessions: recent,
      pending,
      cost: costMeter?.snapshot(),
      schedules,
    })
  }

  async function promptSessionRich(sessionId, text, { imagePaths = [] } = {}) {
    const value = String(text ?? '').trim()
    let imageParts = []
    if (config.nativeIncomingImages && Array.isArray(imagePaths) && imagePaths.length > 0) {
      const result = readImageParts(imagePaths, { maxParts: 4, maxBytes: 8 * 1024 * 1024 })
      imageParts = result.parts
      for (const error of result.errors) logger.warn('cannot attach incoming image %s: %s', error.path, error.error)
    }
    if (value === '' && imageParts.length === 0) return false
    const content = []
    if (value !== '') content.push({ type: 'text', text: value })
    for (const part of imageParts) content.push(part)

    const controller = getService('sessionController')
    if (controller?.prompt) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 15000)
      timer.unref?.()
      try {
        await controller.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content }, abort.signal)
        return true
      } catch (error) {
        logger.warn('sessionController.prompt failed: %s', error?.message || String(error))
        if (imageParts.length > 0 && value !== '') {
          // A text-only route/model may reject image parts; fall back to the path prompt.
          try {
            await controller.prompt(
              { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: value }] },
              abort.signal,
            )
            return true
          } catch (fallbackError) {
            logger.warn('sessionController.prompt fallback failed: %s', fallbackError?.message || String(fallbackError))
          }
        }
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const agent = getService('agents')?.get?.(sessionId)
      if (!agent) return false
      agent.followup({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } })
      return true
    } catch (error) {
      logger.warn('agent.followup failed: %s', error?.message || String(error))
      return false
    }
  }

  async function promptSession(sessionId, text) {
    return promptSessionRich(sessionId, text)
  }

  const AUDIO_EXTENSIONS = /\.(mp3|ogg|oga|opus|wav|m4a|webm|flac)$/i

  /** Prompt from incoming MAX attachments; images become native image parts and audio can be transcribed. */
  async function promptIncoming(sessionId, text, savedFiles = []) {
    const files = Array.isArray(savedFiles) ? savedFiles : []
    const imagePaths = files
      .filter((file) => file && String(file.type) === 'image' && typeof file.path === 'string')
      .map((file) => file.path)
    let promptText = String(text ?? '')
    const warnings = []
    let transcript
    if (config.voiceTranscribe) {
      const check = voiceConfigured(config)
      if (!check.ok) {
        warnings.push(`голос: ${check.reason}`)
      } else {
        const audio = files.find(
          (file) => file && typeof file.path === 'string' && (String(file.type) === 'audio' || AUDIO_EXTENSIONS.test(file.path)),
        )
        if (audio) {
          const result = await transcribeAudio({
            filePath: audio.path,
            endpoint: config.voiceEndpoint,
            apiKey: config.voiceApiKey,
            model: config.voiceModel,
            language: config.voiceLanguage,
          })
          if (result.ok) {
            transcript = result.text
            const formatted = voicePromptText(result.text)
            promptText = promptText.trim() === '' ? formatted : `${promptText}\n\n${formatted}`
          } else {
            warnings.push(`голос: ${result.error}`)
            logger.warn('cannot transcribe incoming audio: %s', result.error)
          }
        }
      }
    }
    const accepted = await promptSessionRich(sessionId, promptText, { imagePaths })
    return { accepted, transcript, warnings }
  }

  async function createSession(sessionId, sessionArg) {
    const controller = getService('sessionController')
    if (!controller?.create) return { ok: false, error: 'sessionController недоступен' }
    const baseCwd = sessionId ? (await statusInfo(sessionId))?.cwd : undefined
    const cwd =
      !sessionArg && preferredWorkspacePath
        ? preferredWorkspacePath
        : resolveSessionDir({
            arg: sessionArg,
            baseCwd,
            configuredDir: config.newSessionDir,
            fallbackCwd: process.cwd(),
          })
    try {
      mkdirSync(cwd, { recursive: true })
    } catch (error) {
      return { ok: false, error: `не удалось создать папку ${cwd}: ${error?.message || String(error)}` }
    }
    try {
      const value = await controller.create({ cwd })
      return { ok: true, sessionId: value?.sessionId, cwd }
    } catch (error) {
      logger.warn('sessionController.create failed: %s', error?.message || String(error))
      return { ok: false, error: error?.message || String(error) }
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

  const incomingLocal = createIncoming({
    client,
    config,
    logger,
    resolveCwd: async (sessionId) => (await statusInfo(sessionId))?.cwd,
  })

  const target = { chatId: config.chatId, userId: config.chatId === undefined ? config.userId : undefined }
  const state = createState({ file: resolveStateFile(config), logger, chatId: config.chatId })
  const policy = createPolicy({ config, state, logger })
  const audit = createAudit({ file: resolveAuditFile(config), enabled: config.auditLog, logger })
  const outbox = config.outboxEnabled
    ? createOutbox({
        file: resolveOutboxFile(config),
        maxItems: config.outboxMaxItems,
        ttlHours: config.outboxTtlHours,
        logger,
        send: async (call, params) => {
          const method = client?.[call]
          if (typeof method !== 'function') throw new Error(`MAX transport has no ${call}()`)
          return method(params)
        },
      })
    : undefined
  const costMeter = config.costMeterEnabled
    ? createCostMeter({ file: resolveCostLedgerFile(config), logger })
    : undefined
  let schedulePolicyCache = { at: 0, items: [] }

  function scheduleTitleOf(session) {
    try {
      const snapshot = ctx.get?.('sessionTitle')?.get?.(session)
      const title = snapshot?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    } catch {
      // title service is optional
    }
    return resolveTitle(session)
  }

  async function resolveAutonomy(session) {
    if (!config.autonomyEnabled) return undefined
    const policies = state.listSchedulePolicies()
    if (Object.keys(policies).length === 0) return undefined
    const service = getService('schedule')
    if (typeof service?.list !== 'function') return undefined
    const now = Date.now()
    if (now - schedulePolicyCache.at > 5000) {
      const result = await listSchedules(service, { active: true, limit: 500 })
      if (!result.ok) return undefined
      schedulePolicyCache = { at: now, items: result.items }
    }
    const match = resolveAutonomyPolicy({
      sessionId: session?.id,
      sessionTitle: scheduleTitleOf(session),
      schedules: schedulePolicyCache.items,
      policies,
      now,
    })
    return match.ok ? match : undefined
  }

  function setSchedulePolicy(id, mode, title) {
    const normalized = normalizeAutonomyMode(mode)
    if (!normalized) return { ok: false, error: 'режим должен быть inherit|read-only|auto' }
    if (normalized === 'inherit') {
      state.removeSchedulePolicy(id)
      schedulePolicyCache = { at: 0, items: [] }
      audit.write({ kind: 'autonomy', action: 'policy', scheduleId: String(id), mode: 'inherit' })
      return { ok: true, mode: 'inherit' }
    }
    state.setSchedulePolicy(id, { mode: normalized, title })
    schedulePolicyCache = { at: 0, items: [] }
    audit.write({ kind: 'autonomy', action: 'policy', scheduleId: String(id), mode: normalized })
    return { ok: true, mode: normalized }
  }

  const interactions = createInteractions({
    client,
    config,
    logger,
    target,
    resolveTitle: (session) => titleOf(session),
    state,
    audit,
    resolveAutonomy,
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
    runtime: { listSessions, titleFor, costSnapshot: () => costMeter?.snapshot() },
    outbox,
  })
  const bot = createBot({
    client,
    config,
    logger,
    state,
    interactions,
    policy,
    observer,
    health,
    version: VERSION,
    outbox,
    limiter,
    audit,
    runtime: {
      healthUpdate: (patch) => health.update(patch),
      healthFail: (error, options) => health.fail(error, options),
      listSessions,
      statusInfo,
      promptSession,
      cancelSession,
      titleFor,
      saveIncoming: (attachments, sessionId) => incomingLocal.save(attachments, sessionId),
      promptIncoming,
      createSession: (sessionId, sessionArg) => createSession(sessionId, sessionArg),
      listModels,
      currentModel,
      selectModel,
      renameSession,
      forkSession,
      runCommand,
      liveAgent,
      setPlanMode,
      planState,
      searchSessions,
      archiveSession,
      pinSession,
      listWorkspaces,
      createWorkspace,
      setPreferredWorkspace,
      getApprovalPolicy,
      setApprovalPolicy,
      scheduleService: () => getService('schedule'),
      schedulePolicies: () => state.listSchedulePolicies(),
      setSchedulePolicy,
      settingsSummary,
      briefing,
      say,
      diffSession,
      sendFileFromSession,
      costSnapshot: () => costMeter?.snapshot(),
      costForSession: (sessionId) => costMeter?.sessionCost(sessionId),
      budgetStatus: () => costMeter?.budgetStatus(),
    },
  })

  // ── webhook transport (v0.9) ────────────────────────────────────────────
  let webhookRouteDispose
  let webhookActive = false
  let webhookDraining = false
  let webhookRetryTimer
  let webhookSubscribed = false
  let webhookSubscriptionError

  async function drainWebhookQueue() {
    if (webhookDraining || !webhookActive) return
    webhookDraining = true
    try {
      for (;;) {
        const queue = state.getWebhookQueue()
        if (queue.length === 0) break
        const entry = queue[0]
        try {
          await bot.applyUpdate(entry.update)
        } catch (error) {
          logger.warn('cannot process a webhook update: %s', error?.message || String(error))
          health.fail(error)
          const attempts = state.bumpWebhookHeadAttempts()
          if (attempts >= 3) {
            state.shiftWebhookQueue()
            state.save()
            audit.write({ kind: 'webhook', action: 'dead-letter', attempts, error: error?.message || String(error) })
            logger.error?.('dropping poison webhook update after %d attempts: %s', attempts, error?.message || String(error))
            continue
          }
          break
        }
        const nextLength = state.shiftWebhookQueue()
        health.update({ webhookQueueDepth: nextLength, webhookLastProcessedAt: Date.now() })
      }
    } finally {
      webhookDraining = false
      health.update({ webhookQueueDepth: state.getWebhookQueue().length })
    }
  }

  /** Persist one MAX update durably, then answer 200; processing follows. */
  async function acceptWebhookUpdate(update) {
    const key = bot.updateKey?.(update)
    if (key && state.hasProcessed(key)) return
    const queue = state.getWebhookQueue()
    if (key && queue.some((entry) => entry.key === key)) return
    if (queue.length >= config.webhookQueueMax) throw new Error('webhook queue is full')
    const depth = state.pushWebhookQueue({ key, update, at: Date.now() }, config.webhookQueueMax)
    // Durability contract: the 200 must not be sent until the update is on disk.
    state.save()
    health.update({ webhookLastAt: Date.now(), webhookQueueDepth: depth })
    void drainWebhookQueue()
  }

  function ownRoute(webCtx, dispose) {
    if (typeof webCtx?.effect === 'function' && typeof dispose === 'function') {
      try {
        webCtx.effect(() => () => {
          try {
            dispose()
          } catch {
            // already disposed
          }
        })
      } catch {
        // effect support is optional in minimal contexts
      }
    }
    return dispose
  }

  /** Register a named route; replace a stale route left by an HMR generation. */
  function registerRoute(webServer, route) {
    const table = route.kind === 'exact' ? webServer.exact : webServer.prefixes
    if (table instanceof Map && table.has(route.path)) {
      logger.warn('replacing stale webServer route %s', route.path)
      table.delete(route.path)
    }
    const dispose = webServer.register(route)
    return () => {
      try {
        if (table instanceof Map && table.get(route.path) !== route) return
      } catch {
        // fall through to the stock disposer
      }
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
  }

  function registerWebhook(webServer, ownerCtx) {
    if (webhookActive) return true
    if (config.transport !== 'webhook') return false
    if (!config.interactive) {
      logger.info('webhook transport skipped: interactive remote control is off')
      return false
    }
    if (!config.webhookSecret) {
      logger.warn(
        config.webhookSecretInvalid
          ? 'webhook secret must be 32-256 chars [A-Za-z0-9_-]; falling back to long polling'
          : 'webhook transport requested without webhookSecret; falling back to long polling',
      )
      return false
    }
    if (!webServer?.register) {
      logger.warn('webhook transport requested but the DSH webServer service is unavailable; falling back to long polling')
      return false
    }
    try {
      const handler = createWebhookHandler({
        secret: config.webhookSecret,
        accept: acceptWebhookUpdate,
        logger,
      })
      const disposeRoute = registerRoute(webServer, { kind: 'exact', path: config.webhookPath, handler })
      webhookRouteDispose = () => {
        try {
          disposeRoute()
        } finally {
          webhookActive = false
          webhookRuntimeStarted = false
          webhookRouteDispose = undefined
          if (webhookRetryTimer) {
            clearInterval(webhookRetryTimer)
            webhookRetryTimer = undefined
          }
        }
      }
      ownRoute(ownerCtx, webhookRouteDispose)
      webhookActive = true
      config.polling = false
      // A polling fallback may already have started before the webServer service
      // became available; stop it so both transports never consume updates.
      try {
        bot.stopPolling?.()
      } catch {
        // best effort during early startup
      }
      health.update({ transport: 'webhook', webhookPath: config.webhookPath, webhookActive: true, webhookSetupError: undefined })
      if (webhookFallbackTimer) {
        clearTimeout(webhookFallbackTimer)
        webhookFallbackTimer = undefined
      }
      logger.info('MAX webhook route registered: %s', config.webhookPath)
      writeHeartbeat()
      startWebhookRuntime()
      return true
    } catch (error) {
      logger.warn('cannot register the MAX webhook route %s: %s; falling back to long polling', config.webhookPath, error?.message || String(error))
      config.polling = true
      return false
    }
  }

  /** Legacy synchronous path for minimal test contexts without ctx.inject. */
  function setupWebhook() {
    webhookActive = registerWebhook(getService('webServer'), ctx)
    if (!webhookActive) config.polling = true
    return webhookActive
  }

  let webhookRuntimeStarted = false
  function startWebhookRuntime() {
    if (!webhookActive || webhookRuntimeStarted) return
    webhookRuntimeStarted = true
    void drainWebhookQueue()
    void startWebhookSubscription()
    webhookRetryTimer = setInterval(() => {
      void drainWebhookQueue()
    }, 30_000)
    webhookRetryTimer.unref?.()
  }

  let settingsRouteDispose
  function registerSettingsPage(webServer, connection, ownerCtx) {
    if (settingsRouteDispose) return
    if (!config.settingsPage) return
    if (!webServer?.register) {
      logger.debug('settings page disabled: webServer is unavailable')
      return
    }
    const api = createSettingsApi({
      file: settingsFilePath,
      getValues: settingsValues,
      getStatus: settingsStatus,
      getVersion: () => VERSION,
      onSave: applyRuntimeSettings,
      logger,
    })
    try {
      const disposeRoute = registerRoute(webServer, {
        kind: 'exact',
        path: '/max-notify/settings.json',
        handler: async (req, res) => {
          let rejection
          try {
            rejection = connection?.requestRejection ? await connection.requestRejection(req) : 403
          } catch {
            rejection = 403
          }
          if (rejection !== undefined && rejection !== null) {
            res.statusCode = rejection
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          await api(req, res)
        },
      })
      settingsRouteDispose = () => {
        try {
          disposeRoute()
        } finally {
          settingsRouteDispose = undefined
        }
      }
      ownRoute(ownerCtx, settingsRouteDispose)
      logger.info('settings page API ready: /max-notify/settings.json')
    } catch (error) {
      logger.warn('cannot register the settings page route: %s', error?.message || String(error))
    }
  }

  /** Legacy synchronous path for minimal test contexts without ctx.inject. */
  function setupSettingsPage() {
    registerSettingsPage(getService('webServer'), getService('connection'), ctx)
  }

  let webhookFallbackTimer
  function startPollingFallback() {
    if (webhookActive) return
    config.polling = true
    health.update({ transport: 'polling', webhookActive: false, webhookFallbackAt: Date.now() })
    logger.warn('MAX webhook did not activate; using long polling')
    writeHeartbeat()
    try {
      void bot.start()
    } catch (error) {
      logger.warn('cannot start MAX polling fallback: %s', error?.message || String(error))
    }
  }

  if (typeof ctx.inject === 'function') {
    if (config.transport === 'webhook') {
      // Do not start a poller while waiting for the webServer service; rc.2
      // activates the server after the plugin row is constructed.
      config.polling = false
      health.update({ transport: 'webhook', webhookActive: false, webhookDesired: true })
      ctx.inject(['webServer'], (webCtx) => {
        health.update({
          webhookInjectedAt: Date.now(),
          webhookServiceAvailable: Boolean(webCtx?.webServer),
          webhookRegisterAvailable: Boolean(webCtx?.webServer?.register),
        })
        try {
          if (!registerWebhook(webCtx.webServer, webCtx)) {
            health.update({ webhookSetupError: 'registerWebhook returned false' })
            startPollingFallback()
          }
        } catch (error) {
          logger.warn('deferred MAX webhook setup failed: %s', error?.message || String(error))
          health.update({ webhookSetupError: error?.message || String(error) })
          startPollingFallback()
        }
      })
      webhookFallbackTimer = setTimeout(startPollingFallback, 15_000)
      webhookFallbackTimer.unref?.()
    }
    if (config.settingsPage && config.interactive) {
      ctx.inject(['connection', 'webServer'], (webCtx) => {
        registerSettingsPage(webCtx.webServer, webCtx.connection, webCtx)
      })
    }
  } else {
    setupWebhook()
    setupSettingsPage()
  }

  async function startWebhookSubscription() {
    if (!webhookActive || !config.webhookAutoSubscribe) return
    const result = await ensureWebhookSubscription({
      client,
      url: config.webhookPublicUrl,
      secret: config.webhookSecret,
      updateTypes: config.webhookUpdateTypes,
      logger,
    })
    webhookSubscribed = result.ok === true
    webhookSubscriptionError = result.ok ? undefined : result.reason
    health.update({ webhookSubscribed, webhookSubscriptionError })
  }

  // Final-message forwarding (image dedupe + inline keyboard) lives in its own module.
  const { noteSentImages, collectFinalImages, finalKeyboard } = createForwarding({
    client,
    config,
    logger,
    state,
    getService,
  })

  async function deliver(session, text, reason, message, toolImageRefs = [], turn, seq) {
    if (!(await ensureTargetAllowed())) return
    const decision = policy.decide('final')
    if (!decision.send) {
      logger.debug('final reply suppressed (%s)', decision.reason)
      return
    }
    let displayText = text
    let tableAttachments = []
    if (config.tableFiles && config.tableMaxFiles > 0) {
      const tables = buildTableFiles(text, { maxTables: config.tableMaxFiles })
      if (tables.files.length > 0) {
        for (const file of tables.files) {
          try {
            const uploaded = await client.uploadMedia({
              buffer: Buffer.from(file.content, 'utf8'),
              filename: file.filename,
              type: 'file',
            })
            if (uploaded?.token) tableAttachments.push({ type: 'file', payload: { token: uploaded.token } })
          } catch (error) {
            logger.warn('cannot upload %s to MAX: %s', file.filename, error?.message || String(error))
          }
        }
        if (tableAttachments.length > 0) displayText = tables.strippedText
      }
    }
    const payload = formatNotification({
      text: displayText,
      cwd: session?.header?.cwd,
      title: resolveTitle(session),
      sessionId: session?.id,
      reason,
      format: config.format,
      includeHeader: config.includeHeader,
      includeSessionId: config.includeSessionId,
      messageStyle: config.messageStyle,
    })
    const chunkLimit = Math.min(MAX_TEXT_LIMIT, Math.max(200, Number(config.maxChars) || MAX_TEXT_LIMIT))
    const chunks = splitText(payload, chunkLimit).slice(0, 8)
    if (config.dryRun) {
      logger.info('[dry-run] would send %d chunk(s) to MAX: %s', chunks.length, chunks[0]?.slice(0, 120))
      return
    }
    const keyboard = finalKeyboard(session)
    const images = await collectFinalImages(session, text, message, toolImageRefs)
    const attachments =
      images.length > 0 || tableAttachments.length > 0 || keyboard
        ? [...images, ...tableAttachments, ...(keyboard ?? [])]
        : undefined
    const finalKey = `final:${session?.id ?? 'unknown'}:${turn ?? 'na'}:${seq ?? 'na'}`
    let threadMid = config.threads ? state.getAnchor?.(session.id) : undefined
    let queuedAny = false
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      const params = {
        chatId: config.chatId,
        userId: config.chatId === undefined ? config.userId : undefined,
        text: chunk,
        format: config.format,
        notify: decision.notify,
        disableLinkPreview: config.disableLinkPreview,
        ...(isLast && attachments ? { attachments } : {}),
        ...(threadMid ? { link: { type: 'reply', mid: threadMid } } : {}),
      }
      let sent
      if (outbox) {
        const result = await outbox.deliverNow(params, { dedupeKey: `${finalKey}:c${index}`, kind: 'final' })
        if (result?.skipped) continue
        if (result?.queued) {
          queuedAny = true
          logger.warn('MAX is unavailable; final reply chunk %d queued: %s', index + 1, result.error)
          continue
        }
        sent = result?.response
      } else {
        sent = await client.sendMessage(params)
      }
      const mid = sent?.message?.body?.mid
      if (mid) {
        state.mapMessage?.(session.id, mid)
        if (!threadMid && config.threads) {
          threadMid = mid
          state.setAnchor?.(session.id, mid)
        }
      }
      logger.debug('MAX message sent%s', mid ? ` (mid ${mid})` : '')
    }
    if (config.voiceTts && !queuedAny) {
      const speak = shouldSpeak(text, config)
      if (speak.ok) {
        try {
          const audio = await synthesizeSpeech({
            text,
            endpoint: config.voiceTtsEndpoint || config.voiceEndpoint,
            apiKey: config.voiceTtsApiKey || config.voiceApiKey,
            model: config.voiceTtsModel,
            voice: config.voiceTtsVoice,
            format: config.voiceTtsFormat,
            speed: config.voiceTtsSpeed,
            maxChars: config.voiceTtsMaxChars,
          })
          if (audio.ok) {
            const result = await uploadAndSendAudio({
              buffer: audio.buffer,
              format: config.voiceTtsFormat,
              caption: '🔊',
              dedupeKey: `tts:${finalKey}`,
            })
            if (!result.ok) logger.warn('cannot send TTS audio: %s', result.error)
          } else {
            logger.warn('TTS failed: %s', audio.error)
          }
        } catch (error) {
          logger.warn('TTS failed: %s', error?.message || String(error))
        }
      }
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
        pendingToolImages.delete(id)
        progress.onTurnStart(session)
        return
      case 'assistant/message': {
        const text = extractAssistantText(data.message)
        if (!text) return
        // The last non-empty assistant message of the current turn wins.
        pending.set(id, { turn: data.turn, text, message: data.message, seq: event.seq })
        return
      }
      case 'tool/result': {
        if (!config.forwardToolImages || config.maxImages <= 0) return
        if (!config.includeSubagents && !isTopLevelSession(session)) return
        const refs = collectMessageImages(data.message)
        if (refs.length === 0) return
        const entry = pendingToolImages.get(id) ?? { turn: data.turn, refs: [] }
        const seenIds = new Set(entry.refs.map((ref) => String(ref?.attachmentId ?? '')))
        for (const ref of refs) {
          if (entry.refs.length >= config.maxImages) break
          const key = String(ref?.attachmentId ?? '')
          if (key === '' || seenIds.has(key)) continue
          seenIds.add(key)
          entry.refs.push(ref)
        }
        pendingToolImages.set(id, entry)
        return
      }
      case 'turn/end': {
        progress.onTurnEnd(session)
        const toolImages = pendingToolImages.get(id)?.turn === data.turn ? pendingToolImages.get(id).refs : []
        pendingToolImages.delete(id)
        const record = pending.get(id)
        pending.delete(id)
        if (!record || record.turn !== data.turn) return
        const kind = data.reason?.kind ?? 'completed'
        if (config.skipReasons.includes(kind)) return
        const text = record.text.trim()
        if (!text) return
        if (!config.includeSubagents && !isTopLevelSession(session)) return
        void enqueue(() => deliver(session, text, data.reason, record.message, toolImages, data.turn, record.seq))
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
      pendingToolImages.delete(session.id)
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
  function writeHeartbeat() {
    if (!config.heartbeatFile) return
    try {
      const snapshot = health.snapshot({ outbox: outbox?.snapshot?.(), limiter: limiter?.snapshot?.() })
      state.setHealth(snapshot)
      mkdirSync(dirname(config.heartbeatFile), { recursive: true, mode: 0o700 })
      writeFileSync(config.heartbeatFile, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      logger.debug('cannot write heartbeat file: %s', error?.message || String(error))
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      outbox?.start()
      void bot.start()
      if (webhookActive) startWebhookRuntime()
      observer.start()
      writeHeartbeat()
      const healthTimer = setInterval(writeHeartbeat, 60_000)
      healthTimer.unref?.()
      return () => {
        clearInterval(healthTimer)
        if (webhookFallbackTimer) {
          clearTimeout(webhookFallbackTimer)
          webhookFallbackTimer = undefined
        }
        if (webhookRetryTimer) {
          clearInterval(webhookRetryTimer)
          webhookRetryTimer = undefined
        }
        settingsRouteDispose?.()
        webhookRouteDispose?.()
        if (webhookActive && config.webhookRemoveOnStop && config.webhookPublicUrl) {
          void removeWebhookSubscription({ client, url: config.webhookPublicUrl, logger })
        }
        bot.stop()
        observer.dispose()
        progress.dispose()
        interactions.dispose()
        outbox?.dispose()
        limiter.stop()
        state.dispose()
      }
    })
  } else {
    outbox?.start()
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
    config.interactive ? '; remote control on' : '; remote control off',
    config.outboxEnabled ? '; outbox on' : '',
    config.costMeterEnabled ? '; cost-meter on' : '',
    webhookActive ? `; webhook ${config.webhookPath}` : '; long polling',
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


