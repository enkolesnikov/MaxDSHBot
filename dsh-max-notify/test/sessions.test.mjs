import test from 'node:test'
import assert from 'node:assert/strict'
import { archivedIdsOf, filterArchivedSessions } from '../lib/sessions.mjs'

const items = [
  { sessionId: 'session-a', updatedAt: 3 },
  { sessionId: 'session-b', updatedAt: 2 },
  { sessionId: 'session-c', updatedAt: 1 },
]

test('filterArchivedSessions removes archived ids', () => {
  const result = filterArchivedSessions(items, ['session-b'])
  assert.deepEqual(result.map((item) => item.sessionId), ['session-a', 'session-c'])
})

test('numeric/string id shapes are compared as strings', () => {
  const numeric = [{ sessionId: 123 }, { sessionId: 456 }]
  assert.deepEqual(filterArchivedSessions(numeric, [123]).map((item) => item.sessionId), [456])
})

test('empty archive set keeps everything (and copies)', () => {
  const result = filterArchivedSessions(items, [])
  assert.deepEqual(result, items)
  assert.notEqual(result, items)
})

test('missing items are tolerated', () => {
  assert.deepEqual(filterArchivedSessions(undefined, ['x']), [])
  assert.deepEqual(filterArchivedSessions([null, { sessionId: 'k' }], ['x']).length, 2)
})

test('archivedIdsOf tolerates an absent registry and getter errors', () => {
  assert.deepEqual(archivedIdsOf(undefined), [])
  assert.deepEqual(archivedIdsOf({ archivedSessionIds: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(
    archivedIdsOf({
      get archivedSessionIds() {
        throw new Error('not ready')
      },
    }),
    [],
  )
})
