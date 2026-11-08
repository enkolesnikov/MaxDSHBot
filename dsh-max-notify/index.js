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

import { createMaxClient, splitText, MAX_TEXT_LIMIT } from './lib/transport.mjs'
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
import { collectMessageImages, extractImageReferences } from './lib/images.mjs'
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
import { createLimiter, PRIORITY } from './lib/limits.mjs'
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
  messageStyle: 'compact',
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
  buttonsPresets: [],
  threads: true,
  tableFiles: true,
  tableMaxFiles: 4,
  nativeIncomingImages: true,
  settingsPage: true,
  settingsFile: undefined,
  voiceTranscribe: false,
  voiceEndpoint: undefined,
  voiceApiKey: undefined,
  voiceApiKeyFile: undefined,
  voiceModel: 'whisper-1',
  voiceLanguage: undefined,
  voiceTts: false,
  voiceTtsMode: 'short',
  voiceTtsEndpoint: undefined,
  voiceTtsApiKey: undefined,
  voiceTtsApiKeyFile: undefined,
  voiceTtsModel: 'gpt-4o-mini-tts',
  voiceTtsVoice: 'alloy',
  voiceTtsFormat: 'mp3',
  voiceTtsMaxChars: 600,
  voiceTtsSpeed: undefined,
  fileSendAllowOutside: false,
  autonomyEnabled: true,
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
  notifySubagents: false,
  notifyJobs: false,
  notifyAwaitedJobs: false,
  notifyGoals: false,
  notifyErrors: true,
  todoProgress: false,
  guiNotices: false,
  quietHours: undefined,
  mode: 'all',
  digestEnabled: false,
  digestTime: '21:00',
  forwardImages: true,
  forwardToolImages: true,
  maxImages: 4,
  receiveFiles: true,
  inboxDir: undefined,
  maxIncomingFiles: 4,
  maxIncomingBytes: 25 * 1024 * 1024,
  newSessionDir: undefined,
  // reliability & security (v0.6)
  outboxEnabled: true,
  outboxMaxItems: 200,
  outboxTtlHours: 48,
  outboxFile: undefined,
  ratePerChatPerSecond: 2,
  rateGlobalPerSecond: 30,
  approvalTimeoutMs: 120000,
  approvalRememberTools: [],
  approvalRememberMs: 3600000,
  allowUnlistedUsers: false,
  incomingPerMinute: 30,
  incomingBurst: 10,
  auditLog: true,
  auditFile: undefined,
  heartbeatFile: undefined,
  // cost & budget (v0.8)
  costMeterEnabled: true,
  costMeterFile: undefined,
  budgetAlertEnabled: true,
  budgetAlertThresholds: [80, 100],
  // transport (v0.9)
  transport: 'polling',
  webhookPath: '/max/webhook',
  webhookSecret: undefined,
  webhookPublicUrl: undefined,
  webhookUpdateTypes: 'message_created,message_callback,bot_started,bot_added,bot_removed,bot_admin_permissions_changed',
  webhookAutoSubscribe: true,
  webhookRemoveOnStop: false,
  webhookQueueMax: 200,
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

function normalizePresets(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return { label: item.trim().slice(0, 40), prompt: item.trim() }
      const label = String(item?.label ?? '').trim().slice(0, 40)
      const prompt = String(item?.prompt ?? '').trim()
      return label && prompt ? { label, prompt } : undefined
    })
    .filter(Boolean)
    .slice(0, 6)
}

