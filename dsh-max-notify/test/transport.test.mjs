import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaxClient, isTrustedMaxUrl, splitText, MAX_TEXT_LIMIT } from '../lib/transport.mjs'
import { loadTlsCredentials, readBody, sendJson, startHttpsServer } from './helpers/tls-server.mjs'

const TOKEN = 'bot-secret-token'
const tls = await loadTlsCredentials()
const skipNoTls = tls ? false : 'openssl is not available for the local HTTPS test server'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-max-transport-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function startServer(t, handler) {
  const server = await startHttpsServer(handler, tls)
  t.after(() => server.close())
  return server
}

function testClient(server, overrides = {}) {
  return createMaxClient({ token: TOKEN, baseUrl: server.url, ca: tls.cert, minIntervalMs: 0, ...overrides })
}

// ---------------------------------------------------------------------------
// splitText
// ---------------------------------------------------------------------------

test('splitText keeps short text as one chunk', () => {
  assert.deepEqual(splitText('hello', 4000), ['hello'])
  assert.deepEqual(splitText('', 4000), [''])
})

test('splitText respects the limit and loses no characters', () => {
  const text = ('Съешь ещё этих мягких французских булок, да выпей чаю. '.repeat(400)).trim()
  const chunks = splitText(text, 1000)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 1000, `chunk of ${chunk.length} exceeds 1000`)
  assert.equal(chunks.join(''), text)
})

test('splitText prefers paragraph boundaries', () => {
  const text = `${'a'.repeat(900)}\n\n${'b'.repeat(900)}`
  const chunks = splitText(text, 1000)
  assert.equal(chunks[0], `${'a'.repeat(900)}\n\n`)
})

test('splitText never splits a surrogate pair', () => {
  const emoji = '😀'
  const text = `${'x'.repeat(999)}${emoji}${'y'.repeat(100)}`
  const chunks = splitText(text, 1000)
  for (const chunk of chunks) {
    const last = chunk.charCodeAt(chunk.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'chunk ends with a high surrogate')
    const first = chunk.charCodeAt(0)
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'chunk starts with a low surrogate')
  }
  assert.equal(chunks.join(''), text)
})

test('splitText enforces the MAX 4000-char limit by default', () => {
  const text = 'z'.repeat(MAX_TEXT_LIMIT * 2 + 5)
  const chunks = splitText(text)
  assert.equal(chunks.length, 3)
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_TEXT_LIMIT))
})

test('splitText validates input', () => {
  assert.throws(() => splitText(42), TypeError)
  assert.throws(() => splitText('x', 4), RangeError)
})

// ---------------------------------------------------------------------------
// uploadTypeFor
// ---------------------------------------------------------------------------

test('uploadTypeFor classifies images, audio and documents without ReferenceError', () => {
  const client = createMaxClient({ token: 'test-token' })
  assert.equal(client.uploadTypeFor('/tmp/shot.PNG'), 'image')
  assert.equal(client.uploadTypeFor('/tmp/voice.ogg'), 'audio')
  assert.equal(client.uploadTypeFor('/tmp/report.docx'), 'file')
  assert.equal(client.uploadTypeFor('/tmp/archive.zip'), 'file')
})

test('uploadTypeFor covers every documented image extension case-insensitively', () => {
  const client = createMaxClient({ token: 'test-token' })
  for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp', 'g.tiff', 'h.heic']) {
    assert.equal(client.uploadTypeFor(`/tmp/${name}`), 'image', name)
  }
  assert.equal(client.uploadTypeFor('/tmp/PHOTO.JPEG'), 'image')
  assert.equal(client.uploadTypeFor('/tmp/SCAN.TIFF'), 'image')
})

