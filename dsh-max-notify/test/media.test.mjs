import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DEFAULT_MAX_BYTES,
  detectImageMediaType,
  imageMediaTypeFor,
  readImagePart,
  readImageParts,
} from '../lib/media.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-media-'))
after(() => rmSync(workspace, { recursive: true, force: true }))

const pngBytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(32)])
const jpegBytes = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), randomBytes(32)])
const webpBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), randomBytes(32)])
const gif89aBytes = Buffer.concat([Buffer.from('GIF89a'), randomBytes(32)])
const gif87aBytes = Buffer.concat([Buffer.from('GIF87a'), randomBytes(32)])

function fixture(name, bytes) {
  const file = join(workspace, name)
  writeFileSync(file, bytes)
  return file
}

const png = fixture('plot.png', pngBytes)
const jpeg = fixture('photo.jpeg', jpegBytes)
const webp = fixture('anim.webp', webpBytes)
const gif = fixture('anim.gif', gif89aBytes)
const gif87 = fixture('old.gif', gif87aBytes)
const pngMagicTxt = fixture('screenshot.txt', pngBytes)
const pngNoMagic = fixture('empty.png', randomBytes(64))
const notes = fixture('notes.txt', Buffer.from('not an image at all'))
const bigPng = fixture('big.png', Buffer.concat([pngBytes, Buffer.alloc(2048, 7)]))
const exactPng = fixture('exact.png', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1016)]))
const missing = join(workspace, 'missing.png')

test('imageMediaTypeFor maps known extensions case-insensitively', () => {
  assert.equal(imageMediaTypeFor('a.png'), 'image/png')
  assert.equal(imageMediaTypeFor('/tmp/a.JPG'), 'image/jpeg')
  assert.equal(imageMediaTypeFor('a.JpEg'), 'image/jpeg')
  assert.equal(imageMediaTypeFor('a.WEBP'), 'image/webp')
  assert.equal(imageMediaTypeFor('a.GiF'), 'image/gif')
  assert.equal(imageMediaTypeFor('a.txt'), undefined)
  assert.equal(imageMediaTypeFor('a'), undefined)
  assert.equal(imageMediaTypeFor(undefined), undefined)
})

test('detectImageMediaType recognizes signatures', () => {
  assert.equal(detectImageMediaType(pngBytes), 'image/png')
  assert.equal(detectImageMediaType(jpegBytes), 'image/jpeg')
  assert.equal(detectImageMediaType(webpBytes), 'image/webp')
  assert.equal(detectImageMediaType(gif89aBytes), 'image/gif')
  assert.equal(detectImageMediaType(gif87aBytes), 'image/gif')
  assert.equal(detectImageMediaType(new Uint8Array(pngBytes)), 'image/png')
})

test('detectImageMediaType ignores the extension when a signature is present', () => {
  assert.equal(detectImageMediaType(pngBytes, 'screenshot.txt'), 'image/png')
  assert.equal(detectImageMediaType(pngBytes, 'no-extension'), 'image/png')
  assert.equal(detectImageMediaType(pngNoMagic, 'empty.png'), undefined)
})

test('detectImageMediaType falls back to the extension and rejects unknown data', () => {
  assert.equal(detectImageMediaType(Buffer.alloc(0), 'empty.png'), 'image/png')
  assert.equal(detectImageMediaType(Buffer.from('garbage'), 'x.JPEG'), 'image/jpeg')
  assert.equal(detectImageMediaType(Buffer.from('garbage'), 'x.txt'), undefined)
  assert.equal(detectImageMediaType(Buffer.from('garbage')), undefined)
  assert.equal(detectImageMediaType('not a buffer', 'x.png'), undefined)
})

test('readImagePart returns a native image part with base64 data', () => {
  assert.equal(DEFAULT_MAX_BYTES, 8 * 1024 * 1024)
  assert.deepEqual(readImagePart({ path: png }), {
    type: 'image',
    mediaType: 'image/png',
    data: pngBytes.toString('base64'),
    name: 'plot.png',
  })
  assert.deepEqual(readImagePart({ path: jpeg }).mediaType, 'image/jpeg')
  assert.deepEqual(readImagePart({ path: webp }).mediaType, 'image/webp')
  assert.deepEqual(readImagePart({ path: gif }).mediaType, 'image/gif')
})

test('readImagePart keeps an explicit name and derives the media type from magic bytes', () => {
  const part = readImagePart({ path: pngMagicTxt, name: 'screenshot.png' })
  assert.equal(part.name, 'screenshot.png')
  assert.equal(part.mediaType, 'image/png')
  assert.equal(part.data, pngBytes.toString('base64'))
  const fallback = readImagePart({ path: pngNoMagic })
  assert.equal(fallback.mediaType, 'image/png')
  assert.equal(fallback.name, basename(pngNoMagic))
})

test('readImagePart rejects a file that is not an image', () => {
  assert.throws(() => readImagePart({ path: notes }), /не является изображением/)
})

test('readImagePart enforces maxBytes but allows an exact fit', () => {
  assert.equal(readImagePart({ path: exactPng, maxBytes: 1024 }).mediaType, 'image/png')
  assert.throws(() => readImagePart({ path: bigPng, maxBytes: 1024 }), /слишком большой/)
  assert.throws(() => readImagePart({ path: png, maxBytes: 4 }), /слишком большой/)
})

test('readImagePart reports unreadable and missing files', () => {
  assert.throws(() => readImagePart({ path: missing }), /Не удалось прочитать файл/)
  assert.throws(() => readImagePart({ path: workspace }), /Не удалось прочитать файл/)
  assert.throws(() => readImagePart({}), /Не указан путь/)
})

test('readImageParts reads every image up to maxParts', () => {
  const { parts, errors } = readImageParts([png, jpeg, webp, gif])
  assert.deepEqual(errors, [])
  assert.deepEqual(
    parts.map((part) => part.mediaType),
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  )
  assert.deepEqual(
    parts.map((part) => part.data),
    [pngBytes, jpegBytes, webpBytes, gif89aBytes].map((bytes) => bytes.toString('base64')),
  )
})

test('readImageParts honors maxParts and the default of four', () => {
  assert.equal(readImageParts([png, jpeg, webp, gif, gif87], { maxParts: 2 }).parts.length, 2)
  assert.equal(readImageParts([png, jpeg, webp, gif, gif87]).parts.length, 4)
  assert.deepEqual(readImageParts([png], { maxParts: 0 }), { parts: [], errors: [] })
})

test('readImageParts collects per-file errors and keeps the valid parts', () => {
  const { parts, errors } = readImageParts([png, notes, missing])
  assert.equal(parts.length, 1)
  assert.equal(parts[0].name, 'plot.png')
  assert.deepEqual(errors.map((entry) => entry.path), [notes, missing])
  assert.equal(errors[0].error instanceof Error, true)
  assert.match(errors[0].error.message, /не является изображением/)
  assert.match(errors[1].error.message, /Не удалось прочитать файл/)
})

test('readImageParts accepts {path, name} entries and tolerates bad input', () => {
  const { parts } = readImageParts([{ path: png, name: 'подпись.png' }])
  assert.equal(parts[0].name, 'подпись.png')
  assert.deepEqual(readImageParts(undefined), { parts: [], errors: [] })
  assert.deepEqual(readImageParts('plot.png'), { parts: [], errors: [] })
})