function asIntArray(value, fallback) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const numbers = raw
    .map((item) => Number(String(item).trim()))
    .filter((number) => Number.isFinite(number) && number > 0 && number <= 1000)
  return numbers.length > 0 ? [...new Set(numbers)].sort((a, b) => a - b) : fallback
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
    buttonsPresets: normalizePresets(merged.buttonsPresets),
    threads: asBoolean(merged.threads, DEFAULTS.threads),
    tableFiles: asBoolean(merged.tableFiles, DEFAULTS.tableFiles),
    tableMaxFiles: asInteger(merged.tableMaxFiles, DEFAULTS.tableMaxFiles, 0, 8),
    nativeIncomingImages: asBoolean(merged.nativeIncomingImages, DEFAULTS.nativeIncomingImages),
    settingsPage: asBoolean(merged.settingsPage, DEFAULTS.settingsPage),
    settingsFile: String(merged.settingsFile || env.MAX_NOTIFY_SETTINGS_FILE || '').trim() || undefined,
    voiceTranscribe: asBoolean(merged.voiceTranscribe, DEFAULTS.voiceTranscribe),
    voiceEndpoint: String(merged.voiceEndpoint || env.MAX_NOTIFY_VOICE_ENDPOINT || '').trim() || undefined,
    voiceApiKey: String(merged.voiceApiKey || env.MAX_NOTIFY_VOICE_API_KEY || '').trim() || undefined,
    voiceApiKeyFile: String(merged.voiceApiKeyFile || env.MAX_NOTIFY_VOICE_API_KEY_FILE || '').trim() || undefined,
    voiceModel: String(merged.voiceModel || DEFAULTS.voiceModel).trim() || DEFAULTS.voiceModel,
    voiceLanguage: String(merged.voiceLanguage || env.MAX_NOTIFY_VOICE_LANGUAGE || '').trim() || undefined,
    voiceTts: asBoolean(merged.voiceTts, DEFAULTS.voiceTts),
    voiceTtsMode: ['off', 'short', 'always'].includes(merged.voiceTtsMode) ? merged.voiceTtsMode : DEFAULTS.voiceTtsMode,
    voiceTtsEndpoint: String(merged.voiceTtsEndpoint || env.MAX_NOTIFY_TTS_ENDPOINT || '').trim() || undefined,
    voiceTtsApiKey: String(merged.voiceTtsApiKey || env.MAX_NOTIFY_TTS_API_KEY || '').trim() || undefined,
    voiceTtsApiKeyFile: String(merged.voiceTtsApiKeyFile || env.MAX_NOTIFY_TTS_API_KEY_FILE || '').trim() || undefined,
    voiceTtsModel: String(merged.voiceTtsModel || DEFAULTS.voiceTtsModel).trim() || DEFAULTS.voiceTtsModel,
    voiceTtsVoice: String(merged.voiceTtsVoice || DEFAULTS.voiceTtsVoice).trim() || DEFAULTS.voiceTtsVoice,
    voiceTtsFormat: ['mp3', 'opus', 'aac', 'flac', 'wav'].includes(merged.voiceTtsFormat) ? merged.voiceTtsFormat : DEFAULTS.voiceTtsFormat,
    voiceTtsMaxChars: asInteger(merged.voiceTtsMaxChars, DEFAULTS.voiceTtsMaxChars, 20, 2000),
    voiceTtsSpeed: Number.isFinite(Number(merged.voiceTtsSpeed)) ? Math.min(4, Math.max(0.25, Number(merged.voiceTtsSpeed))) : undefined,
    fileSendAllowOutside: asBoolean(merged.fileSendAllowOutside, DEFAULTS.fileSendAllowOutside),
    autonomyEnabled: asBoolean(merged.autonomyEnabled, DEFAULTS.autonomyEnabled),
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
  guiNotices: asBoolean(merged.guiNotices, DEFAULTS.guiNotices),
    notifyJobs: asBoolean(merged.notifyJobs, DEFAULTS.notifyJobs),
    notifyAwaitedJobs: asBoolean(merged.notifyAwaitedJobs, DEFAULTS.notifyAwaitedJobs),
    notifyGoals: asBoolean(merged.notifyGoals, DEFAULTS.notifyGoals),
    notifyErrors: asBoolean(merged.notifyErrors, DEFAULTS.notifyErrors),
    todoProgress: asBoolean(merged.todoProgress, DEFAULTS.todoProgress),
    digestEnabled: asBoolean(merged.digestEnabled, DEFAULTS.digestEnabled),
    forwardImages: asBoolean(merged.forwardImages, DEFAULTS.forwardImages),
    maxImages: asInteger(merged.maxImages, DEFAULTS.maxImages, 0, 12),
    forwardToolImages: asBoolean(merged.forwardToolImages, DEFAULTS.forwardToolImages),
    receiveFiles: asBoolean(merged.receiveFiles, DEFAULTS.receiveFiles),
    inboxDir: String(merged.inboxDir || env.MAX_NOTIFY_INBOX_DIR || '').trim() || undefined,
    maxIncomingFiles: asInteger(merged.maxIncomingFiles, DEFAULTS.maxIncomingFiles, 1, 12),
    maxIncomingBytes: asInteger(merged.maxIncomingBytes, DEFAULTS.maxIncomingBytes, 1024, 1024 * 1024 * 1024),
    newSessionDir: String(merged.newSessionDir || env.MAX_NOTIFY_NEW_SESSION_DIR || '').trim() || undefined,
    digestTime: /^\d{2}:\d{2}$/.test(String(merged.digestTime ?? '')) ? String(merged.digestTime) : DEFAULTS.digestTime,
    quietHours: normalizeQuietHours(merged.quietHours),
    mode: ['all', 'errors', 'mute'].includes(merged.mode) ? merged.mode : DEFAULTS.mode,
    outboxEnabled: asBoolean(merged.outboxEnabled, DEFAULTS.outboxEnabled),
    outboxMaxItems: asInteger(merged.outboxMaxItems, DEFAULTS.outboxMaxItems, 1, 5000),
    outboxTtlHours: asInteger(merged.outboxTtlHours, DEFAULTS.outboxTtlHours, 1, 720),
    outboxFile: String(merged.outboxFile || env.MAX_NOTIFY_OUTBOX_FILE || '').trim() || undefined,
    ratePerChatPerSecond: asInteger(merged.ratePerChatPerSecond, DEFAULTS.ratePerChatPerSecond, 1, 100),
    rateGlobalPerSecond: asInteger(merged.rateGlobalPerSecond, DEFAULTS.rateGlobalPerSecond, 1, 1000),
    approvalTimeoutMs: asInteger(merged.approvalTimeoutMs, DEFAULTS.approvalTimeoutMs, 0, 600000),
    approvalRememberTools: asStringArray(merged.approvalRememberTools, DEFAULTS.approvalRememberTools),
    approvalRememberMs: asInteger(merged.approvalRememberMs, DEFAULTS.approvalRememberMs, 60000, 86400000),
    allowUnlistedUsers: asBoolean(merged.allowUnlistedUsers, DEFAULTS.allowUnlistedUsers),
    incomingPerMinute: asInteger(merged.incomingPerMinute, DEFAULTS.incomingPerMinute, 1, 600),
    incomingBurst: asInteger(merged.incomingBurst, DEFAULTS.incomingBurst, 1, 100),
    auditLog: asBoolean(merged.auditLog, DEFAULTS.auditLog),
    auditFile: String(merged.auditFile || env.MAX_NOTIFY_AUDIT_FILE || '').trim() || undefined,
    heartbeatFile: String(merged.heartbeatFile || env.MAX_NOTIFY_HEARTBEAT_FILE || '').trim() || undefined,
    costMeterEnabled: asBoolean(merged.costMeterEnabled, DEFAULTS.costMeterEnabled),
    costMeterFile: String(merged.costMeterFile || env.MAX_NOTIFY_COST_FILE || '').trim() || undefined,
    budgetAlertEnabled: asBoolean(merged.budgetAlertEnabled, DEFAULTS.budgetAlertEnabled),
    budgetAlertThresholds: asIntArray(merged.budgetAlertThresholds, DEFAULTS.budgetAlertThresholds),
    transport: merged.transport === 'webhook' ? 'webhook' : 'polling',
    webhookSecret: String(merged.webhookSecret || env.MAX_NOTIFY_WEBHOOK_SECRET || '').trim() || undefined,
    webhookPublicUrl: String(merged.webhookPublicUrl || env.MAX_NOTIFY_WEBHOOK_URL || '').trim() || undefined,
    webhookUpdateTypes:
      typeof merged.webhookUpdateTypes === 'string' && merged.webhookUpdateTypes.trim() !== ''
        ? merged.webhookUpdateTypes.trim()
        : DEFAULTS.webhookUpdateTypes,
    webhookAutoSubscribe: asBoolean(merged.webhookAutoSubscribe, DEFAULTS.webhookAutoSubscribe),
    webhookRemoveOnStop: asBoolean(merged.webhookRemoveOnStop, DEFAULTS.webhookRemoveOnStop),
    webhookQueueMax: asInteger(merged.webhookQueueMax, DEFAULTS.webhookQueueMax, 1, 5000),
  }

  const format = typeof config.format === 'string' ? config.format.trim().toLowerCase() : ''
  config.format = format === 'markdown' || format === 'html' ? format : undefined
  const channel = (value) => (value === 'max' || value === 'gui' || value === 'both' ? value : 'both')
  config.approvalChannel = channel(merged.approvalChannel)
  config.questionChannel = channel(merged.questionChannel)

  const rawWebhookPath = String(merged.webhookPath ?? '').trim() || DEFAULTS.webhookPath
  const withSlash = rawWebhookPath.startsWith('/') ? rawWebhookPath : `/${rawWebhookPath}`
  config.webhookPath = withSlash.replace(/\/+$/, '') || DEFAULTS.webhookPath

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
          break
        }
        const next = state.getWebhookQueue()
        next.shift()
        state.setWebhookQueue(next)
        state.save()
        health.update({ webhookQueueDepth: next.length, webhookLastProcessedAt: Date.now() })
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
    queue.push({ key, update, at: Date.now() })
    state.setWebhookQueue(queue)
    state.save()
    health.update({ webhookLastAt: Date.now(), webhookQueueDepth: queue.length })
    void drainWebhookQueue()
  }

  function setupWebhook() {
    if (config.transport !== 'webhook') return false
    if (!config.interactive) {
      logger.info('webhook transport skipped: interactive remote control is off')
      return false
    }
    if (!config.webhookSecret) {
      logger.warn('webhook transport requested without webhookSecret; falling back to long polling')
      return false
    }
    const webServer = getService('webServer')
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
      webhookRouteDispose = webServer.register({ kind: 'exact', path: config.webhookPath, handler })
      webhookActive = true
      config.polling = false
      health.update({ transport: 'webhook', webhookPath: config.webhookPath, webhookActive: true })
      logger.info('MAX webhook route registered: %s', config.webhookPath)
      return true
    } catch (error) {
      logger.warn('cannot register the MAX webhook route %s: %s; falling back to long polling', config.webhookPath, error?.message || String(error))
      config.polling = true
      return false
    }
  }

  webhookActive = setupWebhook()

  let settingsRouteDispose
  function setupSettingsPage() {
    if (!config.settingsPage || !config.interactive) return
    const webServer = getService('webServer')
    if (!webServer?.register) {
      logger.debug('settings page disabled: webServer is unavailable')
      return
    }
    const connection = getService('connection')
    const api = createSettingsApi({
      file: settingsFilePath,
      getValues: settingsValues,
      getStatus: settingsStatus,
      getVersion: () => VERSION,
      onSave: applyRuntimeSettings,
      logger,
    })
    try {
      settingsRouteDispose = webServer.register({
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
      logger.info('settings page API ready: /max-notify/settings.json')
    } catch (error) {
      logger.warn('cannot register the settings page route: %s', error?.message || String(error))
    }
  }
  setupSettingsPage()

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
  async function collectFinalImages(session, text, message, toolImageRefs = []) {
    if (!config.forwardImages || config.maxImages <= 0) return []
    const max = config.maxImages
    const key = String(session?.id ?? '')
    const seen = imagesSent.get(key) ?? new Set()
    const attachments = []

    const blockRefs = [...collectMessageImages(message), ...(Array.isArray(toolImageRefs) ? toolImageRefs : [])]
    const seenIds = new Set()
    for (const ref of blockRefs) {
      const attachmentId = String(ref?.attachmentId ?? '')
      if (attachmentId !== '' && seenIds.has(attachmentId)) continue
      if (attachmentId !== '') seenIds.add(attachmentId)
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
    const presets = Array.isArray(config.buttonsPresets) ? config.buttonsPresets.slice(0, 4) : []
    for (let index = 0; index < presets.length; index += 2) {
      rows.push(
        presets.slice(index, index + 2).map((preset, offset) => ({
          type: 'callback',
          text: preset.label,
          payload: JSON.stringify({ t: 'qa', a: 'preset', s: sessionId, i: index + offset }),
        })),
      )
    }
    if (config.webUrl) rows.push([{ type: 'link', text: '🖥 Открыть GUI', url: config.webUrl }])
    return [{ type: 'inline_keyboard', payload: { buttons: rows } }]
  }

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
    const chunks = splitText(payload, MAX_TEXT_LIMIT).slice(0, 8)
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
      writeFileSync(config.heartbeatFile, `${JSON.stringify(snapshot, null, 2)}\n`)
    } catch (error) {
      logger.debug('cannot write heartbeat file: %s', error?.message || String(error))
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      outbox?.start()
      void bot.start()
      if (webhookActive) {
        void drainWebhookQueue()
        void startWebhookSubscription()
        webhookRetryTimer = setInterval(() => {
          void drainWebhookQueue()
        }, 30_000)
        webhookRetryTimer.unref?.()
      }
      observer.start()
      writeHeartbeat()
      const healthTimer = setInterval(writeHeartbeat, 60_000)
      healthTimer.unref?.()
      return () => {
        clearInterval(healthTimer)
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

