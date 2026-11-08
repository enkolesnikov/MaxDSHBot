import test from 'node:test'
import assert from 'node:assert/strict'
import {
  READ_ONLY_TOOLS,
  classifyAutonomyDecision,
  formatAutonomyMode,
  normalizeAutonomyMode,
  normalizePolicy,
  resolveAutonomyPolicy,
  scheduleMatchesSession,
} from '../lib/autonomy.mjs'

test('modes normalize and format', () => {
  assert.equal(normalizeAutonomyMode(' READ-ONLY '), 'read-only')
  assert.equal(normalizeAutonomyMode('auto'), 'auto')
  assert.equal(normalizeAutonomyMode('nope'), undefined)
  assert.match(formatAutonomyMode('auto'), /auto/)
  assert.match(formatAutonomyMode('inherit'), /обычный/)
})

test('normalizePolicy drops inherit and invalid values', () => {
  assert.equal(normalizePolicy({ mode: 'inherit' }), undefined)
  assert.equal(normalizePolicy({ mode: 'bad' }), undefined)
  assert.deepEqual(normalizePolicy({ mode: 'read-only', title: 'x' }).mode, 'read-only')
})

test('read-only allows read tools and rejects side effects', () => {
  assert.equal(READ_ONLY_TOOLS.has('read'), true)
  assert.deepEqual(classifyAutonomyDecision('read-only', 'read'), { action: 'allow', reason: 'read-only tool' })
  assert.equal(classifyAutonomyDecision('read-only', 'write').action, 'deny')
  assert.equal(classifyAutonomyDecision('read-only', 'bash').action, 'deny')
  assert.equal(classifyAutonomyDecision('read-only', '').action, 'deny')
})

test('auto allows everything, inherit prompts', () => {
  assert.equal(classifyAutonomyDecision('auto', 'bash').action, 'allow')
  assert.equal(classifyAutonomyDecision('inherit', 'bash').action, 'prompt')
})

test('direct session match requires an active execution', () => {
  const schedule = { targetSessionId: 's1', involvedSessionIds: ['s1'], title: 'Deploy', executionActive: true, status: 'active' }
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 's1' }), true)
  assert.equal(scheduleMatchesSession({ ...schedule, executionActive: false }, { sessionId: 's1' }), false)
})

test('new-session match uses a recent delivery and title', () => {
  const now = Date.parse('2026-11-09T10:00:00.000Z')
  const schedule = {
    targetSessionId: '',
    title: 'Deploy check',
    executionActive: false,
    status: 'active',
    lastDelivery: { deliveredAt: '2026-11-09T09:55:00.000Z' },
  }
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 'new-1', sessionTitle: 'Deploy check', now }), true)
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 'new-1', sessionTitle: 'Other', now }), false)
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 'new-1', sessionTitle: 'Deploy check', now: now + 60 * 60 * 1000 }), false)
})

test('resolveAutonomyPolicy picks the least-privilege matching policy', () => {
  const schedules = [
    { id: 'a', title: 'Deploy', targetSessionId: 's1', executionActive: true, status: 'active' },
    { id: 'b', title: 'Deploy', targetSessionId: 's1', executionActive: true, status: 'active' },
  ]
  const result = resolveAutonomyPolicy({
    sessionId: 's1',
    schedules,
    policies: { a: { mode: 'auto' }, b: { mode: 'read-only' } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'read-only')
  assert.equal(resolveAutonomyPolicy({ sessionId: 's1', schedules, policies: {} }).ok, false)
})
