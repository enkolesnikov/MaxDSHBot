/**
 * Durable, crash-safe plugin state.
 *
 * Stored outside the repository (default `$DSH_HOME/max-notify/state.json`) so a
 * public checkout never carries private ids. Schema v2 adds:
 *  - `health`       — last poll/send/error snapshot for `/health` and monitoring;
 *  - `processed`    — bounded dedupe keys of handled MAX updates (at-least-once polling);
 *  - `pendingCards` — approval/question cards that must be marked stale after a reload;
 *  - `approvalRules`— explicitly remembered tool approvals (`/approve`-style scope);
 *  - `schemaVersion`— migration marker (v1 state loads unchanged).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const STATE_SCHEMA_VERSION = 2
const PROCESSED_LIMIT = 1000
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Resolve the state file: explicit config path, or `$DSH_HOME/max-notify/state.json`. */
export function resolveStateFile(config = {}) {
  if (typeof config.stateFile === 'string' && config.stateFile.trim() !== '') return config.stateFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'state.json')
}

/**
 * Create the state store. Reads once at startup, writes atomically with a
 * short debounce (one write per burst of updates).
 */
export function createState({ file, logger, chatId } = {}) {
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    marker: undefined,
    sessions: {},
    mode: undefined,
    muteUntil: undefined,
    digestDate: undefined,
    health: {},
    /** @type {Array<{key: string, at: number}>} */
    processed: [],
    /** @type {Array<{token: string, kind: 'approval'|'question', messageId?: string, chatId?: string, createdAt: number}>} */
    pendingCards: [],
    /** @type {Array<{tool: string, until: number, createdAt: number}>} */
    approvalRules: [],
    /** periodKey:threshold -> timestamp of the last sent budget alert */
    budgetAlerts: {},
    /** Durable webhook updates: [{ key, update, at }] */
    webhookQueue: [],
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (parsed.marker !== undefined) state.marker = parsed.marker
      if (parsed.mode === 'all' || parsed.mode === 'errors' || parsed.mode === 'mute') state.mode = parsed.mode
      if (typeof parsed.muteUntil === 'number') state.muteUntil = parsed.muteUntil
      if (typeof parsed.digestDate === 'string') state.digestDate = parsed.digestDate
      if (parsed.health && typeof parsed.health === 'object') state.health = parsed.health
      if (Array.isArray(parsed.processed)) {
        state.processed = parsed.processed.filter((entry) => entry && typeof entry.key === 'string' && Number.isFinite(entry.at))
      }
      if (Array.isArray(parsed.pendingCards)) {
        state.pendingCards = parsed.pendingCards.filter(
          (entry) => entry && typeof entry.token === 'string' && (entry.kind === 'approval' || entry.kind === 'question'),
        )
      }
      if (Array.isArray(parsed.webhookQueue)) {
        state.webhookQueue = parsed.webhookQueue.filter(
          (entry) => entry && typeof entry === 'object' && entry.update && typeof entry.update === 'object',
        )
      }
      if (parsed.budgetAlerts && typeof parsed.budgetAlerts === 'object' && !Array.isArray(parsed.budgetAlerts)) {
        state.budgetAlerts = { ...parsed.budgetAlerts }
      }
      if (Array.isArray(parsed.approvalRules)) {
        state.approvalRules = parsed.approvalRules.filter(
          (rule) => rule && typeof rule.tool === 'string' && Number.isFinite(rule.until),
        )
      }
      if (parsed.sessions && typeof parsed.sessions === 'object') {
        // Keep only the configured chat's session: a shared state file may hold
        // leftovers from tests or other targets.
        if (chatId !== undefined && chatId !== null) {
          const value = parsed.sessions[String(chatId)]
          if (typeof value === 'string' && value !== '') state.sessions = { [String(chatId)]: value }
        } else {
          state.sessions = parsed.sessions
        }
      }
    }
  } catch {
    // absent/corrupt state is fine: start fresh
  }

  // Drop expired dedupe keys and approval rules immediately on load.
  prune()

  let timer
  let disposed = false

  function prune() {
    const now = Date.now()
    for (let index = state.processed.length - 1; index >= 0; index -= 1) {
      if (state.processed[index].at < now - PROCESSED_TTL_MS) state.processed.splice(index, 1)
    }
    if (state.processed.length > PROCESSED_LIMIT) state.processed.splice(0, state.processed.length - PROCESSED_LIMIT)
    state.approvalRules = state.approvalRules.filter((rule) => rule.until > now)
    if (state.pendingCards.length > 50) state.pendingCards.splice(0, state.pendingCards.length - 50)
  }

  function save() {
    try {
      prune()
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        `${JSON.stringify(
          {
            schemaVersion: STATE_SCHEMA_VERSION,
            marker: state.marker,
            sessions: state.sessions,
            mode: state.mode,
            muteUntil: state.muteUntil,
            digestDate: state.digestDate,
            health: state.health,
            processed: state.processed,
            pendingCards: state.pendingCards,
            approvalRules: state.approvalRules,
            budgetAlerts: state.budgetAlerts,
            webhookQueue: state.webhookQueue,
          },
          null,
          2,
        )}\n`,
      )
      renameSync(tmp, file)
    } catch (error) {
      logger?.warn?.('cannot persist MAX state to %s: %s', file, error?.message || String(error))
    }
  }

  function saveSoon() {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      save()
    }, 250)
    timer.unref?.()
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    get marker() {
      return state.marker
    },
    setMarker(marker) {
      if (marker === undefined || marker === null) return
      state.marker = marker
      saveSoon()
    },
    sessionFor(chatId) {
      const value = state.sessions[String(chatId)]
      return typeof value === 'string' && value !== '' ? value : undefined
    },
    setSession(chatId, sessionId) {
      if (sessionId === undefined || sessionId === null) return
      state.sessions[String(chatId)] = String(sessionId)
      saveSoon()
    },
    forgetSession(chatId) {
      delete state.sessions[String(chatId)]
      saveSoon()
    },
    getMode() {
      return state.mode
    },
    setMode(mode) {
      state.mode = mode
      saveSoon()
    },
    getMuteUntil() {
      return state.muteUntil
    },
    setMuteUntil(value) {
      state.muteUntil = value
      saveSoon()
    },
    getDigestDate() {
      return state.digestDate
    },
    setDigestDate(value) {
      state.digestDate = value
      saveSoon()
    },
    getHealth() {
      return { ...state.health }
    },
    setHealth(patch) {
      if (!patch || typeof patch !== 'object') return
      state.health = { ...state.health, ...patch }
      saveSoon()
    },
    hasProcessed(key) {
      const value = String(key)
      return state.processed.some((entry) => entry.key === value)
    },
    markProcessed(key) {
      const value = String(key)
      if (value === '' || state.processed.some((entry) => entry.key === value)) return
      state.processed.push({ key: value, at: Date.now() })
      saveSoon()
    },
    listPendingCards() {
      return state.pendingCards.map((entry) => ({ ...entry }))
    },
    addPendingCard(card) {
      if (!card || typeof card.token !== 'string') return
      state.pendingCards.push({ ...card, createdAt: card.createdAt ?? Date.now() })
      saveSoon()
    },
    removePendingCard(token) {
      const index = state.pendingCards.findIndex((entry) => entry.token === token)
      if (index >= 0) {
        state.pendingCards.splice(index, 1)
        saveSoon()
      }
    },
    approvalRuleFor(toolName, at = Date.now()) {
      const name = String(toolName ?? '')
      return state.approvalRules.find((rule) => rule.tool === name && rule.until > at)
    },
    setApprovalRule(toolName, until) {
      const name = String(toolName ?? '')
      if (name === '' || !Number.isFinite(until)) return
      state.approvalRules = state.approvalRules.filter((rule) => rule.tool !== name && rule.until > Date.now())
      state.approvalRules.push({ tool: name, until, createdAt: Date.now() })
      saveSoon()
    },
    getWebhookQueue() {
      return state.webhookQueue.map((entry) => ({ ...entry }))
    },
    setWebhookQueue(queue) {
      const list = Array.isArray(queue) ? queue.filter((entry) => entry && entry.update) : []
      state.webhookQueue = list.slice(-200)
      saveSoon()
    },
    getBudgetAlerts() {
      return { ...state.budgetAlerts }
    },
    setBudgetAlerts(alerts) {
      if (!alerts || typeof alerts !== 'object') return
      state.budgetAlerts = { ...alerts }
      saveSoon()
    },
    clearApprovalRules() {
      state.approvalRules = []
      saveSoon()
    },
    save,
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      save()
    },
  }
}
