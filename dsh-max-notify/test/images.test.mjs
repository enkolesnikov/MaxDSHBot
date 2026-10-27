import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectMessageImages,
  extractImageReferences,
  stripCode,
} from '../lib/images.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-images-'))
const png = join(workspace, 'plot.png')
const jpg = join(workspace, 'photo.jpg')
const txt = join(workspace, 'notes.txt')
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
writeFileSync(jpg, Buffer.from('ffd8ffe0', 'hex'))
writeFileSync(txt, 'not an image')

test('stripCode removes fenced and inline code', () => {
  assert.equal(stripCode('a\n```\n![x](y.png)\n```\nb `![z](q.png)` c').includes('y.png'), false)
  assert.equal(stripCode('keep ![alt](real.png)').includes('real.png'), true)
})

test('markdown images and bare local paths resolve against the session cwd', () => {
  const refs = extractImageReferences(`Готово: ![график](plot.png) и ещё ${jpg}`, workspace)
  assert.deepEqual(refs.files.sort(), [png, jpg].sort())
  assert.deepEqual(refs.urls, [])
})

test('absolute paths and remote URLs are recognized', () => {
  const refs = extractImageReferences(`см. ![x](${png}) и https://example.com/chart.png`, workspace)
  assert.deepEqual(refs.files, [png])
  assert.deepEqual(refs.urls, ['https://example.com/chart.png'])
})

test('code samples never become attachments', () => {
  const refs = extractImageReferences('```\n![x](plot.png)\n```', workspace)
  assert.deepEqual(refs.files, [])
})

test('missing files and non-image extensions are ignored', () => {
  const refs = extractImageReferences('![x](missing.png) и notes.txt и photo.jpg', workspace)
  assert.deepEqual(refs.files, [jpg])
})

test('collectMessageImages returns image block attachment refs only', () => {
  const refs = collectMessageImages({
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      { type: 'image' },
    ],
  })
  assert.equal(refs.length, 1)
  assert.equal(refs[0].attachmentId, 'a1')
})
