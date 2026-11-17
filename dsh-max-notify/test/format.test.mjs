import test from 'node:test'
import assert from 'node:assert/strict'
import { folderOf, formatBytes, formatClock, formatNotification } from '../lib/format.mjs'

const date = new Date(2026, 9, 27, 22, 15, 3)

test('formatNotification builds a markdown header with folder and body', () => {
  const text = formatNotification({
    text: 'Готово: добавил плагин.',
    cwd: '/path/to/MaxBot',
    reason: { kind: 'completed' },
    now: date,
  })
  assert.equal(text, '🕒 22:15 · MaxBot\n\nГотово: добавил плагин.')
})

test('formatNotification can omit the header', () => {
  assert.equal(formatNotification({ text: 'hi', includeHeader: false }), 'hi')
})

test('formatNotification styles the header per format and marks abnormal endings', () => {
  const html = formatNotification({
    text: 'x',
    cwd: '/srv/work/',
    format: 'html',
    reason: { kind: 'aborted', reason: 'user' },
    now: date,
  })
  assert.match(html, /^🕒 22:15 · work · прерван: user\n\nx$/)
})

test('formatNotification adds a short session tag when asked', () => {
  const text = formatNotification({
    text: 'x',
    sessionId: 'session-00000000-0000-0000-0000-00abcdef12',
    includeSessionId: true,
    now: date,
  })
  assert.match(text, /· abcdef12\n\n/)
})

test('formatNotification handles an empty cwd and trims the body', () => {
  assert.equal(formatNotification({ text: '  ok  ', now: date }), '🕒 22:15\n\nok')
})

test('formatNotification prefers the session title over the folder name', () => {
  const text = formatNotification({
    text: 'x',
    cwd: '/path/to/MaxBot',
    title: 'Настройка MAX-плагина',
    now: date,
  })
  assert.equal(text, '🕒 22:15 · Настройка MAX-плагина\n\nx')
})

test('formatNotification truncates very long session titles', () => {
  const text = formatNotification({ text: 'x', title: 'т'.repeat(80), now: date })
  assert.match(text, /· т{37}…\n\nx$/)
})


test('messageStyle detailed keeps the legacy DSH header', () => {
  const text = formatNotification({
    text: 'x',
    cwd: '/path/to/MaxBot',
    messageStyle: 'detailed',
    now: date,
  })
  assert.equal(text, '**DSH** · 22:15:03 · MaxBot\n\nx')
})

test('folderOf is the single short-cwd helper for headers and cards', () => {
  assert.equal(folderOf('/path/to/MaxBot'), 'MaxBot')
  assert.equal(folderOf('/srv/work/'), 'work')
  assert.equal(folderOf('C:\\Users\\dev\\proj\\'), 'proj')
  assert.equal(folderOf(''), '')
  assert.equal(folderOf(undefined), '')
})

test('formatClock renders HH:MM, optional seconds and an em dash for bad dates', () => {
  assert.equal(formatClock(date), '22:15')
  assert.equal(formatClock(date, { seconds: true }), '22:15:03')
  assert.equal(formatClock('not a date'), '—')
  assert.equal(formatClock(new Date(Number.NaN)), '—')
})

test('formatBytes uses binary units and two decimals past a gibibyte', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(900), '900 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  // 1024³ bytes is labelled "GB" but means GiB; sub-GiB values stay in MB.
  assert.equal(formatBytes(1024 ** 3), '1.00 GB')
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.50 GB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})
