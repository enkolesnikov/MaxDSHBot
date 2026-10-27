/**
 * Collect images referenced by a final agent answer: image content blocks and
 * image references inside the visible markdown (local files or http(s) URLs).
 *
 * Local paths resolve against the Session's working directory; only existing
 * image files below the size cap are returned. Fenced/inline code is ignored so
 * code samples never turn into attachments.
 */
import { statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic'])
const IMAGE_EXTENSION_PATTERN = 'png|jpe?g|gif|webp|bmp|tiff?|heic'
const MAX_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024

/** Remove fenced code blocks and inline code spans. */
export function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

function isImagePath(value) {
  return IMAGE_EXTENSIONS.has(extname(String(value)).toLowerCase())
}

function existingImageFile(path) {
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size <= MAX_LOCAL_IMAGE_BYTES
  } catch {
    return false
  }
}

/**
 * Extract local image files and remote image URLs from visible answer text.
 * @param {string} text - assistant answer text.
 * @param {string} [cwd] - Session working directory for relative paths.
 * @returns {{files: string[], urls: string[]}}
 */
export function extractImageReferences(text, cwd) {
  const visible = stripCode(text)
  const files = []
  const urls = []

  const addTarget = (raw) => {
    const value = String(raw ?? '').trim().replace(/^[("'`]+|[)"'`,.]+$/g, '')
    if (value === '') return
    if (/^https?:\/\//i.test(value)) {
      if (!urls.includes(value)) urls.push(value)
      return
    }
    if (/^data:/i.test(value)) return
    const absolute = isAbsolute(value) ? value : resolve(cwd || process.cwd(), value)
    if (!files.includes(absolute)) files.push(absolute)
  }

  // Markdown images: ![alt](path "title")
  for (const match of visible.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) {
    addTarget(match[1])
  }
  // Bare local paths: shot.png, ./shot.png, /tmp/chart.jpg, ../out/plot.webp
  const barePath = new RegExp(
    `(?:^|[\\s("'\`])((?:\\.{0,2}/|/)?[^\\s)\\]"'\`]+?\\.(?:${IMAGE_EXTENSION_PATTERN}))`,
    'gi',
  )
  for (const match of visible.matchAll(barePath)) addTarget(match[1])
  // Remote image URLs
  const remoteUrl = new RegExp(`https?://[^\\s)\\]"'\`]+?\\.(?:${IMAGE_EXTENSION_PATTERN})(?:\\?[^\\s)\\]"'\`]*)?`, 'gi')
  for (const match of visible.matchAll(remoteUrl)) addTarget(match[0])

  const existing = files.filter((file) => isImagePath(file) && existingImageFile(file))
  return { files: existing, urls }
}

/** Image content blocks of one assistant message (future-proof: adapters may emit them). */
export function collectMessageImages(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'image' && block.attachment)
    .map((block) => block.attachment)
}

export { IMAGE_EXTENSIONS, MAX_LOCAL_IMAGE_BYTES }
