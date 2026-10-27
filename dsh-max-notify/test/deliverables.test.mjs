import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function makeDeliverables() {
  const client = createFakeClient()
  const deliverables = createDeliverables({
    client,
    config: normalizeConfig({ botToken: 't', chatId: '123456789', deliverables: true }),
    logger: { warn() {}, debug() {} },
    target: { chatId: '123456789' },
  })
  return { client, deliverables }
}

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-deliverables-'))
const png = join(workspace, 'chart.png')
const zip = join(workspace, 'report.zip')
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
writeFileSync(zip, Buffer.from('PK\u0003\u0004', 'binary'))

test('images are uploaded and sent as image attachments', async () => {
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
  })
  await deliverables.send([{ path: png }])
  assert.equal(client.uploads.length, 0)
})
