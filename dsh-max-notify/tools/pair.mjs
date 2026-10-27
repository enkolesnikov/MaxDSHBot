#!/usr/bin/env node
/**
 * MAX pairing helper: long-polls GET /updates and prints the chat_id / user_id
 * you should put into the plugin config (config.chatId).
 *
 * Usage:
 *   node tools/pair.mjs                 # reads /path/to/MaxBot/.env, waits for an update
 *   node tools/pair.mjs --once          # exit after one matching update (default: keep polling)
 *   node tools/pair.mjs --marker 55147  # continue from a known marker
 *
 * While it runs, open MAX and press "Start" (or write any message) in the bot
 * dialog — the bot token must belong to that bot.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createMaxClient } from '../lib/transport.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const STATE_FILE = join(ROOT, '.max-pairing.json')

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      const [, key, rawValue] = match
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2')
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // optional env file
  }
}

function parseArgs(argv) {
  const options = { once: false, marker: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--once') options.once = true
    else if (arg === '--marker') options.marker = argv[++index]
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // best effort
  }
}

function describeUpdate(update) {
  const who = update.user?.name || update.user?.first_name || update.user?.user_id || '?'
  const source = update.message?.sender
  const sender = source?.name || source?.first_name || source?.user_id || '?'
  const text = update.message?.body?.text
  return [
    `type=${update.update_type}`,
    `chat_id=${update.chat_id ?? '-'}`,
    `user_id=${update.user?.user_id ?? source?.user_id ?? update.user_id ?? '-'}`,
    `from=${update.update_type === 'message_created' ? sender : who}`,
    text ? `text=${JSON.stringify(text.slice(0, 120))}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return
  }

  loadEnvFile(join(ROOT, '.env'))
  const token = process.env.MAX_BOT_TOKEN
  if (!token) {
    console.error('MAX_BOT_TOKEN is not set (put it into /path/to/MaxBot/.env)')
    process.exitCode = 1
    return
  }

  const state = readState()
  let marker = options.marker ?? state.marker

  const client = createMaxClient({ token, baseUrl: process.env.MAX_API_BASE })
  const me = await client.getMe()
  console.log(`Бот: ${me.name || me.first_name} (@${me.username || '?'}), user_id=${me.user_id}`)
  if (me.description) console.log(`Описание: ${me.description}`)
  console.log('')
  console.log('Откройте MAX, найдите этого бота и нажмите «Начать» (Start) — жду обновлений...')
  if (marker) console.log(`(продолжаю с marker=${marker})`)

  for (;;) {
    let response
    try {
      response = await client.getUpdates({ timeout: 30, limit: 100, marker })
    } catch (error) {
      console.error(`Ошибка GET /updates: ${error.message}`)
      if (error.status === 401) {
        console.error('Токен, похоже, неверный или отозван.')
        process.exitCode = 1
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
      continue
    }

    if (response?.marker !== undefined) {
      marker = response.marker
      state.marker = marker
      saveState(state)
    }

    for (const update of response?.updates ?? []) {
      console.log(`- ${describeUpdate(update)}`)
      const chatId = update.chat_id ?? update.message?.recipient?.chat_id
      if (chatId !== undefined && (update.update_type === 'bot_started' || update.update_type === 'message_created')) {
        saveState({ ...state, chatId, userId: update.user?.user_id, marker })
        console.log('')
        console.log(`✅ chat_id=${chatId}  user_id=${update.user?.user_id ?? '-'}`)
        console.log('Пропишите его в конфиг плагина (dsh-max-notify): config.chatId')
        if (options.once) return
      }
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
