import test from 'node:test'
import assert from 'node:assert/strict'
import { createPolicy } from '../lib/policy.mjs'

function memoryState(initial = {}) {
  const data = { mode: initial.mode, muteUntil: initial.muteUntil }
  return {
    getMode: () => data.mode,
    setMode: (mode) => {
      data.mode = mode
    },
    getMuteUntil: () => data.muteUntil,
    setMuteUntil: (value) => {
      data.muteUntil = value
    },
    data,
  }
}

const silent = { info() {}, warn() {}, debug() {} }
const at = (hour, minute = 0) => new Date(2026, 9, 27, hour, minute, 0).getTime()

test('normal mode sends and notifies non-critical kinds', () => {
  const policy = createPolicy({ config: {}, state: memoryState(), logger: silent, now: () => at(12) })
  assert.deepEqual(policy.decide('final'), { send: true, notify: true, reason: 'normal' })
  assert.deepEqual(policy.decide('todo'), { send: true, notify: true, reason: 'normal' })
})

test('critical kinds always notify, even in mute', () => {
  const state = memoryState({ mode: 'mute' })
  const policy = createPolicy({ config: {}, state, logger: silent, now: () => at(12) })
  for (const kind of ['approval', 'question', 'error']) {
    assert.deepEqual(policy.decide(kind), { send: true, notify: true, reason: 'critical' })
  }
})

test('mute drops non-critical notifications', () => {
  const state = memoryState({ mode: 'mute' })
  const policy = createPolicy({ config: {}, state, logger: silent, now: () => at(12) })
  assert.deepEqual(policy.decide('final'), { send: false, notify: false, reason: 'mute' })
})

test('mute expires after its duration', () => {
  let now = at(12)
  const state = memoryState()
  const policy = createPolicy({ config: {}, state, logger: silent, now: () => now })
  policy.setMode('mute', 60_000)
  assert.equal(policy.decide('final').send, false)
  now += 61_000
  assert.equal(policy.decide('final').send, true)
  assert.equal(state.data.mode, 'all')
})

test('errors mode keeps delivery but silences push', () => {
  const state = memoryState({ mode: 'errors' })
  const policy = createPolicy({ config: {}, state, logger: silent, now: () => at(12) })
  assert.deepEqual(policy.decide('todo'), { send: true, notify: false, reason: 'errors-only' })
})

test('quiet hours silence non-critical notifications overnight', () => {
  const config = { quietHours: { start: '23:00', end: '08:00' } }
  const night = createPolicy({ config, state: memoryState(), logger: silent, now: () => at(2) })
  assert.equal(night.decide('final').send, true)
  assert.equal(night.decide('final').notify, false)
  assert.equal(night.decide('error').notify, true)

  const day = createPolicy({ config, state: memoryState(), logger: silent, now: () => at(12) })
  assert.equal(day.decide('final').notify, true)
  assert.equal(day.decide('final').reason, 'normal')
})

test('quiet hours boundary: end is exclusive', () => {
  const config = { quietHours: { start: '23:00', end: '08:00' } }
  assert.equal(createPolicy({ config, state: memoryState(), logger: silent, now: () => at(23) }).inQuietHours(), true)
  assert.equal(createPolicy({ config, state: memoryState(), logger: silent, now: () => at(7, 59) }).inQuietHours(), true)
  assert.equal(createPolicy({ config, state: memoryState(), logger: silent, now: () => at(8) }).inQuietHours(), false)
})

test('setMode rejects unknown modes and describe names the current one', () => {
  const policy = createPolicy({ config: {}, state: memoryState(), logger: silent, now: () => at(12) })
  assert.equal(policy.setMode('nope'), false)
  policy.setMode('errors')
  assert.match(policy.describe(), /только ошибки/)
  assert.match(policy.describe(), /тихие часы выключены/)
})
