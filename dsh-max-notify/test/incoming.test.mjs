import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncoming, formatBytes, safeFileName } from '../lib/incoming.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-incoming-'))
const silent = { info() {}, warn() {}, debug() {} }

function config(overrides = {}) {
  return {
    receiveFiles: true,
    inboxDir: undefined,
    maxIncomingFiles: 4,
    maxIncomingBytes: 1024 * 1024,
    ...overrides,
  }
}

function fakeClient() {
  const downloads = []
  return {
    downloads,
    async downloadToFile(url, dest, { maxBytes } = {}) {
      const bytes = Buffer.from(`content:${url}`)
      if (bytes.length > (maxBytes ?? Infinity)) throw new Error('too big')
      writeFileSync(dest, bytes)
      downloads.push({ url, dest })
      return { path: dest, bytes: bytes.length, contentType: 'image/png' }
    },
  }
}

function makeIncoming(overrides = {}) {
  const client = fakeClient()
  const incoming = createIncoming({
    client,
    config: config(overrides.config),
    logger: silent,
    resolveCwd: async () => workspace,
  })
  return { client, incoming }
}

const fileAttachment = (overrides = {}) => ({
  type: 'file',
  filename: 'report.pdf',
  size: 42,
  payload: { url: 'https://iu.oneme.ru/uploadFile', token: 'tok' },
  ...overrides,
})

const imageAttachment = (overrides = {}) => ({
  type: 'image',
  payload: { photo_id: 7, url: 'https://iu.oneme.ru/uploadImage', token: 'img' },
  ...overrides,
})

test('safeFileName strips paths and keeps a safe extension', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd.bin')
  assert.equal(safeFileName('photo'), 'photo.bin')
  assert.equal(safeFileName('image-1', '.jpg'), 'image-1.jpg')
  const cyrillic = safeFileName('Мой отчёт.pdf')
  assert.ok(cyrillic.endsWith('.pdf'))
  assert.ok(!cyrillic.includes('/') && !cyrillic.includes('..'))
})

test('saves incoming file and image into the workspace inbox', async () => {
  const { client, incoming } = makeIncoming()
  const result = await incoming.save([fileAttachment(), imageAttachment()], 'session-1')

  assert.equal(result.saved.length, 2)
  assert.equal(client.downloads.length, 2)
  assert.ok(result.dir.startsWith(workspace))
  assert.ok(result.saved[0].path.includes('report.pdf'))
  assert.ok(result.saved[1].path.endsWith('.png'))
  assert.equal(readFileSync(result.saved[0].path, 'utf8'), 'content:https://iu.oneme.ru/uploadFile')
  assert.match(result.promptText, /Пользователь прислал файлы из MAX/)
  assert.match(result.promptText, /report\.pdf/)
})

test('oversized attachments are rejected before download', async () => {
  const { client, incoming } = makeIncoming({ config: { maxIncomingBytes: 1024 } })
  const result = await incoming.save([fileAttachment({ size: 5000 })], 'session-1')
  assert.equal(client.downloads.length, 0)
  assert.equal(result.saved.length, 0)
  assert.match(result.errors[0], /больше лимита/)
})

test('attachment count is capped by maxIncomingFiles', async () => {
  const { client, incoming } = makeIncoming({ config: { maxIncomingFiles: 1 } })
  const result = await incoming.save([fileAttachment(), fileAttachment({ filename: 'b.pdf' })], 'session-1')
  assert.equal(client.downloads.length, 1)
  assert.equal(result.saved.length, 1)
})

test('download failures are reported without throwing', async () => {
  const client = { async downloadToFile() { throw new Error('network down') } }
  const incoming = createIncoming({
    client,
    config: config(),
    logger: silent,
    resolveCwd: async () => workspace,
  })
  const result = await incoming.save([fileAttachment()], 'session-1')
  assert.equal(result.saved.length, 0)
  assert.match(result.errors[0], /network down/)
})

test('inboxDir supports %cwd% and relative paths', async () => {
  const { incoming } = makeIncoming({ config: { inboxDir: '%cwd%/custom-inbox' } })
  const result = await incoming.save([fileAttachment()], 'session-1')
  assert.ok(result.dir.includes('custom-inbox'))
})

test('formatBytes formats sizes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})