test('uploadTypeFor covers every documented audio extension case-insensitively', () => {
  const client = createMaxClient({ token: 'test-token' })
  for (const name of ['a.mp3', 'b.ogg', 'c.oga', 'd.opus', 'e.wav', 'f.m4a', 'g.flac', 'h.aac']) {
    assert.equal(client.uploadTypeFor(`/tmp/${name}`), 'audio', name)
  }
  assert.equal(client.uploadTypeFor('/tmp/VOICE.MP3'), 'audio')
  assert.equal(client.uploadTypeFor('/tmp/TRACK.OGG'), 'audio')
})

test('uploadTypeFor falls back to file for odd names, unknown and empty values', () => {
  const client = createMaxClient({ token: 'test-token' })
  for (const value of [
    '/tmp/README',
    '/tmp/archive.tar.gz',
    '/tmp/notes.txt',
    '/tmp/clip.png.bak',
    '/tmp/.png',
    '/tmp/file.',
    '',
    undefined,
    null,
  ]) {
    assert.equal(client.uploadTypeFor(value), 'file', String(value))
  }
})

// ---------------------------------------------------------------------------
// isTrustedMaxUrl
// ---------------------------------------------------------------------------

test('only MAX-owned HTTPS hosts are trusted for token-bearing requests', () => {
  assert.equal(isTrustedMaxUrl('https://platform-api2.max.ru/uploads/1'), true)
  assert.equal(isTrustedMaxUrl('https://cdn.max.ru/file.jpg'), true)
  assert.equal(isTrustedMaxUrl('https://evil.example/file.jpg'), false)
  assert.equal(isTrustedMaxUrl('http://platform-api2.max.ru/uploads/1'), false)
  assert.equal(isTrustedMaxUrl('not a url'), false)
})

test('isTrustedMaxUrl accepts the MAX host family and normalises case/ports', () => {
  assert.equal(isTrustedMaxUrl('https://max.ru/'), true)
  assert.equal(isTrustedMaxUrl('https://MAX.RU/'), true)
  assert.equal(isTrustedMaxUrl('https://sub.max.ru/file'), true)
  assert.equal(isTrustedMaxUrl('https://a.b.cdn.max.ru/file'), true)
  assert.equal(isTrustedMaxUrl('https://platform-api2.max.ru:443/me'), true)
  assert.equal(isTrustedMaxUrl('https://CDN.MAX.RU:8443/file'), true)
  assert.equal(isTrustedMaxUrl('https://platform-api2.max.ru/me?token=leak'), true)
})

test('isTrustedMaxUrl rejects look-alike and non-MAX hosts', () => {
  for (const value of [
    'https://evil.example/file',
    'https://max.ru.evil.example/file',
    'https://evilmax.ru/file',
    'https://notmax.ru/file',
    'https://max.ru./file',
    'https://user:pass@evil.example/file',
    'https://evil.example#https://max.ru/file',
    'https://example.com/https://max.ru/file',
  ]) {
    assert.equal(isTrustedMaxUrl(value), false, value)
  }
})

test('isTrustedMaxUrl requires HTTPS and a parseable URL', () => {
  for (const value of [
    'http://max.ru/',
    'http://cdn.max.ru/file',
    'ftp://max.ru/file',
    '//max.ru/file',
    'javascript:alert(1)',
    'https://',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isTrustedMaxUrl(value), false, String(value))
  }
})

test('isTrustedMaxUrl compares against an explicit baseUrl (local test server case)', () => {
  const baseUrl = 'https://127.0.0.1:9443'
  assert.equal(isTrustedMaxUrl('https://127.0.0.1:9443/upload', { baseUrl }), true)
  assert.equal(isTrustedMaxUrl('https://127.0.0.1:9444/upload', { baseUrl }), true) // host is what matters
  assert.equal(isTrustedMaxUrl('https://localhost:9443/upload', { baseUrl }), false)
  assert.equal(isTrustedMaxUrl('https://evil.example/upload', { baseUrl }), false)
  // MAX-owned hosts stay trusted even when a custom base is configured.
  assert.equal(isTrustedMaxUrl('https://cdn.max.ru/file', { baseUrl: 'https://evil.example' }), true)
  assert.equal(isTrustedMaxUrl('https://127.0.0.1:9443/upload', { baseUrl: 'not a url' }), false)
})

