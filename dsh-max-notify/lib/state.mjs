/**
 * Durable, crash-safe plugin state: the long-polling `marker` and the
 * per-chat active session. Stored outside the repository (default
 * `$DSH_HOME/max-notify/state.json`) so a public checkout never carries
 * private ids.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Resolve the state file: explicit config path, or `$DSH_HOME/max-notify/state.json`. */
export function resolveStateFile(config = {}) {
  if (typeof config.stateFile === 'string' && config.stateFile.trim() !== '') return config.stateFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'max-notify', 'state.json')
}

/**
 * Create the state store. Reads once at startup, writes atomically with a
 * short debounce (one write per burst of marker/session updates).
 */
export function createState({ file, logger, chatId } = {}) {
  const state = {
    marker: undefined,
    sessions: {},
    startedAt: Date.now(),
    mode: undefined,
    muteUntil: undefined,
    digestDate: undefined,
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (parsed.marker !== undefined) state.marker = parsed.marker
      if (parsed.mode === 'all' || parsed.mode === 'errors' || parsed.mode === 'mute') state.mode = parsed.mode
      if (typeof parsed.muteUntil === 'number') state.muteUntil = parsed.muteUntil
      if (typeof parsed.digestDate === 'string') state.digestDate = parsed.digestDate
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

  let timer
  let disposed = false

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        `${JSON.stringify(
          {
            marker: state.marker,
            sessions: state.sessions,
            mode: state.mode,
            muteUntil: state.muteUntil,
            digestDate: state.digestDate,
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
