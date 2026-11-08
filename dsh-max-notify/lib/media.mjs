/**
 * Incoming images as native DSH image parts: media type by signature/extension,
 * base64 payload, per-file and per-batch size/parts limits. Read-only: never
 * writes to disk.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

const EXTENSION_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_PARTS = 4
const GIF_SIGNATURES = new Set(['GIF87a', 'GIF89a'])

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return undefined
}

function sniffMediaType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buffer.length >= 6 && GIF_SIGNATURES.has(buffer.toString('ascii', 0, 6))) {
    return 'image/gif'
  }
  return undefined
}

/**
 * Media type by file extension (case-insensitive).
 * @param {string} filePath
 * @returns {string|undefined} image/png, image/jpeg, image/webp or image/gif
 */
export function imageMediaTypeFor(filePath) {
  const value = typeof filePath === 'string' ? filePath : String(filePath ?? '')
  if (value === '') return undefined
  return EXTENSION_TYPES[extname(value).toLowerCase()]
}

/**
 * Media type by magic bytes; falls back to the file extension when the
 * signature is unknown (e.g. an empty or truncated file).
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [filePath]
 * @returns {string|undefined}
 */
export function detectImageMediaType(buffer, filePath) {
  const bytes = asBuffer(buffer)
  if (!bytes) return undefined
  return sniffMediaType(bytes) ?? imageMediaTypeFor(filePath)
}

function maxBytesOption(value) {
  const limit = Number(value)
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MAX_BYTES
}

/**
 * Read one image file into a native DSH image part. Synchronous.
 * @param {object} options
 * @param {string} options.path - image file path.
 * @param {string} [options.name] - display name (defaults to the basename).
 * @param {number} [options.maxBytes=8388608] - per-file size limit.
 * @returns {{type: 'image', mediaType: string, data: string, name: string}}
 * @throws {Error} file is unreadable, too large or not a supported image.
 */
export function readImagePart({ path, name, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof path !== 'string' || path === '') {
    throw new Error('Не указан путь к изображению')
  }
  const displayName = typeof name === 'string' && name !== '' ? name : basename(path)
  const limit = maxBytesOption(maxBytes)
  let size
  try {
    const stats = statSync(path)
    if (!stats.isFile()) throw new Error('не обычный файл')
    size = stats.size
  } catch (error) {
    throw new Error(`Не удалось прочитать файл ${path}: ${error?.message || String(error)}`)
  }
  if (size > limit) {
    throw new Error(`Файл слишком большой: ${path} (${size} Б, лимит ${limit} Б)`)
  }
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    throw new Error(`Не удалось прочитать файл ${path}: ${error?.message || String(error)}`)
  }
  // The file may have grown between statSync and readFileSync.
  if (buffer.length > limit) {
    throw new Error(`Файл слишком большой: ${path} (${buffer.length} Б, лимит ${limit} Б)`)
  }
  const mediaType = detectImageMediaType(buffer, path)
  if (!mediaType) {
    throw new Error(`Файл не является изображением: ${path}`)
  }
  return { type: 'image', mediaType, data: buffer.toString('base64'), name: displayName }
}

/**
 * Read several images without failing the whole batch. Entries may be paths or
 * `{path, name}` objects (e.g. `saved` items of the incoming handler).
 * @param {Array<string|{path: string, name?: string}>} paths
 * @param {object} [options]
 * @param {number} [options.maxBytes=8388608] - per-file size limit.
 * @param {number} [options.maxParts=4] - only the first N entries are read.
 * @returns {{parts: Array<{type: 'image', mediaType: string, data: string, name: string}>,
 *   errors: Array<{path: string|undefined, error: Error}>}}
 */
export function readImageParts(paths, { maxBytes, maxParts = DEFAULT_MAX_PARTS } = {}) {
  const list = Array.isArray(paths) ? paths : []
  const limit = Number.isFinite(Number(maxParts)) && Number(maxParts) >= 0
    ? Math.floor(Number(maxParts))
    : DEFAULT_MAX_PARTS
  const parts = []
  const errors = []
  for (const item of list.slice(0, limit)) {
    const itemPath = typeof item === 'string' ? item : item?.path
    try {
      parts.push(
        readImagePart({
          path: itemPath,
          name: typeof item === 'string' ? undefined : item?.name,
          maxBytes,
        }),
      )
    } catch (error) {
      errors.push({ path: itemPath, error })
    }
  }
  return { parts, errors }
}

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_PARTS }