// ---------------------------------------------------------------------------
// createMaxClient argument validation (no network)
// ---------------------------------------------------------------------------

test('createMaxClient requires a non-empty token', () => {
  assert.throws(() => createMaxClient(), /MAX bot token is required/)
  assert.throws(() => createMaxClient({}), /MAX bot token is required/)
  assert.throws(() => createMaxClient({ token: '   ' }), /MAX bot token is required/)
})

test('client methods validate arguments before sending anything', async () => {
  const client = createMaxClient({ token: TOKEN })
  await assert.rejects(() => client.sendMessage({ chatId: 1 }), /text is required/)
  await assert.rejects(() => client.sendMessage({ chatId: 1, text: '' }), /text is required/)
  await assert.rejects(
    () => client.sendMessage({ chatId: 1, text: 'x'.repeat(MAX_TEXT_LIMIT + 1) }),
    (error) => error instanceof RangeError && /exceeds 4000 chars/.test(error.message),
  )
  await assert.rejects(() => client.sendMessage({ text: 'x' }), /chatId or userId is required/)
  assert.throws(() => client.editMessage({ text: 'x' }), /messageId is required/)
  assert.throws(() => client.deleteMessage(), /messageId is required/)
  assert.throws(() => client.answerCallback(), /callbackId is required/)
  assert.throws(() => client.sendAction(), /chatId is required/)
  assert.throws(() => client.setCommands('nope'), /commands must be an array/)
  assert.throws(() => client.subscribeWebhook({}), /url is required/)
  assert.throws(() => client.unsubscribeWebhook('  '), /url is required/)
  assert.throws(() => client.getChat(null), /chatId is required/)
  await assert.rejects(() => client.uploadMedia({}), /filePath or buffer is required/)
})

// ---------------------------------------------------------------------------
// Local HTTPS contract tests for the request/response layer
// ---------------------------------------------------------------------------

test('sendMessage posts JSON with the bot token, query target and body fields', { skip: skipNoTls }, async (t) => {
  const seen = []
  const server = await startServer(t, async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: (await readBody(req)).toString('utf8') })
    sendJson(res, 200, { message: { body: { mid: 'm1' } } })
  })
  const client = testClient(server)

  const result = await client.sendMessage({
    chatId: 42,
    text: 'hello',
    format: 'markdown',
    notify: false,
    disableLinkPreview: true,
    link: { type: 'reply', mid: 7 },
  })
  assert.deepEqual(result, { message: { body: { mid: 'm1' } } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].url, '/messages?chat_id=42&disable_link_preview=true')
  assert.equal(seen[0].headers.authorization, TOKEN)
  assert.equal(seen[0].headers.accept, 'application/json')
  assert.equal(seen[0].headers['content-type'], 'application/json')
  assert.equal(Number(seen[0].headers['content-length']), Buffer.byteLength(seen[0].body))
  assert.deepEqual(JSON.parse(seen[0].body), {
    text: 'hello',
    format: 'markdown',
    notify: false,
    link: { type: 'reply', mid: '7' },
  })

  await client.sendMessage({ userId: 'u1', text: 'dialog', link: { type: 'forward', mid: 'abc' } })
  assert.equal(seen[1].url, '/messages?user_id=u1')
  assert.deepEqual(JSON.parse(seen[1].body), { text: 'dialog', link: { type: 'forward', mid: 'abc' } })
})

