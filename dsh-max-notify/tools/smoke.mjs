#!/usr/bin/env node
/**
 * Read-only smoke check for the live plugin.
 *
 * Verifies the token (`GET /me`), prints the durable state (polling marker,
 * health snapshot) and the outbox depth. Sends nothing unless `--send` is
 * passed explicitly.
 *
 * Usage:
 *   node tools/smoke.mjs [--env /path/to/.env] [--send]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createMaxClient } from '../lib/transport.mjs'

function parseArgs(argv) {
  const options = { send: false, envFile: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--send') options.send = true
    else if (argv[index] === '--env') options.envFile = argv[++index]
  }
  return options
}

function loadEnv(file) {
  if (!file) return
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

const options = parseArgs(process.argv.slice(2))
loadEnv(options.envFile)

const token = (process.env.MAX_BOT_TOKEN ?? '').trim()
if (!token) {
  console.error('MAX_BOT_TOKEN is not set (use --env /path/to/.env)')
  process.exit(2)
}
const chatId = process.env.MAX_CHAT_ID
const client = createMaxClient({ token, baseUrl: process.env.MAX_API_BASE })

let failed = false
try {
  const me = await client.getMe()
  console.log(`bot: @${me?.username ?? '?'} (user_id ${me?.user_id ?? '?'})`)
} catch (error) {
  failed = true
  console.error(`GET /me failed: ${error?.message || String(error)}`)
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
for (const [label, file] of [
  ['state', join(home, 'max-notify', 'state.json')],
  ['outbox', join(home, 'max-notify', 'outbox.json')],
]) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (label === 'state') {
      const health = data.health ?? {}
      console.log(
        `state: marker=${data.marker ?? '-'} pollStopped=${health.pollStopped ?? false} lastPollAt=${health.lastPollAt ?? '-'} lastError=${health.lastError ?? '-'}`,
      )
    } else {
      console.log(`outbox: pending=${Array.isArray(data.pending) ? data.pending.length : 0}`)
    }
  } catch {
    console.log(`${label}: not found (${file})`)
  }
}

if (options.send) {
  if (!chatId) {
    console.error('MAX_CHAT_ID is not set; cannot send')
    process.exit(2)
  }
  try {
    const response = await client.sendMessage({
      chatId,
      text: '🧪 dsh-max-notify smoke: плагин отвечает, очередь и транспорт живы.',
      format: 'markdown',
      disableLinkPreview: true,
    })
    console.log(`sent: mid=${response?.message?.body?.mid ?? '?'}`)
  } catch (error) {
    failed = true
    console.error(`send failed: ${error?.message || String(error)}`)
  }
}

process.exit(failed ? 1 : 0)
