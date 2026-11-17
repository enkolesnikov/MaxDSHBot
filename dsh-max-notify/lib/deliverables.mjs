/**
 * Send files declared by the agent (`present` tool) to MAX as attachments:
 * `POST /uploads` → multipart upload → attachment token → `POST /messages`.
 */
import { statSync } from 'node:fs'
import { formatDeliverablesCard } from './cards.mjs'
import { targetQuery } from './target.mjs'
import { resolveSendFile } from './workspace-tools.mjs'

const IMAGE_LIMIT_BYTES = 50 * 1024 * 1024
const FILE_LIMIT_BYTES = 50 * 1024 * 1024
const MAX_ATTACHMENTS = 12

/**
 * @param {object} options
 * @param {string} [options.cwd] - session working directory, the path boundary.
 * @param {boolean} [options.allowOutside=false] - explicitly allow files outside cwd.
 * @param {Function} [options.resolvePath=resolveSendFile] - resolver with the
 *   `resolveSendFile({ cwd, arg, allowOutside, maxBytes })` contract.
 * The cwd can be overridden per `send(files, { cwd })` call, because the
 * factory is shared while cwd is session-scoped.
 */
export function createDeliverables({
  client,
  config,
  logger,
  target,
  policy,
  cwd,
  allowOutside = false,
  resolvePath = resolveSendFile,
} = {}) {
  function fileRecord(raw) {
    if (typeof raw === 'string') return { path: raw }
    return { path: raw?.path, description: raw?.description }
  }

  async function uploadOne(record, sessionCwd) {
    // Same boundary as /send: realpath + cwd check, unless explicitly allowed.
    // Size stays a deliverables concern (own limits and warn messages).
    const resolved = resolvePath({
      cwd: sessionCwd ?? cwd,
      arg: record.path,
      allowOutside,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })
    if (!resolved?.ok) {
      logger?.warn?.('skip deliverable %s: %s', record.path, resolved?.error ?? 'path rejected by resolver')
      return undefined
    }
    const stats = statSync(resolved.path)
    if (!stats.isFile()) return undefined
    const type = client.uploadTypeFor?.(resolved.path) ?? 'file'
    if (type === 'image' && stats.size > IMAGE_LIMIT_BYTES) {
      logger?.warn?.('skip deliverable image over 50 MB: %s', record.path)
      return undefined
    }
    if (stats.size > FILE_LIMIT_BYTES) {
      logger?.warn?.('skip deliverable file over 50 MB: %s', record.path)
      return undefined
    }
    const { token } = await client.uploadMedia({ filePath: resolved.path, type })
    return { type, token, description: record.description, path: resolved.path }
  }

  /** Upload and send the declared files; failures are logged, never thrown. */
  async function send(files, { cwd: sessionCwd } = {}) {
    if (!config.deliverables || !Array.isArray(files) || files.length === 0) return
    const decision = policy?.decide?.('deliverables') ?? { send: true, notify: config.notify }
    if (!decision.send) return
    const images = []
    const documents = []
    const sentPaths = []
    for (const raw of files) {
      const record = fileRecord(raw)
      if (!record.path) continue
      try {
        const uploaded = await uploadOne(record, sessionCwd)
        if (!uploaded) continue
        if (uploaded.type === 'image') images.push(uploaded)
        else documents.push(uploaded)
        sentPaths.push(record.path)
      } catch (error) {
        logger?.warn?.('cannot upload deliverable %s to MAX: %s', record.path, error?.message || String(error))
      }
    }

    const text = formatDeliverablesCard({ files: [...images, ...documents] })
    if (images.length > 0) {
      try {
        await client.sendWithAttachments({
          ...targetQuery(target),
          text,
          format: config.format,
          notify: decision.notify,
          disableLinkPreview: true,
          attachments: images.slice(0, MAX_ATTACHMENTS).map((image) => ({
            type: 'image',
            payload: { token: image.token },
          })),
        })
      } catch (error) {
        logger?.warn?.('cannot send image deliverables to MAX: %s', error?.message || String(error))
      }
    }
    for (const document of documents.slice(0, MAX_ATTACHMENTS)) {
      try {
        await client.sendWithAttachments({
          ...targetQuery(target),
          text: document.description ? `📎 ${document.description}` : text,
          format: config.format,
          notify: decision.notify,
          disableLinkPreview: true,
          attachments: [{ type: 'file', payload: { token: document.token } }],
        })
      } catch (error) {
        logger?.warn?.('cannot send file deliverable to MAX: %s', error?.message || String(error))
      }
    }
    return sentPaths
  }

  return { send }
}