test('sendMessage surfaces MAX HTTP errors with status, code and body', { skip: skipNoTls }, async (t) => {
  const replies = [
    () => [404, { code: 'not.found', message: 'chat not found' }],
    () => [400, { error: { code: 'bad.request', message: 'bad body' } }],
    () => null,
  ]
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    const reply = replies.shift()()
    if (reply) {
      sendJson(res, reply[0], reply[1])
      return
    }
    res.writeHead(502, { 'content-type': 'text/html' })
    res.end('<html>bad gateway</html>')
  })
  const client = testClient(server, { maxRetries: 0 })
  const send = () => client.sendMessage({ chatId: 1, text: 'hi' })

  await assert.rejects(send(), (error) => {
    assert.equal(error.name, 'MaxApiError')
    assert.equal(error.status, 404)
    assert.equal(error.code, 'not.found')
    assert.equal(error.message, 'MAX API 404 not.found: chat not found')
    assert.deepEqual(error.response, { code: 'not.found', message: 'chat not found' })
    return true
  })
  await assert.rejects(send(), (error) => {
    assert.equal(error.name, 'MaxApiError')
    assert.equal(error.status, 400)
    assert.equal(error.code, 'bad.request')
    assert.equal(error.message, 'MAX API 400 bad.request: bad body')
    return true
  })
  await assert.rejects(send(), (error) => {
    assert.equal(error.name, 'MaxApiError')
    assert.equal(error.status, 502)
    assert.equal(error.code, undefined)
    assert.equal(error.message, 'MAX API 502: <html>bad gateway</html>')
    assert.equal(error.response, '<html>bad gateway</html>')
    return true
  })
})

test('429 Retry-After seconds are parsed into retryAfterMs', { skip: skipNoTls }, async (t) => {
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    sendJson(res, 429, { code: 'rate.limit', message: 'slow down' }, { 'retry-after': '3' })
  })
  const client = testClient(server, { maxRetries: 0 })
  await assert.rejects(() => client.sendMessage({ chatId: 1, text: 'hi' }), (error) => {
    assert.equal(error.status, 429)
    assert.equal(error.code, 'rate.limit')
    assert.equal(error.retryAfterMs, 3000)
    return true
  })
})

test('429 Retry-After HTTP-date is parsed into retryAfterMs', { skip: skipNoTls }, async (t) => {
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    const when = new Date(Date.now() + 30_000).toUTCString()
    sendJson(res, 429, { code: 'rate.limit', message: 'slow down' }, { 'retry-after': when })
  })
  const client = testClient(server, { maxRetries: 0 })
  await assert.rejects(() => client.sendMessage({ chatId: 1, text: 'hi' }), (error) => {
    assert.equal(error.status, 429)
    assert.ok(Number.isFinite(error.retryAfterMs), 'retryAfterMs should be a number')
    assert.ok(error.retryAfterMs > 20_000 && error.retryAfterMs <= 30_000, `retryAfterMs=${error.retryAfterMs}`)
    return true
  })
})

test('429 without Retry-After is retried with capped exponential backoff', { skip: skipNoTls }, async (t) => {
  let attempts = 0
  const logs = []
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    attempts += 1
    if (attempts === 1) {
      sendJson(res, 429, { code: 'rate.limit', message: 'slow down' })
      return
    }
    sendJson(res, 200, { ok: true })
  })
  const client = testClient(server, { maxRetries: 2, log: (level, message) => logs.push({ level, message }) })
  const started = Date.now()
  const result = await client.sendMessage({ chatId: 1, text: 'hi' })
  const elapsed = Date.now() - started
  assert.deepEqual(result, { ok: true })
  assert.equal(attempts, 2)
  assert.ok(elapsed >= 900, `expected ~1000ms backoff, got ${elapsed}ms`)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'warn')
  assert.match(logs[0].message, /MAX API retry 1\/2 in 1000ms: MAX API 429 rate\.limit: slow down/)
})

test('5xx responses are retried', { skip: skipNoTls }, async (t) => {
  let attempts = 0
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    attempts += 1
    if (attempts === 1) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('upstream down')
      return
    }
    sendJson(res, 200, { ok: true })
  })
  const client = testClient(server, { maxRetries: 1 })
  const result = await client.sendMessage({ chatId: 1, text: 'hi' })
  assert.deepEqual(result, { ok: true })
  assert.equal(attempts, 2)
})

