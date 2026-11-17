import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, truncateSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { normalizeConfig } from '../index.js'
import { createDeliverables } from '../lib/deliverables.mjs'

function createFakeClient() {
  const sends = []
  const uploads = []
  return {
    sends,
    uploads,
    uploadTypeFor(filePath) {
      return String(filePath).endsWith('.png') ? 'image' : 'file'
    },
    async uploadMedia({ filePath, type }) {
      uploads.push({ filePath, type })
      return { token: `token-${type}`, type }
    },
    async sendWithAttachments(params) {
      sends.push(params)
      return { message: { body: { mid: `mid-${sends.length}` } } }
    },
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-deliverables-'))
const outside = mkdtempSync(join(tmpdir(), 'dsh-max-outside-'))
const png = join(workspace, 'chart.png')
const zip = join(workspace, 'report.zip')
const outsidePng = join(outside, 'outside.png')
const outsideLink = join(workspace, 'linked.png')
const parentRelativePng = join('..', basename(outside), basename(outsidePng))
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
writeFileSync(zip, Buffer.from('PK\u0003\u0004', 'binary'))
writeFileSync(outsidePng, Buffer.from('89504e470d0a1a0a', 'hex'))
symlinkSync(outsidePng, outsideLink)

function makeDeliverables(extra = {}) {
  const client = createFakeClient()
  const warns = []
  const deliverables = createDeliverables({
    client,
    config: normalizeConfig({ botToken: 't', chatId: '123456789', deliverables: true }),
    logger: { warn: (...args) => warns.push(args.join(' ')), debug() {} },
    target: { chatId: '123456789' },
    cwd: workspace,
    ...extra,
  })
  return { client, deliverables, warns }
}

test('images inside cwd are uploaded and sent as image attachments', async () => {
  const { client, deliverables } = makeDeliverables()
  await deliverables.send([{ path: png, description: 'график' }])
  assert.deepEqual(client.uploads, [{ filePath: png, type: 'image' }])
  assert.equal(client.sends.length, 1)
  assert.deepEqual(client.sends[0].attachments, [{ type: 'image', payload: { token: 'token-image' } }])
  assert.match(client.sends[0].text, /Файлы от агента/)
})

test('documents are sent one message per file', async () => {
  const { client, deliverables } = makeDeliverables()
  await deliverables.send([{ path: zip, description: 'архив отчёта' }])
  assert.equal(client.sends.length, 1)
  assert.deepEqual(client.sends[0].attachments, [{ type: 'file', payload: { token: 'token-file' } }])
  assert.match(client.sends[0].text, /архив отчёта/)
})

test('deliverables target a user dialog when only userId is configured', async () => {
  const { client, deliverables } = makeDeliverables({ target: { userId: '777' } })
  await deliverables.send([{ path: png }])
  assert.equal(client.sends.length, 1)
  assert.equal(client.sends[0].userId, '777')
  assert.equal(client.sends[0].chatId, undefined)
})

test('missing files are skipped without throwing', async () => {
  const { client, deliverables } = makeDeliverables()
  await deliverables.send([{ path: join(workspace, 'nope.txt') }])
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sends.length, 0)
})

test('deliverables disabled means no uploads', async () => {
  const client = createFakeClient()
  const deliverables = createDeliverables({
    client,
    config: normalizeConfig({ botToken: 't', chatId: '1', deliverables: false }),
    logger: { warn() {}, debug() {} },
    target: { chatId: '123456789' },
    cwd: workspace,
  })
  await deliverables.send([{ path: png }])
  assert.equal(client.uploads.length, 0)
})

test('paths outside cwd via .. are rejected with a warn and no upload', async () => {
  const { client, deliverables, warns } = makeDeliverables()
  await deliverables.send([{ path: parentRelativePng }])
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sends.length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skip deliverable/)
})

test('symlinks pointing outside cwd are rejected with a warn and no upload', async () => {
  const { client, deliverables, warns } = makeDeliverables()
  await deliverables.send([{ path: outsideLink }])
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sends.length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skip deliverable/)
})

test('allowOutside explicitly authorizes a path outside cwd', async () => {
  const { client, deliverables, warns } = makeDeliverables({ allowOutside: true })
  await deliverables.send([{ path: outsidePng }])
  assert.deepEqual(client.uploads, [{ filePath: realpathSync(outsidePng), type: 'image' }])
  assert.equal(client.sends.length, 1)
  assert.equal(warns.length, 0)
})

test('a rejected path never reaches uploadMedia', async () => {
  let resolveCalls = 0
  let uploadCalls = 0
  const client = createFakeClient()
  client.uploadMedia = async () => {
    uploadCalls += 1
    return { token: 'unexpected', type: 'file' }
  }
  const deliverables = createDeliverables({
    client,
    config: normalizeConfig({ botToken: 't', chatId: '123456789', deliverables: true }),
    logger: { warn() {}, debug() {} },
    target: { chatId: '123456789' },
    cwd: workspace,
    resolvePath: () => {
      resolveCalls += 1
      return { ok: false, error: 'blocked by test resolver' }
    },
  })
  await deliverables.send([{ path: png }])
  assert.equal(resolveCalls, 1)
  assert.equal(uploadCalls, 0)
})

test('cwd passed to send() overrides the factory cwd for that session', async () => {
  const { client, deliverables } = makeDeliverables({ cwd: outside })
  await deliverables.send([{ path: png }], { cwd: workspace })
  assert.deepEqual(client.uploads, [{ filePath: png, type: 'image' }])
  assert.equal(client.sends.length, 1)
})

test('cwd passed to send() still enforces the boundary', async () => {
  const { client, deliverables, warns } = makeDeliverables()
  await deliverables.send([{ path: png }], { cwd: outside })
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sends.length, 0)
  assert.equal(warns.length, 1)
})

test('missing cwd fails closed without uploading', async () => {
  const { client, deliverables, warns } = makeDeliverables({ cwd: undefined })
  await deliverables.send([{ path: png }])
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sends.length, 0)
  assert.equal(warns.length, 1)
})

test('oversized files are skipped with the corrected 50 MB warning', async () => {
  const large = join(workspace, 'oversized.bin')
  writeFileSync(large, '')
  truncateSync(large, 50 * 1024 * 1024 + 1)
  const { client, deliverables, warns } = makeDeliverables()
  await deliverables.send([{ path: large }])
  assert.equal(client.uploads.length, 0)
  assert.equal(client.sends.length, 0)
  assert.ok(warns.some((warning) => /over 50 MB/.test(warning)), warns.join('\n'))
})
