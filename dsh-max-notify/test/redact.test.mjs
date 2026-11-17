import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { redact, wrapLogger, registerSecret, clearSecrets } from '../lib/redact.mjs'

afterEach(() => clearSecrets())

test('redact hides long token-like strings and upload credentials', () => {
  const token = 'test_token_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const text = `Authorization: ${token} url=https://iu.oneme.ru/upload?r=abc123def456ghi789jkl&x=1`
  const cleaned = redact(text)
  assert.equal(cleaned.includes(token), false)
  assert.match(cleaned, /<redacted>/)
  assert.equal(cleaned.includes('abc123def456ghi789jkl'), false)
})

test('redact keeps ordinary text untouched', () => {
  assert.equal(redact('привет, это обычная строка'), 'привет, это обычная строка')
  assert.equal(redact(''), '')
})

test('wrapLogger redacts every string argument', () => {
  const lines = []
  const logger = { warn: (...args) => lines.push(args), info: () => {}, debug: () => {}, error: () => {} }
  const wrapped = wrapLogger(logger)
  wrapped.warn('failed for token %s', 'test_token_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  assert.equal(lines[0][1].includes('test_token'), false)
  assert.match(lines[0][1], /<redacted>/)
})

test('wrapLogger tolerates a missing logger', () => {
  assert.equal(wrapLogger(undefined), undefined)
})

test('registerSecret masks a 32-char runtime secret anywhere', () => {
  const secret = '0123456789abcdef0123456789abcdef'
  assert.equal(secret.length, 32)
  assert.equal(registerSecret(secret), true)
  const text = `prefix/${secret}/suffix`
  const cleaned = redact(text)
  assert.equal(cleaned.includes(secret), false)
  assert.equal(cleaned, 'prefix/<redacted>/suffix')
  // registering twice is a no-op; short values are ignored
  assert.equal(registerSecret(secret), false)
  assert.equal(registerSecret('short'), false)
})

test('a bare 32-char hash is not redacted without a secret-like context', () => {
  const hash = '0123456789abcdef0123456789abcdef'
  assert.equal(redact(`md5=[${hash}]`), `md5=[${hash}]`)
  // …but the same value is masked when a secret context says so.
  const inContext = redact(`webhook secret: ${hash}`)
  assert.equal(inContext.includes(hash), false)
  assert.match(inContext, /<redacted>/)
})

test('wrapLogger registers secrets passed to it', () => {
  const secret = 'voice-key-0123456789abcdef'
  const lines = []
  const logger = { warn: (...args) => lines.push(args), info() {}, debug() {}, error() {} }
  const wrapped = wrapLogger(logger, [secret])
  wrapped.warn('using %s', secret)
  assert.equal(lines[0][1].includes(secret), false)
  assert.match(lines[0][1], /<redacted>/)

  const secondSecret = 'another-key-0123456789'
  wrapLogger(logger, { secrets: [secondSecret] }).warn('using %s', secondSecret)
  assert.equal(lines[1][1].includes(secondSecret), false)
})
