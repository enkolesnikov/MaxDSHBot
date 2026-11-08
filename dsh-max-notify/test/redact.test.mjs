import test from 'node:test'
import assert from 'node:assert/strict'
import { redact, wrapLogger } from '../lib/redact.mjs'

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
