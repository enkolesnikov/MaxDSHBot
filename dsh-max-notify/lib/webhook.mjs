/**
 * MAX webhook transport.
 *
 * MAX POSTs every subscribed update to a public HTTPS endpoint. The handler must
 * verify `X-Max-Bot-Api-Secret` in constant time, accept a small JSON body, and
 * answer 200 quickly (MAX retries failed deliveries and auto-unsubscribes after
 * 8 hours). Delivery is at-least-once, so the update is persisted to a durable
 * queue before the response and processed idempotently afterwards.
 */
import { timingSafeEqual } from 'node:crypto'

const DEFAULT_MAX_BYTES = 1024 * 1024

/** Constant-time comparison of the webhook secret header. */
export function safeEqual(provided, expected) {
  const left = Buffer.from(String(provided ?? ''))
  const right = Buffer.from(String(expected ?? ''))
  return left.length === right.length && timingSafeEqual(left, right)
}

function send(res, status, body) {
  if (!res || typeof res.end !== 'function') return
  try {
    res.statusCode = status
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  } catch {
    // the response may already be closed
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error(`webhook body exceeds ${limit} bytes`)
        error.status = 413
        reject(error)
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {object} options
 * @param {string} options.secret - expected `X-Max-Bot-Api-Secret` value.
 * @param {(update: object) => Promise<void>|void} options.accept - persist/enqueue one update.
 * @param {object} [options.logger]
 * @param {number} [options.maxBytes]
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createWebhookHandler({ secret, accept, logger, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return async function handleWebhook(req, res) {
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      send(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (typeof secret !== 'string' || secret === '') {
      logger?.warn?.('webhook request rejected: no secret configured')
      send(res, 503, { ok: false, error: 'webhook is not configured' })
      return
    }
    const provided = req?.headers?.['x-max-bot-api-secret']
    if (!safeEqual(provided, secret)) {
      logger?.warn?.('webhook request rejected: bad secret')
      send(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    let update
    try {
      const raw = await readBody(req, maxBytes)
      update = JSON.parse(raw)
    } catch (error) {
      const status = error?.status === 413 ? 413 : 400
      send(res, status, { ok: false, error: error?.message || 'invalid body' })
      return
    }
    try {
      await accept(update)
      send(res, 200, { ok: true })
    } catch (error) {
      logger?.warn?.('webhook update could not be persisted: %s', error?.message || String(error))
      send(res, 503, { ok: false, error: 'temporarily unavailable' })
    }
  }
}

/**
 * Ensure the MAX bot is subscribed to the public webhook URL.
 * Re-posting is idempotent and updates the secret/update types.
 */
export async function ensureWebhookSubscription({ client, url, secret, updateTypes, logger } = {}) {
  if (!client?.subscribeWebhook) return { ok: false, reason: 'transport has no subscribeWebhook()' }
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    return { ok: false, reason: 'webhookPublicUrl must be an https:// URL (MAX requirement)' }
  }
  try {
    const current = await client.getSubscriptions?.()
    const subscriptions = Array.isArray(current?.subscriptions) ? current.subscriptions : []
    const existing = subscriptions.find((item) => item?.url === url)
    await client.subscribeWebhook({ url, secret, updateTypes })
    logger?.info?.('MAX webhook subscribed: %s%s', url, existing ? ' (updated)' : '')
    return { ok: true, existing: Boolean(existing) }
  } catch (error) {
    const message = error?.message || String(error)
    logger?.warn?.('cannot subscribe to the MAX webhook: %s', message)
    return { ok: false, reason: message }
  }
}

/** Remove the webhook subscription (best effort). */
export async function removeWebhookSubscription({ client, url, logger } = {}) {
  if (!client?.unsubscribeWebhook || typeof url !== 'string' || url === '') return { ok: false }
  try {
    await client.unsubscribeWebhook(url)
    logger?.info?.('MAX webhook unsubscribed: %s', url)
    return { ok: true }
  } catch (error) {
    logger?.warn?.('cannot unsubscribe the MAX webhook: %s', error?.message || String(error))
    return { ok: false, reason: error?.message || String(error) }
  }
}