test('retries stop at maxRetries and surface the last error', { skip: skipNoTls }, async (t) => {
  let attempts = 0
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    attempts += 1
    sendJson(res, 500, { code: 'internal', message: 'boom' })
  })
  const client = testClient(server, { maxRetries: 1 })
  await assert.rejects(() => client.sendMessage({ chatId: 1, text: 'hi' }), (error) => {
    assert.equal(error.status, 500)
    assert.equal(error.code, 'internal')
    return true
  })
  assert.equal(attempts, 2)
})

test('sendWithAttachments retries attachment.not.ready and gives up after the configured attempts', { skip: skipNoTls }, async (t) => {
  let attempts = 0
  let alwaysFail = false
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    attempts += 1
    if (alwaysFail || attempts <= 2) {
      sendJson(res, 400, { code: 'attachment.not.ready', message: 'processing' })
      return
    }
    sendJson(res, 200, { ok: true })
  })
  const client = testClient(server, { maxRetries: 0 })
  const params = { chatId: 1, text: 'photo', attachments: [{ type: 'image', payload: { token: 'x' } }] }

  const result = await client.sendWithAttachments(params, { attempts: 3, delayMs: 1 })
  assert.deepEqual(result, { ok: true })
  assert.equal(attempts, 3)

  attempts = 0
  alwaysFail = true
  await assert.rejects(client.sendWithAttachments(params, { attempts: 2, delayMs: 1 }), (error) => {
    assert.equal(error.status, 400)
    assert.equal(error.code, 'attachment.not.ready')
    return true
  })
  assert.equal(attempts, 2)
})

// ---------------------------------------------------------------------------
// uploadMedia (multipart + attachment token)
// ---------------------------------------------------------------------------

test('uploadMedia uploads with the inferred type, auth header and multipart body', { skip: skipNoTls }, async (t) => {
  const uploads = []
  const targets = []
  const server = await startServer(t, async (req, res) => {
    const body = await readBody(req)
    if (req.url === '/uploads?type=image') {
      uploads.push({ method: req.method, url: req.url, headers: req.headers, body })
      sendJson(res, 200, { url: `${server.url}/upload-target`, token: 'created-token' })
      return
    }
    if (req.url === '/upload-target') {
      targets.push({ headers: req.headers, body })
      sendJson(res, 200, { photos: { 0: { token: 'photo-token' } } })
      return
    }
    res.statusCode = 404
    res.end('unexpected path')
  })
  const client = testClient(server)

  const result = await client.uploadMedia({ buffer: Buffer.from('IMAGE-BYTES'), filename: 'shot.png' })
  assert.deepEqual(result, { token: 'photo-token', type: 'image', name: 'shot.png' })
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].method, 'POST')
  assert.equal(uploads[0].url, '/uploads?type=image')
  assert.equal(uploads[0].headers.authorization, TOKEN)
  assert.equal(uploads[0].headers['content-type'], undefined)
  assert.equal(targets.length, 1)
  assert.equal(targets[0].headers.authorization, TOKEN)
  assert.match(targets[0].headers['content-type'], /^multipart\/form-data; boundary=----dshmax[0-9a-f]+$/)
  assert.equal(Number(targets[0].headers['content-length']), targets[0].body.length)
  const multipart = targets[0].body.toString('utf8')
  assert.ok(multipart.includes('name="data"; filename="shot.png"'), 'multipart form field name and filename')
  assert.ok(multipart.includes('IMAGE-BYTES'), 'raw file bytes are in the body')
})

test('uploadMedia accepts an explicit type and a filePath', { skip: skipNoTls }, async (t) => {
  const queries = []
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    if (req.url === '/uploads?type=file') {
      queries.push(req.url)
      sendJson(res, 200, { url: `${server.url}/upload-target` })
      return
    }
    if (req.url === '/upload-target') {
      sendJson(res, 200, { files: { f1: { token: 'file-token' } } })
      return
    }
    res.statusCode = 404
    res.end('unexpected path')
  })
  const client = testClient(server)
  const dir = tempDir(t)
  const filePath = join(dir, 'report.pdf')
  writeFileSync(filePath, 'PDF-BYTES')

  const result = await client.uploadMedia({ filePath, type: 'file' })
  assert.deepEqual(result, { token: 'file-token', type: 'file', name: 'report.pdf' })
  assert.deepEqual(queries, ['/uploads?type=file'])
})

