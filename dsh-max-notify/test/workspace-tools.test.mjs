import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyUploadType,
  formatBytes,
  resolveSendFile,
  runGitDiff,
  WORKSPACE_LIMITS,
} from '../lib/workspace-tools.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-max-workspace-'))
const cwd = join(root, 'session')
const outside = join(root, 'outside')
mkdirSync(cwd)
mkdirSync(outside)
const insideFile = join(cwd, 'report.pdf')
writeFileSync(insideFile, 'hello')
writeFileSync(join(cwd, 'shot.png'), Buffer.from([1, 2, 3]))
const outsideFile = join(outside, 'secret.txt')
writeFileSync(outsideFile, 'secret')
const link = join(cwd, 'link-outside')
symlinkSync(outsideFile, link)

test('classifyUploadType maps image/audio/file', () => {
  assert.equal(classifyUploadType('a.PNG'), 'image')
  assert.equal(classifyUploadType('/tmp/voice.ogg'), 'audio')
  assert.equal(classifyUploadType('report.pdf'), 'file')
})

test('runGitDiff passes safe args and returns the diff', async () => {
  let captured
  const execFileImpl = async (file, args) => {
    captured = { file, args }
    return { stdout: 'diff --git a/x b/x\n+hello', stderr: '' }
  }
  const result = await runGitDiff({ cwd, path: 'src', staged: true, execFileImpl })
  assert.equal(result.ok, true)
  assert.match(result.diff, /diff --git/)
  assert.deepEqual(captured, { file: 'git', args: ['-C', cwd, 'diff', '--staged', '--', 'src'] })
})

test('runGitDiff reports empty, truncated and non-git cases', async () => {
  assert.equal((await runGitDiff({ cwd, execFileImpl: async () => ({ stdout: '  ' }) })).empty, true)
  const huge = 'x'.repeat(100)
  const truncated = await runGitDiff({ cwd, maxBytes: 10, execFileImpl: async () => ({ stdout: huge }) })
  assert.equal(truncated.truncated, true)
  assert.match(truncated.diff, /усечён/)
  const failed = await runGitDiff({
    cwd,
    execFileImpl: async () => {
      throw new Error('fatal: not a git repository')
    },
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /git-репозиторий/)
})

test('resolveSendFile allows files inside cwd and rejects outside paths', () => {
  const ok = resolveSendFile({ cwd, arg: 'report.pdf' })
  assert.equal(ok.ok, true)
  assert.equal(ok.type, 'file')
  assert.equal(ok.bytes, 5)
  assert.equal(resolveSendFile({ cwd, arg: 'shot.png' }).type, 'image')
  assert.equal(resolveSendFile({ cwd, arg: '../outside/secret.txt' }).ok, false)
  assert.equal(resolveSendFile({ cwd, arg: link }).ok, false)
  assert.equal(resolveSendFile({ cwd, arg: outsideFile }).ok, false)
  assert.equal(resolveSendFile({ cwd, arg: '../outside/secret.txt', allowOutside: true }).ok, true)
  assert.equal(resolveSendFile({ cwd, arg: '' }).ok, false)
  assert.equal(resolveSendFile({ cwd, arg: 'missing.txt' }).ok, false)
})

test('resolveSendFile enforces the size limit', () => {
  const big = join(cwd, 'big.bin')
  writeFileSync(big, Buffer.alloc(100))
  assert.equal(resolveSendFile({ cwd, arg: 'big.bin', maxBytes: 10 }).ok, false)
  assert.equal(resolveSendFile({ cwd, arg: 'big.bin', maxBytes: 1000 }).ok, true)
})

test('formatBytes and limits are stable', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(WORKSPACE_LIMITS.maxDiffBytes, 1024 * 1024)
})
