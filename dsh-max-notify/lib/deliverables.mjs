/**
 * Send files declared by the agent (`present` tool) to MAX as attachments:
 * `POST /uploads` → multipart upload → attachment token → `POST /messages`.
 */
import { statSync } from 'node:fs'
import { formatDeliverablesCard } from './cards.mjs'

const IMAGE_LIMIT_BYTES = 50 * 1024 * 1024
const FILE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ATTACHMENTS = 12

export function createDeliverables({ client, config, logger, target } = {}) {
  const targetQuery = () =>
    target?.chatId !== undefined ? { chatId: target.chatId } : { userId: target?.userId }

  function fileRecord(raw) {
    if (typeof raw === 'string') return { path: raw }
    return { path: raw?.path, description: raw?.description }
  }

  async function uploadOne(record) {
    const stats = statSync(record.path)
    if (!stats.isFile()) return undefined
    const type = client.uploadTypeFor?.(record.path) ?? 'file'
    if (type === 'image' && stats.size > IMAGE_LIMIT_BYTES) {
      logger?.warn?.('skip deliverable image over 50 MB: %s', record.path)
      return undefined
    }
    if (stats.size > FILE_LIMIT_BYTES) {
      logger?.warn?.('skip deliverable file over 4 GB: %s', record.path)
      return undefined
    }
    const { token } = await client.uploadMedia({ filePath: record.path, type })
    return { type, token, description: record.description, path: record.path }
  }

  /** Upload and send the declared files; failures are logged, never thrown. */
  async function send(files) {
    if (!config.deliverables || !Array.isArray(files) || files.length === 0) return
    const images = []
    const documents = []
    for (const raw of files) {
      const record = fileRecord(raw)
      if (!record.path) continue
      try {
        const uploaded = await uploadOne(record)
        if (!uploaded) continue
        if (uploaded.type === 'image') images.push(uploaded)
        else documents.push(uploaded)
      } catch (error) {
        logger?.warn?.('cannot upload deliverable %s to MAX: %s', record.path, error?.message || String(error))
      }
    }

    const text = formatDeliverablesCard({ files: [...images, ...documents] })
    if (images.length > 0) {
      try {
        await client.sendWithAttachments({
          ...targetQuery(),
          text,
          format: config.format,
          notify: config.notify,
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
          ...targetQuery(),
          text: document.description ? `📎 ${document.description}` : text,
          format: config.format,
          notify: config.notify,
          disableLinkPreview: true,
          attachments: [{ type: 'file', payload: { token: document.token } }],
        })
      } catch (error) {
        logger?.warn?.('cannot send file deliverable to MAX: %s', error?.message || String(error))
      }
    }
  }

  return { send }
}
