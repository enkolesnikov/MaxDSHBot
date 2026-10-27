import test from 'node:test'
import assert from 'node:assert/strict'
import { formatNotification } from '../lib/format.mjs'

const date = new Date(2026, 9, 27, 22, 15, 3)

test('formatNotification builds a markdown header with folder and body', () => {
  const text = formatNotification({
    text: 'Готово: добавил плагин.',
    cwd: '/path/to/MaxBot',
    reason: { kind: 'completed' },
    now: date,
  })
  assert.equal(text, '**DSH** · 22:15:03 · MaxBot\n\nГотово: добавил плагин.')
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
  assert.match(html, /^<b>DSH<\/b> · 22:15:03 · work · _прерван: user_\n\nx$/)
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
  assert.equal(formatNotification({ text: '  ok  ', now: date }), '**DSH** · 22:15:03\n\nok')
})

test('formatNotification prefers the session title over the folder name', () => {
  const text = formatNotification({
    text: 'x',
    cwd: '/path/to/MaxBot',
    title: 'Настройка MAX-плагина',
    now: date,
  })
  assert.equal(text, '**DSH** · 22:15:03 · Настройка MAX-плагина\n\nx')
})

test('formatNotification truncates very long session titles', () => {
  const text = formatNotification({ text: 'x', title: 'т'.repeat(80), now: date })
  assert.match(text, /· т{57}…\n\nx$/)
})
