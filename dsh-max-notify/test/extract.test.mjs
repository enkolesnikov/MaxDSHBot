import test from 'node:test'
import assert from 'node:assert/strict'
import { extractAssistantText, describeReason } from '../lib/extract.mjs'

test('extractAssistantText joins text blocks and skips reasoning/tool blocks', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'internal thinking' },
      { type: 'text', text: 'Hello ' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'text', text: 'world' },
    ],
  }
  assert.equal(extractAssistantText(message), 'Hello\n\nworld')
})

test('extractAssistantText ignores empty and non-string text', () => {
  assert.equal(extractAssistantText(undefined), '')
  assert.equal(extractAssistantText({ content: null }), '')
  assert.equal(extractAssistantText({ content: [{ type: 'text', text: '   ' }] }), '')
  assert.equal(extractAssistantText({ content: [{ type: 'text', text: 42 }] }), '')
})

test('describeReason is empty for completed turns', () => {
  assert.equal(describeReason({ kind: 'completed' }), '')
  assert.equal(describeReason(undefined), '')
  assert.equal(describeReason('completed'), '')
})

test('describeReason names abnormal endings', () => {
  assert.equal(describeReason({ kind: 'aborted', reason: 'user' }), 'прерван: user')
  assert.equal(describeReason({ kind: 'aborted', reason: { kind: 'shutdown' } }), 'прерван: shutdown')
  assert.equal(describeReason({ kind: 'aborted' }), 'прерван')
  assert.equal(describeReason({ kind: 'blocked' }), 'заблокирован')
  assert.equal(describeReason({ kind: 'failed' }), 'failed')
})
