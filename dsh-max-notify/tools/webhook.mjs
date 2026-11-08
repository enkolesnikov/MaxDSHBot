#!/usr/bin/env node
/**
 * Manage the MAX webhook subscription from the command line.
 *
 * Usage:
 *   node tools/webhook.mjs status                 # list active subscriptions
 *   node tools/webhook.mjs subscribe              # uses MAX_NOTIFY_WEBHOOK_URL / MAX_NOTIFY_WEBHOOK_SECRET
 *   node tools/webhook.mjs unsubscribe            # removes MAX_NOTIFY_WEBHOOK_URL
 *
 * Options: --env /path/to/.env, --url https://..., --secret ..., --types a,b,c
 */
import { readFileSync } from 'node:fs'
import { createMaxClient } from '../lib/transport.mjs'

function parseArgs(argv) {
  const options = { command: 'status', envFile: undefined, url: undefined, secret: undefined, types: undefined }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--env') options.envFile = argv[++index]
    else if (arg === '--url') options.url = argv[++index]
    else if (arg === '--secret') options.secret = argv[++index]
    else if (arg === '--types') options.types = argv[++index]
    else rest.push(arg)
  }
  if (rest[0]) options.command = rest[0]
  return options
}

function loadEnv(file) {
  if (!file) return
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    if (process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

const options = parseArgs(process.argv.slice(2))
loadEnv(options.envFile)
const token = (process.env.MAX_BOT_TOKEN ?? '').trim()
if (!token) {
  console.error('MAX_BOT_TOKEN is not set (use --env /path/to/.env)')
  process.exit(2)
}
const client = createMaxClient({ token, baseUrl: process.env.MAX_API_BASE })
const url = options.url ?? process.env.MAX_NOTIFY_WEBHOOK_URL
const secret = options.secret ?? process.env.MAX_NOTIFY_WEBHOOK_SECRET
const types = options.types ?? process.env.MAX_NOTIFY_WEBHOOK_TYPES

try {
  if (options.command === 'status') {
    const response = await client.getSubscriptions()
    const subscriptions = Array.isArray(response?.subscriptions) ? response.subscriptions : []
    if (subscriptions.length === 0) console.log('no webhook subscriptions')
    for (const item of subscriptions) {
      console.log(`url: ${item.url}`)
      console.log(`  update_types: ${(item.update_types ?? []).join(',') || '(all)'}`)
    }
  } else if (options.command === 'subscribe') {
    if (!url) throw new Error('webhook URL is required (--url or MAX_NOTIFY_WEBHOOK_URL)')
    if (!/^https:\/\//i.test(url)) throw new Error('MAX requires an https:// webhook URL')
    if (!secret) throw new Error('webhook secret is required (--secret or MAX_NOTIFY_WEBHOOK_SECRET)')
    await client.subscribeWebhook({ url, secret, updateTypes: types })
    console.log(`subscribed: ${url}`)
  } else if (options.command === 'unsubscribe') {
    if (!url) throw new Error('webhook URL is required (--url or MAX_NOTIFY_WEBHOOK_URL)')
    await client.unsubscribeWebhook(url)
    console.log(`unsubscribed: ${url}`)
  } else {
    console.error(`unknown command: ${options.command}`)
    process.exit(2)
  }
} catch (error) {
  console.error(`webhook ${options.command} failed: ${error?.message || String(error)}`)
  process.exit(1)
}
