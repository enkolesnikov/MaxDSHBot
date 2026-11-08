import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../index.js'
import {
  formatApprovalCard,
  formatApprovalResult,
  formatDigestCard,
  formatErrorCard,
  formatHelpAllCard,
  formatHelpCard,
  formatJobCard,
  formatStatusCard,
  formatSubagentCard,
} from '../lib/cards.mjs'

const lineCount = (text) => String(text).split('\n').length

test('UX defaults are compact and quiet', () => {
  const config = normalizeConfig({ botToken: 't', chatId: '1' })
  assert.equal(config.messageStyle, 'compact')
  assert.equal(config.notifySubagents, false)
  assert.equal(config.notifyJobs, false)
  assert.equal(config.notifyGoals, false)
  assert.equal(config.todoProgress, false)
  assert.equal(config.notifyErrors, true)
})

test('compact help is short and full help keeps advanced commands', () => {
  const help = formatHelpCard()
  assert.ok(help.length <= 450, `help is ${help.length} chars`)
  assert.match(help, /\/status/)
  assert.doesNotMatch(help, /\/diff/)
  const all = formatHelpAllCard()
  assert.match(all, /\/diff/)
  assert.match(all, /\/settings/)
  assert.ok(lineCount(all) > lineCount(help))
})

test('approval card is short, hides callId and truncates the reason', () => {
  const card = formatApprovalCard({
    title: 'Сессия',
    toolName: 'bash',
    reason: 'x'.repeat(500),
    callId: 'call-should-not-leak',
  })
  assert.doesNotMatch(card, /call-should-not-leak/)
  assert.doesNotMatch(card, /Требуется разрешение/)
  assert.ok(lineCount(card) <= 4)
  assert.ok(card.length < 360)
})

test('approval result is one compact line', () => {
  assert.equal(formatApprovalResult({ outcome: 'allowed-once', toolName: 'bash', by: 'gui' }), '✅ Разрешено (GUI) · bash')
  assert.equal(formatApprovalResult({ outcome: 'rejected', toolName: 'write', by: 'timeout' }), '⛔ Отклонено (таймаут) · write')
})

test('status card is at most four lines', () => {
  const card = formatStatusCard({
    title: 'Ревью',
    sessionId: 'session-00000000-0000-0000-0000-abcdef12',
    running: true,
    agentStatus: 'busy',
    model: 'deepseek-flash',
    provider: 'deepseek',
    cwd: '/work/app',
    updatedAt: Date.now(),
  })
  assert.ok(lineCount(card) <= 4)
  assert.match(card, /Ревью/)
  assert.match(card, /deepseek\/deepseek-flash/)
})

test('job/subagent cards are one line; error is compact', () => {
  assert.equal(lineCount(formatJobCard({ job: { id: 'bash-1', status: 'completed', label: 'pnpm test' } })), 1)
  assert.equal(lineCount(formatSubagentCard({ childId: 'child-1', stopReason: 'completed', excerpt: 'итог' })), 1)
  const error = formatErrorCard({ title: 'Деплой', turn: 2, step: 1, error: new Error('boom') })
  assert.ok(lineCount(error) <= 3)
  assert.match(error, /boom/)
  assert.doesNotMatch(error, /Error: boom/)
})

test('digest is a four-part briefing, not a session dump', () => {
  const digest = formatDigestCard({
    date: '09.11.2026',
    sessions: Array.from({ length: 8 }, (_, index) => ({ title: `S${index}`, running: index === 0 })),
    pending: { approvals: 2, questions: 1 },
    cost: {
      available: true,
      currency: { code: 'CNY', symbol: '¥', decimals: 2 },
      today: { amount: 5 },
      budget: { enabled: true, percent: 15 },
    },
  })
  assert.ok(lineCount(digest) <= 5)
  assert.match(digest, /Ждёт тебя: 2 approval · 1 вопрос/)
  assert.match(digest, /Деньги/)
  assert.doesNotMatch(digest, /S7/)
})
