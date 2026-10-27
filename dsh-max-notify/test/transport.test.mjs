import test from 'node:test'
import assert from 'node:assert/strict'
import { splitText, MAX_TEXT_LIMIT } from '../lib/transport.mjs'

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