test('uploadMedia falls back to the created token and accepts a direct token response', { skip: skipNoTls }, async (t) => {
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    if (req.url === '/uploads?type=audio') {
      sendJson(res, 200, { url: `${server.url}/direct` })
      return
    }
    if (req.url === '/uploads?type=image') {
      sendJson(res, 200, { url: `${server.url}/created`, token: 'created-token' })
      return
    }
    if (req.url === '/direct') {
      sendJson(res, 200, { token: 'direct-token' })
      return
    }
    if (req.url === '/created') {
      sendJson(res, 200, {})
      return
    }
    res.statusCode = 404
    res.end('unexpected path')
  })
  const client = testClient(server)

  assert.equal((await client.uploadMedia({ buffer: Buffer.from('a'), filename: 'voice.ogg' })).token, 'direct-token')
  assert.equal((await client.uploadMedia({ buffer: Buffer.from('b'), filename: 'shot.png' })).token, 'created-token')
})

test('uploadMedia refuses to send the token to an untrusted upload host', { skip: skipNoTls }, async (t) => {
  let hits = 0
  const server = await startServer(t, async (req, res) => {
    hits += 1
    await readBody(req)
    sendJson(res, 200, { url: 'https://evil.example/upload' })
  })
  const client = testClient(server)
  await assert.rejects(
    () => client.uploadMedia({ buffer: Buffer.from('x'), filename: 'shot.png' }),
    /refusing to send the MAX token to untrusted upload host: evil\.example/,
  )
  assert.equal(hits, 1, 'only the /uploads call may reach the trusted host')
})

test('uploadMedia reports missing upload URL and missing attachment token', { skip: skipNoTls }, async (t) => {
  let phase = 'no-url'
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    if (req.url === '/uploads?type=image') {
      if (phase === 'no-url') {
        sendJson(res, 200, {})
        return
      }
      sendJson(res, 200, { url: `${server.url}/empty` })
      return
    }
    if (req.url === '/empty') {
      sendJson(res, 200, {})
      return
    }
    res.statusCode = 404
    res.end('unexpected path')
  })
  const client = testClient(server)
  await assert.rejects(() => client.uploadMedia({ buffer: Buffer.from('x'), filename: 'a.png' }), /MAX \/uploads returned no upload URL/)
  phase = 'no-token'
  await assert.rejects(() => client.uploadMedia({ buffer: Buffer.from('x'), filename: 'a.png' }), /MAX upload returned no attachment token/)
})

// ---------------------------------------------------------------------------
// downloadToFile (host guard, redirects, limits, atomic write)
// ---------------------------------------------------------------------------

test('downloadToFile refuses untrusted hosts before any connection or token', { skip: skipNoTls }, async (t) => {
  let hits = 0
  const server = await startServer(t, (req, res) => {
    hits += 1
    res.end('should not be requested')
  })
  const dir = tempDir(t)
  const client = testClient(server)

  await assert.rejects(
    () => client.downloadToFile('https://evil.example/file.png', join(dir, 'a.png')),
    /refusing untrusted attachment URL: evil\.example/,
  )
  // Userinfo trick and loopback-but-untrusted hosts are rejected as well.
  await assert.rejects(
    () => client.downloadToFile(`https://evil.example@127.0.0.1:${server.port}/file.png`, join(dir, 'b.png')),
    /refusing untrusted attachment URL: 127\.0\.0\.1/,
  )
  await assert.rejects(() => client.downloadToFile('not a url', join(dir, 'c.png')), /Invalid URL/)

  assert.equal(hits, 0, 'no request may reach any host for untrusted URLs')
  assert.equal(server.connectionCount(), 0, 'no TCP connection may be opened for untrusted URLs')
  assert.equal(readdirSync(dir).length, 0, 'no destination or temp file may be created')
})

