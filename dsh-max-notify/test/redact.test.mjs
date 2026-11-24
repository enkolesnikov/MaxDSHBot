import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { redact, redactDeep, wrapLogger, registerSecret, clearSecrets } from '../lib/redact.mjs'

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

// A secret without a secret-like context word: only registration can mask it.
const NESTED_SECRET = 'Q7w9E2r5T8y1U4i6O3p0A5s8D1f4G7h9'

test('redactDeep masks secrets nested in objects and arrays without mutating input', () => {
  registerSecret(NESTED_SECRET)
  const input = {
    plain: `prefix [${NESTED_SECRET}] suffix`,
    list: [1, `[${NESTED_SECRET}]`, { deep: `[${NESTED_SECRET}]` }],
    flag: true,
    empty: null,
    count: 7,
  }
  const output = redactDeep(input)
  assert.notEqual(output, input)
  assert.equal(output.plain.includes(NESTED_SECRET), false)
  assert.match(output.plain, /<redacted>/)
  assert.equal(output.list[0], 1)
  assert.equal(output.list[1].includes(NESTED_SECRET), false)
  assert.equal(output.list[2].deep.includes(NESTED_SECRET), false)
  assert.equal(output.flag, true)
  assert.equal(output.empty, null)
  assert.equal(output.count, 7)
  // The input object is copied, not mutated.
  assert.equal(input.plain.includes(NESTED_SECRET), true)
  assert.equal(input.list[2].deep.includes(NESTED_SECRET), true)
})

test('redactDeep handles cycles and caps depth instead of overflowing', () => {
  registerSecret(NESTED_SECRET)
  const cyclic = { note: `[${NESTED_SECRET}]` }
  cyclic.self = cyclic
  const safeCycle = redactDeep(cyclic)
  assert.equal(safeCycle.self, '<cycle>')
  assert.equal(safeCycle.note.includes(NESTED_SECRET), false)

  let deep = 'leaf'
  for (let index = 0; index < 40; index += 1) deep = { next: deep }
  let cursor = redactDeep(deep)
  let steps = 0
  while (cursor && typeof cursor === 'object' && cursor.next !== undefined && steps < 40) {
    cursor = cursor.next
    steps += 1
  }
  assert.equal(cursor, '<deep>')
})
