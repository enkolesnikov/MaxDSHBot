import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSessionDir } from '../lib/create-session.mjs'

const base = '/work/app'

test('no argument uses the active session directory', () => {
  assert.equal(resolveSessionDir({ baseCwd: base }), base)
})

test('relative folder is resolved against the active session directory', () => {
  assert.equal(resolveSessionDir({ arg: 'max', baseCwd: base }), '/work/app/max')
  assert.equal(resolveSessionDir({ arg: './sub/dir', baseCwd: base }), '/work/app/sub/dir')
})

test('absolute folder is kept as is', () => {
  assert.equal(resolveSessionDir({ arg: '/srv/other', baseCwd: base }), '/srv/other')
})

test('configured newSessionDir is used without an argument', () => {
  assert.equal(
    resolveSessionDir({ baseCwd: base, configuredDir: 'max' }),
    '/work/app/max',
  )
  assert.equal(
    resolveSessionDir({ baseCwd: base, configuredDir: '/opt/max' }),
    '/opt/max',
  )
})

test('argument wins over the configured directory', () => {
  assert.equal(
    resolveSessionDir({ arg: 'custom', baseCwd: base, configuredDir: '/opt/max' }),
    '/work/app/custom',
  )
})

test('falls back to process cwd without any base', () => {
  const resolved = resolveSessionDir({})
  assert.equal(resolved, process.cwd())
})