test('downloadToFile validates redirect targets against the same host guard', { skip: skipNoTls }, async (t) => {
  const paths = []
  const server = await startServer(t, async (req, res) => {
    paths.push(req.url)
    if (req.url === '/start') {
      res.writeHead(302, { location: 'https://evil.example/payload' })
      res.end()
      return
    }
    res.end('should not be requested')
  })
  const client = testClient(server)
  const dir = tempDir(t)
  await assert.rejects(
    () => client.downloadToFile(`${server.url}/start`, join(dir, 'file.png')),
    /refusing untrusted attachment URL: evil\.example/,
  )
  assert.deepEqual(paths, ['/start'], 'the untrusted redirect must not be followed')
  assert.equal(existsSync(join(dir, 'file.png')), false)
})

test('downloadToFile follows trusted redirects and writes the file atomically with 0600', { skip: skipNoTls }, async (t) => {
  const payload = Buffer.from('PNG-BYTES')
  const seen = []
  const server = await startServer(t, async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    if (req.url === '/file') {
      res.writeHead(302, { location: '/final' })
      res.end()
      return
    }
    if (req.url === '/final') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(payload.length) })
      res.end(payload)
      return
    }
    res.statusCode = 404
    res.end('unexpected path')
  })
  const client = testClient(server)
  const dir = tempDir(t)
  const dest = join(dir, 'nested', 'image.png')

  const result = await client.downloadToFile(`${server.url}/file`, dest)
  assert.equal(result.path, dest)
  assert.equal(result.bytes, payload.length)
  assert.equal(result.contentType, 'image/png')
  assert.deepEqual(readFileSync(dest), payload)
  assert.equal(statSync(dest).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['image.png'], 'temp file must be renamed away')
  assert.deepEqual(seen.map((entry) => entry.url), ['/file', '/final'])
  // The API host is the one host that receives the long-lived bot token.
  assert.ok(seen.every((entry) => entry.authorization === TOKEN))
})

test('downloadToFile surfaces HTTP failures and redirect limits', { skip: skipNoTls }, async (t) => {
  const server = await startServer(t, async (req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('nope')
      return
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' })
      res.end()
      return
    }
    res.statusCode = 500
    res.end('unexpected path')
  })
  const client = testClient(server)
  const dir = tempDir(t)
  await assert.rejects(
    () => client.downloadToFile(`${server.url}/missing`, join(dir, 'a.png')),
    /attachment download failed: HTTP 404 nope/,
  )
  await assert.rejects(
    () => client.downloadToFile(`${server.url}/loop`, join(dir, 'b.png'), { redirects: 0 }),
    /too many redirects while downloading an attachment/,
  )
})

test('downloadToFile enforces maxBytes without leaving the destination behind', { skip: skipNoTls }, async (t) => {
  const payload = Buffer.alloc(64, 0x61)
  const server = await startServer(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) })
    res.end(payload)
  })
  const client = testClient(server)
  const dir = tempDir(t)
  const dest = join(dir, 'big.bin')
  await assert.rejects(
    () => client.downloadToFile(`${server.url}/big`, dest, { maxBytes: 8 }),
    /attachment exceeds 8 bytes/,
  )
  assert.equal(existsSync(dest), false)
})

// ---------------------------------------------------------------------------
// Remaining transport endpoints (paths, methods, query encoding)
// ---------------------------------------------------------------------------

