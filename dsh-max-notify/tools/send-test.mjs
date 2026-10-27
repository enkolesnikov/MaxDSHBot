#!/usr/bin/env node
/**
 * Quick manual test: send a message to the configured MAX chat.
 *
 *   node tools/send-test.mjs "проверка связи"
 *
 * Reads MAX_BOT_TOKEN / MAX_CHAT_ID from /path/to/MaxBot/.env (or the process env).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createMaxClient } from '../lib/transport.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const [, key, raw] = match
    if (!(key in process.env)) process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2')
  }
} catch {
  // .env is optional
}

const token = process.env.MAX_BOT_TOKEN
const chatId = process.env.MAX_CHAT_ID
if (!token || !chatId) {
  console.error('MAX_BOT_TOKEN / MAX_CHAT_ID are not set (put them into /path/to/MaxBot/.env)')
  process.exit(1)
}

const text = process.argv.slice(2).join(' ').trim() || '🔔 dsh-max-notify: тестовое сообщение.'
const client = createMaxClient({ token, baseUrl: process.env.MAX_API_BASE })
const me = await client.getMe()
console.log(`bot: ${me.name || me.first_name} (@${me.username || '?'}), chat_id=${chatId}`)
const result = await client.sendMessage({ chatId, text, format: 'markdown', disableLinkPreview: true })
console.log(`sent: mid=${result?.message?.body?.mid} seq=${result?.message?.body?.seq}`)
