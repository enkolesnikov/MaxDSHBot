/**
 * Forwarding of the final assistant answer: images attached to or referenced by
 * the answer, and the inline "final" keyboard (Продолжить/Стоп, presets, GUI).
 *
 * The image dedupe map (`imagesSent`) is per factory instance and per session:
 * files already delivered by the `deliverables/presented` pipeline are not
 * re-sent with the final message, and files uploaded successfully once are not
 * uploaded again for the same session.
 */
import { collectMessageImages, extractImageReferences } from './images.mjs'

/**
 * @param {object} options
 * @param {object} options.client - MAX client (guarded proxy from index.js).
 * @param {object} options.config - normalized plugin config.
 * @param {object} [options.logger] - redacting logger.
 * @param {object} [options.state] - reserved for a future shared forwarding
 *   state, mirroring the other factories; the dedupe map stays private for now.
 * @param {(name: string) => any} [options.getService] - host service accessor
 *   (`ctx.get`) used to read image blocks through the `attachments` service.
 * @returns {{noteSentImages: Function, collectFinalImages: Function, finalKeyboard: Function}}
 */
export function createForwarding({ client, config, logger, state, getService = () => undefined } = {}) {
  /** Paths already sent to MAX by the deliverables pipeline (per session). */
  const imagesSent = new Map()

  function noteSentImages(sessionId, paths) {
    if (!Array.isArray(paths) || paths.length === 0) return
    const key = String(sessionId ?? '')
    const set = imagesSent.get(key) ?? new Set()
    for (const path of paths) set.add(String(path))
    imagesSent.set(key, set)
  }

  /**
   * Images from the final answer: assistant image blocks plus images referenced
   * in the visible markdown (local files relative to the session cwd, or URLs).
   */
  async function collectFinalImages(session, text, message, toolImageRefs = []) {
    if (!config.forwardImages || config.maxImages <= 0) return []
    const max = config.maxImages
    const key = String(session?.id ?? '')
    const seen = imagesSent.get(key) ?? new Set()
    const attachments = []

    const blockRefs = [...collectMessageImages(message), ...(Array.isArray(toolImageRefs) ? toolImageRefs : [])]
    const seenIds = new Set()
    for (const ref of blockRefs) {
      const attachmentId = String(ref?.attachmentId ?? '')
      if (attachmentId !== '' && seenIds.has(attachmentId)) continue
      if (attachmentId !== '') seenIds.add(attachmentId)
      if (attachments.length >= max) break
      try {
        const stored = await getService?.('attachments')?.readImage?.(ref)
        if (!stored?.data) continue
        const uploaded = await client.uploadMedia({
          buffer: Buffer.from(stored.data),
          filename: ref?.name ?? 'image.png',
          type: 'image',
        })
        attachments.push({ type: 'image', payload: { token: uploaded.token } })
      } catch (error) {
        logger?.warn?.('cannot forward an image from the final message: %s', error?.message || String(error))
      }
    }

    const refs = extractImageReferences(text, session?.header?.cwd)
    for (const file of refs.files) {
      if (attachments.length >= max) break
      if (seen.has(file)) continue
      try {
        const uploaded = await client.uploadMedia({ filePath: file, type: 'image' })
        attachments.push({ type: 'image', payload: { token: uploaded.token } })
        seen.add(file)
      } catch (error) {
        logger?.warn?.('cannot forward image %s: %s', file, error?.message || String(error))
      }
    }
    for (const url of refs.urls) {
      if (attachments.length >= max) break
      attachments.push({ type: 'image', payload: { url } })
    }
    imagesSent.set(key, seen)
    return attachments
  }

  function finalKeyboard(session) {
    if (!config.buttons) return undefined
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return undefined
    const rows = [
      [
        { type: 'callback', text: '▶️ Продолжить', payload: JSON.stringify({ t: 'qa', a: 'cont', s: sessionId }) },
        { type: 'callback', text: '⏹ Стоп', payload: JSON.stringify({ t: 'qa', a: 'stop', s: sessionId }) },
      ],
    ]
    const presets = Array.isArray(config.buttonsPresets) ? config.buttonsPresets.slice(0, 4) : []
    for (let index = 0; index < presets.length; index += 2) {
      rows.push(
        presets.slice(index, index + 2).map((preset, offset) => ({
          type: 'callback',
          text: preset.label,
          payload: JSON.stringify({ t: 'qa', a: 'preset', s: sessionId, i: index + offset }),
        })),
      )
    }
    if (config.webUrl) rows.push([{ type: 'link', text: '🖥 Открыть GUI', url: config.webUrl }])
    return [{ type: 'inline_keyboard', payload: { buttons: rows } }]
  }

  return { noteSentImages, collectFinalImages, finalKeyboard }
}
