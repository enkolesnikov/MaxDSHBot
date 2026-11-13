/**
 * Focused unit tests for lib/forwarding.mjs: image dedupe/limits, attachment
 * block reading, and the final inline keyboard. Network-free: the MAX client is
 * a fake; images referenced by text are real (tiny) files in a temp cwd.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createForwarding } from '../lib/forwarding.mjs'

const STOP = '⏹ Стоп'
const CONT = '▶️ Продолжить'

const tempDirs = []
test.after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeLogger() {
  const logs = []
  const push = (level) => (...args) => logs.push([level, ...args])
  return { logs, warn: push('warn'), debug: push('debug'), info: push('info'), error: push('error') }
}

function makeClient({ failPaths } = {}) {
  const uploads = []
  let counter = 0
  return {
    uploads,
    async uploadMedia(params) {
      uploads.push(params)
      if (params?.filePath && failPaths?.has(params.filePath)) throw new Error('upload boom')
      counter += 1
      return { token: `tok-${counter}` }
    },
  }
}

function makeConfig(overrides = {}) {
  return { forwardImages: true, maxImages: 4, buttons: true, buttonsPresets: [], webUrl: undefined, ...overrides }
}

function makeSession(cwd, id = 's1') {
  return { id, header: { cwd } }
}

function makeImages(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fwd-'))
  tempDirs.push(dir)
  for (const [name, content = 'png'] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

function makeForwarding({ client, config, logger, getService, state } = {}) {
  return createForwarding({
    client: client ?? makeClient(),
    config: config ?? makeConfig(),
    logger: logger ?? makeLogger(),
    getService,
    state,
  })
}

// ── collectFinalImages: disabled switches ────────────────────────────────────

test('collectFinalImages is off when forwardImages is false or maxImages <= 0', async () => {
  const client = makeClient()
  const dir = makeImages({ 'a.png': 'png' })
  const session = makeSession(dir)
  const text = '![a](a.png)'

  for (const config of [makeConfig({ forwardImages: false }), makeConfig({ maxImages: 0 }), makeConfig({ maxImages: -1 })]) {
    const { collectFinalImages } = makeForwarding({ client, config })
    assert.deepEqual(await collectFinalImages(session, text, undefined), [])
  }
  assert.equal(client.uploads.length, 0)
})

// ── collectFinalImages: local files, URLs, limits, dedupe ────────────────────

test('collectFinalImages uploads a markdown-referenced local image and passes URLs through', async () => {
  const client = makeClient()
  const dir = makeImages({ 'shot.png': 'png' })
  const session = makeSession(dir)
  const text = 'Done.\n\n![shot](shot.png)\n\nSee https://example.com/pic.webp for more.'

  const { collectFinalImages } = makeForwarding({ client })
  const attachments = await collectFinalImages(session, text, undefined)

  assert.deepEqual(attachments, [
    { type: 'image', payload: { token: 'tok-1' } },
    { type: 'image', payload: { url: 'https://example.com/pic.webp' } },
  ])
  assert.deepEqual(client.uploads, [{ filePath: join(dir, 'shot.png'), type: 'image' }])
})

test('collectFinalImages skips nonexistent local images and never throws on empty input', async () => {
  const client = makeClient()
  const dir = makeImages({ 'real.png': 'png' })
  const session = makeSession(dir)
  const { collectFinalImages } = makeForwarding({ client })

  assert.deepEqual(await collectFinalImages(session, '![gone](gone.png)', undefined), [])
  assert.equal(client.uploads.length, 0)
  assert.deepEqual(await collectFinalImages(session, '', undefined), [])
  assert.deepEqual(await collectFinalImages(session, 'plain text', null, 'not-an-array'), [])
})

test('noteSentImages suppresses files already delivered by the deliverables pipeline', async () => {
  const client = makeClient()
  const dir = makeImages({ 'a.png': 'png', 'b.png': 'png' })
  const session = makeSession(dir)
  const text = '![a](a.png) ![b](b.png)'
  const { noteSentImages, collectFinalImages } = makeForwarding({ client })

  noteSentImages('s1', [join(dir, 'a.png')])
  noteSentImages('s1', []) // no-op
  noteSentImages('s1', undefined) // no-op
  const attachments = await collectFinalImages(session, text, undefined)

  assert.deepEqual(client.uploads, [{ filePath: join(dir, 'b.png'), type: 'image' }])
  assert.deepEqual(attachments, [{ type: 'image', payload: { token: 'tok-1' } }])
})

test('collectFinalImages dedupes successfully uploaded files across calls but repeats URLs', async () => {
  const client = makeClient()
  const dir = makeImages({ 'a.png': 'png' })
  const session = makeSession(dir)
  const text = '![a](a.png) https://example.com/i.png'
  const { collectFinalImages } = makeForwarding({ client })

  assert.equal((await collectFinalImages(session, text, undefined)).length, 2)
  assert.equal(client.uploads.length, 1)

  const second = await collectFinalImages(session, text, undefined)
  assert.deepEqual(second, [{ type: 'image', payload: { url: 'https://example.com/i.png' } }])
  assert.equal(client.uploads.length, 1)
})

test('collectFinalImages dedupe is per session and per factory instance', async () => {
  const dir = makeImages({ 'a.png': 'png' })
  const text = '![a](a.png)'

  const client = makeClient()
  const first = makeForwarding({ client })
  assert.equal((await first.collectFinalImages(makeSession(dir, 's1'), text, undefined)).length, 1)
  assert.equal((await first.collectFinalImages(makeSession(dir, 's1'), text, undefined)).length, 0)

  // Another session starts with a clean slate.
  assert.equal((await first.collectFinalImages(makeSession(dir, 's2'), text, undefined)).length, 1)
  assert.equal(client.uploads.length, 2)

  // A new factory (new plugin instance) has its own map.
  const second = makeForwarding({ client })
  assert.equal((await second.collectFinalImages(makeSession(dir, 's1'), text, undefined)).length, 1)
  assert.equal(client.uploads.length, 3)
})

test('collectFinalImages caps attachments at maxImages, files before URLs', async () => {
  const client = makeClient()
  const dir = makeImages({ 'a.png': 'png', 'b.png': 'png' })
  const session = makeSession(dir)
  const text = '![a](a.png) ![b](b.png) https://example.com/x.png https://example.com/y.png'
  const { collectFinalImages } = makeForwarding({ client, config: makeConfig({ maxImages: 3 }) })

  const attachments = await collectFinalImages(session, text, undefined)
  assert.deepEqual(attachments, [
    { type: 'image', payload: { token: 'tok-1' } },
    { type: 'image', payload: { token: 'tok-2' } },
    { type: 'image', payload: { url: 'https://example.com/x.png' } },
  ])
  assert.equal(client.uploads.length, 2)
})

test('collectFinalImages logs and does not remember a failed file upload', async () => {
  const dir = makeImages({ 'a.png': 'png' })
  const file = join(dir, 'a.png')
  const failPaths = new Set([file])
  const client = makeClient({ failPaths })
  const logger = makeLogger()
  const { collectFinalImages } = makeForwarding({ client, logger })
  const session = makeSession(dir)
  const text = '![a](a.png)'

  assert.deepEqual(await collectFinalImages(session, text, undefined), [])
  assert.equal(logger.logs.filter(([level]) => level === 'warn').length, 1)

  failPaths.clear()
  const retried = await collectFinalImages(session, text, undefined)
  assert.deepEqual(retried, [{ type: 'image', payload: { token: 'tok-1' } }])
  assert.equal(client.uploads.length, 2)
})

// ── collectFinalImages: attachment blocks via the attachments service ────────

test('collectFinalImages reads, dedupes and uploads image blocks (message + tool refs)', async () => {
  const client = makeClient()
  const seenRefs = []
  const getService = (name) => {
    assert.equal(name, 'attachments')
    return {
      async readImage(ref) {
        seenRefs.push(ref)
        return ref.attachmentId === 'a3' ? undefined : { data: Buffer.from('bytes') }
      },
    }
  }
  const message = {
    content: [
      { type: 'image', attachment: { attachmentId: 'a1', name: 'one.png' } },
      { type: 'image', attachment: { attachmentId: 'a1' } }, // duplicate id
      { type: 'image', attachment: { attachmentId: 'a2' } },
      { type: 'text', text: 'ignored' },
    ],
  }
  const toolImageRefs = [{ attachmentId: 'a2' }, { attachmentId: 'a3' }]
  const { collectFinalImages } = makeForwarding({ client, getService })

  const attachments = await collectFinalImages(makeSession('/tmp'), '', message, toolImageRefs)

  assert.deepEqual(seenRefs.map((ref) => ref.attachmentId), ['a1', 'a2', 'a3'])
  assert.deepEqual(client.uploads, [
    { buffer: Buffer.from('bytes'), filename: 'one.png', type: 'image' },
    { buffer: Buffer.from('bytes'), filename: 'image.png', type: 'image' },
  ])
  assert.deepEqual(attachments, [
    { type: 'image', payload: { token: 'tok-1' } },
    { type: 'image', payload: { token: 'tok-2' } },
  ])
})

test('collectFinalImages is safe without an attachments service or when a block upload fails', async () => {
  const logger = makeLogger()
  const client = {
    uploads: [],
    async uploadMedia() {
      this.uploads.push(1)
      throw new Error('nope')
    },
  }
  const message = { content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }
  const { collectFinalImages } = makeForwarding({
    client,
    logger,
    getService: () => ({ readImage: async () => ({ data: Buffer.from('x') }) }),
  })

  assert.deepEqual(await collectFinalImages(makeSession('/tmp'), '', message), [])
  assert.equal(client.uploads.length, 1)
  assert.equal(logger.logs.filter(([level]) => level === 'warn').length, 1)

  // No attachments service: blocks are skipped, nothing throws.
  const noService = makeForwarding({ client: makeClient(), state: {} })
  assert.deepEqual(await noService.collectFinalImages(makeSession('/tmp'), '', message), [])
})

test('collectFinalImages respects maxImages when only attachment blocks are present', async () => {
  let reads = 0
  const getService = () => ({
    async readImage() {
      reads += 1
      return { data: Buffer.from('x') }
    },
  })
  const message = {
    content: [1, 2, 3].map((n) => ({ type: 'image', attachment: { attachmentId: `a${n}`, name: `i${n}.png` } })),
  }
  const client = makeClient()
  const { collectFinalImages } = makeForwarding({ client, getService, config: makeConfig({ maxImages: 2 }) })

  const attachments = await collectFinalImages(makeSession('/tmp'), '', message)
  assert.equal(attachments.length, 2)
  assert.equal(reads, 2)
  assert.equal(client.uploads.length, 2)
})

// ── finalKeyboard ────────────────────────────────────────────────────────────

test('finalKeyboard returns undefined when buttons are off or the session id is missing', () => {
  const session = { id: 's1', header: {} }
  assert.equal(makeForwarding({ config: makeConfig({ buttons: false }) }).finalKeyboard(session), undefined)
  assert.equal(makeForwarding().finalKeyboard({ header: {} }), undefined)
  assert.equal(makeForwarding().finalKeyboard({ id: '', header: {} }), undefined)
  assert.equal(makeForwarding().finalKeyboard(undefined), undefined)
})

test('finalKeyboard builds continue/stop row and parses callback payloads', () => {
  const keyboard = makeForwarding().finalKeyboard({ id: 's1', header: {} })

  assert.equal(keyboard.length, 1)
  assert.equal(keyboard[0].type, 'inline_keyboard')
  const rows = keyboard[0].payload.buttons
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].map((button) => button.text), [CONT, STOP])
  assert.deepEqual(rows[0].map((button) => JSON.parse(button.payload)), [
    { t: 'qa', a: 'cont', s: 's1' },
    { t: 'qa', a: 'stop', s: 's1' },
  ])
})

test('finalKeyboard adds preset rows two per row, capped at four presets', () => {
  const presets = ['A', 'B', 'C', 'D', 'E', 'F'].map((label) => ({ label }))
  const keyboard = makeForwarding({ config: makeConfig({ buttonsPresets: presets }) }).finalKeyboard({ id: 's1' })
  const rows = keyboard[0].payload.buttons

  assert.equal(rows.length, 3)
  assert.deepEqual(rows[1].map((button) => button.text), ['A', 'B'])
  assert.deepEqual(rows[2].map((button) => button.text), ['C', 'D'])
  assert.deepEqual(rows[1].map((button) => JSON.parse(button.payload)), [
    { t: 'qa', a: 'preset', s: 's1', i: 0 },
    { t: 'qa', a: 'preset', s: 's1', i: 1 },
  ])
  assert.deepEqual(rows[2].map((button) => JSON.parse(button.payload)), [
    { t: 'qa', a: 'preset', s: 's1', i: 2 },
    { t: 'qa', a: 'preset', s: 's1', i: 3 },
  ])
})

test('finalKeyboard keeps an odd trailing preset on its own row', () => {
  const presets = ['A', 'B', 'C'].map((label) => ({ label }))
  const rows = makeForwarding({ config: makeConfig({ buttonsPresets: presets }) }).finalKeyboard({ id: 's1' })[0].payload
    .buttons

  assert.equal(rows.length, 3)
  assert.deepEqual(rows[2].map((button) => button.text), ['C'])
  assert.deepEqual(JSON.parse(rows[2][0].payload), { t: 'qa', a: 'preset', s: 's1', i: 2 })
})

test('finalKeyboard appends a GUI link row when webUrl is set and ignores non-array presets', () => {
  const config = makeConfig({ buttonsPresets: 'nope', webUrl: 'https://example.com/d/' })
  const rows = makeForwarding({ config }).finalKeyboard({ id: 's1' })[0].payload.buttons

  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].map((button) => button.text), [CONT, STOP])
  assert.deepEqual(rows[1], [{ type: 'link', text: '🖥 Открыть GUI', url: 'https://example.com/d/' }])
})