test('client endpoints build the documented paths, queries and bodies', { skip: skipNoTls }, async (t) => {
  const seen = []
  const server = await startServer(t, async (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: (await readBody(req)).toString('utf8') })
    sendJson(res, 200, { ok: true })
  })
  const client = testClient(server)

  await client.getMe()
  await client.getChat('a b/c')
  await client.getUpdates({ timeout: 0, limit: 100, marker: 'm1' })
  await client.setCommands([{ name: 'help', description: 'help' }])
  await client.sendAction(42)
  await client.answerCallback('cb1', { notification: 'ok' })
  await client.deleteMessage(7)
  await client.editMessage({ messageId: 7, text: 'edited', disableLinkPreview: false })
  await client.getSubscriptions()
  await client.subscribeWebhook({ url: 'https://example.test/hook', secret: 's3cret', updateTypes: 'message_created' })
  await client.unsubscribeWebhook('https://example.test/hook')

  assert.deepEqual(
    seen.map((entry) => `${entry.method} ${entry.url}`),
    [
      'GET /me',
      'GET /chats/a%20b%2Fc',
      'GET /updates?timeout=0&limit=100&marker=m1',
      'PATCH /me/commands',
      'POST /chats/42/actions',
      'POST /answers?callback_id=cb1',
      'DELETE /messages?message_id=7',
      'PUT /messages?message_id=7&disable_link_preview=false',
      'GET /subscriptions',
      'POST /subscriptions',
      'DELETE /subscriptions?url=https%3A%2F%2Fexample.test%2Fhook',
    ],
  )
  assert.ok(seen.every((entry) => entry.authorization === TOKEN))
  assert.deepEqual(JSON.parse(seen[3].body), { commands: [{ name: 'help', description: 'help' }] })
  assert.deepEqual(JSON.parse(seen[4].body), { action: 'typing_on' })
  assert.deepEqual(JSON.parse(seen[5].body), { notification: 'ok' })
  assert.deepEqual(JSON.parse(seen[7].body), { text: 'edited' })
  assert.deepEqual(JSON.parse(seen[9].body), {
    url: 'https://example.test/hook',
    secret: 's3cret',
    update_types: ['message_created'],
  })
})

test('sendText chunks long text into sequential sendMessage calls', { skip: skipNoTls }, async (t) => {
  const bodies = []
  const urls = []
  const server = await startServer(t, async (req, res) => {
    urls.push(req.url)
    bodies.push(JSON.parse((await readBody(req)).toString('utf8')))
    sendJson(res, 200, { ok: true })
  })
  const client = testClient(server)
  const text = `${'a'.repeat(2500)} ${'b'.repeat(2500)}`

  const results = await client.sendText({ chatId: 5, text })
  assert.equal(results.length, 2)
  assert.equal(bodies.length, 2)
  assert.deepEqual(urls, ['/messages?chat_id=5', '/messages?chat_id=5'])
  assert.equal(bodies.map((body) => body.text).join(''), text)
  assert.ok(bodies.every((body) => body.text.length <= MAX_TEXT_LIMIT))
})

test('an injected limiter gates sends and uploads but not long polling', { skip: skipNoTls }, async (t) => {
  const acquired = []
  const limiter = {
    acquire: async (chatKey, priority) => {
      acquired.push({ chatKey, priority })
    },
  }
  const server = await startServer(t, async (req, res) => {
    await readBody(req)
    if (req.url === '/uploads?type=image') {
      sendJson(res, 200, { url: `${server.url}/upload-target` })
      return
    }
    if (req.url === '/upload-target') {
      sendJson(res, 200, { token: 'uploaded-token' })
      return
    }
    sendJson(res, 200, { ok: true })
  })
  const client = testClient(server, { limiter })

  await client.sendMessage({ chatId: 9, text: 'hi', priority: 2 })
  assert.deepEqual(acquired, [{ chatKey: 'chat:9', priority: 2 }])

  await client.getUpdates({ timeout: 0 })
  assert.deepEqual(acquired, [{ chatKey: 'chat:9', priority: 2 }], 'long polling must bypass the limiter')

  await client.uploadMedia({ buffer: Buffer.from('x'), filename: 'a.png' })
  assert.deepEqual(acquired, [
    { chatKey: 'chat:9', priority: 2 },
    { chatKey: null, priority: 0 }, // the /uploads create call
    { chatKey: null, priority: undefined }, // the multipart upload itself
  ])
})
