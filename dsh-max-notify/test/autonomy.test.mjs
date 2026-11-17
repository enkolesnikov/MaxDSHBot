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
  assert.equal(result.identityVerified, true)
  assert.equal(resolveAutonomyPolicy({ sessionId: 's1', schedules, policies: {} }).ok, false)
})

// ── P1: title matching and session identity ─────────────────────────────────

const P1_NOW = Date.parse('2026-11-09T10:00:00.000Z')
const P1_DELIVERY = { deliveredAt: '2026-11-09T09:55:00.000Z' }

test('a short schedule title does not match a longer unrelated title', () => {
  const schedule = {
    title: 'ci',
    targetSessionId: '',
    involvedSessionIds: [],
    executionActive: false,
    lastDelivery: P1_DELIVERY,
  }
  // `left.includes(right)` used to match both of these.
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 'n1', sessionTitle: 'circleci build', now: P1_NOW }), false)
  assert.equal(scheduleMatchesSession({ ...schedule, title: 'Deploy' }, {
    sessionId: 'n1', sessionTitle: 'Redeploy production', now: P1_NOW,
  }), false)
  // An exact match and an anchored prefix with a boundary still work.
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 'n1', sessionTitle: 'ci', now: P1_NOW }), true)
  assert.equal(scheduleMatchesSession(schedule, { sessionId: 'n1', sessionTitle: 'ci build', now: P1_NOW }), true)
})

test('identity mismatch does not grant auto, even with a matching title and fresh delivery', () => {
  const schedule = {
    id: 'sched-auto',
    title: 'Deploy',
    targetSessionId: 'real-session',
    involvedSessionIds: ['real-session'],
    executionActive: false,
    status: 'active',
    lastDelivery: P1_DELIVERY,
  }
  const policies = { 'sched-auto': { mode: 'auto', title: 'Deploy' } }
  assert.equal(scheduleMatchesSession(schedule, {
    sessionId: 'other-session', sessionTitle: 'Deploy', now: P1_NOW,
  }), false)
  const result = resolveAutonomyPolicy({
    sessionId: 'other-session', sessionTitle: 'Deploy', schedules: [schedule], policies, now: P1_NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(resolveAutonomyPolicy({
    sessionId: '', sessionTitle: 'Deploy', schedules: [schedule], policies, now: P1_NOW,
  }).ok, false)
})

test('identity match still grants auto', () => {
  const active = {
    id: 'sched-auto',
    title: 'Deploy',
    targetSessionId: 'real-session',
    involvedSessionIds: [],
    executionActive: true,
    status: 'active',
  }
  const policies = { 'sched-auto': { mode: 'auto', title: 'Deploy' } }
  const direct = resolveAutonomyPolicy({ sessionId: 'real-session', schedules: [active], policies, now: P1_NOW })
  assert.equal(direct.ok, true)
  assert.equal(direct.mode, 'auto')
  assert.equal(direct.identityVerified, true)

  // One-shot `new` session: identity matches but executionActive is false;
  // a fresh receipt plus a title match still grants the policy.
  const oneShot = { ...active, executionActive: false, lastDelivery: P1_DELIVERY }
  const fallback = resolveAutonomyPolicy({
    sessionId: 'real-session', sessionTitle: 'Deploy', schedules: [oneShot], policies, now: P1_NOW,
  })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.mode, 'auto')
  assert.equal(fallback.identityVerified, true)
})

test('a fresh-delivery title match alone never grants auto', () => {
  const schedule = {
    id: 'sched-new',
    title: 'Deploy',
    targetSessionId: '',
    involvedSessionIds: [],
    executionActive: false,
    status: 'active',
    lastDelivery: P1_DELIVERY,
  }
  const result = resolveAutonomyPolicy({
    sessionId: 'new-session',
    sessionTitle: 'Deploy',
    schedules: [schedule],
    policies: { 'sched-new': { mode: 'auto', title: 'Deploy' } },
    now: P1_NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.identityVerified, false)
  // Demoted to inherit: still matches, but `auto` cannot silently approve.
  assert.equal(result.mode, 'inherit')
  assert.equal(classifyAutonomyDecision(result.mode, 'bash').action, 'prompt')
  assert.equal(classifyAutonomyDecision(result.mode, 'read').action, 'prompt')

  // `read-only` keeps its semantics on a title-only match: safe tools still
  // auto-allow and side effects are still denied.
  const readOnly = resolveAutonomyPolicy({
    sessionId: 'new-session',
    sessionTitle: 'Deploy',
    schedules: [schedule],
    policies: { 'sched-new': { mode: 'read-only', title: 'Deploy' } },
    now: P1_NOW,
  })
  assert.equal(readOnly.ok, true)
  assert.equal(readOnly.mode, 'read-only')
  assert.equal(readOnly.identityVerified, false)
  assert.equal(classifyAutonomyDecision(readOnly.mode, 'read').action, 'allow')
  assert.equal(classifyAutonomyDecision(readOnly.mode, 'bash').action, 'deny')
})
