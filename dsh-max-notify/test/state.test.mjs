import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createState, resolveStateFile } from '../lib/state.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-state-'))
const file = join(workspace, 'state.json')

test('resolveStateFile prefers explicit config and falls back to DSH_HOME', () => {
  assert.equal(resolveStateFile({ stateFile: '/tmp/custom.json' }), '/tmp/custom.json')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home'
  try {
    assert.equal(resolveStateFile({}), join('/tmp/dsh-home', 'max-notify', 'state.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('marker and active sessions survive a reload', () => {
  const first = createState({ file, logger: { warn() {} } })
  assert.equal(first.marker, undefined)
  first.setMarker(42)
  first.setSession('123456789', 'session-aaaaaaaa')
  first.save()
  first.dispose()

  const second = createState({ file, logger: { warn() {} } })
  assert.equal(second.marker, 42)
  assert.equal(second.sessionFor('123456789'), 'session-aaaaaaaa')
  assert.equal(second.sessionFor('999'), undefined)
  second.forgetSession('123456789')
  assert.equal(second.sessionFor('123456789'), undefined)
  second.dispose()
})

test('corrupt state file starts fresh', () => {
  const broken = join(workspace, 'broken.json')
  writeFileSync(broken, '{not json')
  const state = createState({ file: broken, logger: { warn() {} } })
  assert.equal(state.marker, undefined)
  state.dispose()
})
