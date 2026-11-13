/**
 * Plugin configuration: defaults, environment fallbacks and validation.
 * Kept dependency-free besides the MAX text limit constant.
 */
import { MAX_TEXT_LIMIT } from './transport.mjs'

export const DEFAULTS = {
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
  const rawWebhookSecret = String(merged.webhookSecret || env.MAX_NOTIFY_WEBHOOK_SECRET || '').trim()
  const validWebhookSecret = /^[A-Za-z0-9_-]{32,256}$/.test(rawWebhookSecret)

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
    webhookSecret: validWebhookSecret ? rawWebhookSecret : undefined,
    webhookSecretInvalid: rawWebhookSecret !== '' && !validWebhookSecret,
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

