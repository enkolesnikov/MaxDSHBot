import test from 'node:test'
import assert from 'node:assert/strict'
import { createLruMap } from '../lib/lru.mjs'

test('LRU evicts the least recently used key and refreshes on read', () => {
  const lru = createLruMap({ max: 2 })
  lru.set('a', 1)
  lru.set('b', 2)
  assert.equal(lru.get('a'), 1)
  lru.set('c', 3)
  assert.equal(lru.has('b'), false)
  assert.equal(lru.has('a'), true)
  assert.equal(lru.size, 2)
})

test('LRU clamps invalid limits and supports clear/delete', () => {
  const lru = createLruMap({ max: -5 })
  assert.equal(lru.max, 500)
  lru.set('x', 1)
  assert.equal(lru.delete('x'), true)
  lru.set('y', 2)
  lru.clear()
  assert.equal(lru.size, 0)
})
