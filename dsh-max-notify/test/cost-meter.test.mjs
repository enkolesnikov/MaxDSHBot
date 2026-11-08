import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCostMeter,
  formatMoney,
  formatPercent,
  localDayKey,
  resolveCostLedgerFile,
} from '../lib/cost-meter.mjs'
import { formatBudgetAlertCard, formatBudgetCard, formatCostStatusLine, formatDigestCard } from '../lib/cards.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-max-cost-'))
let counter = 0
const freshFile = () => join(workspace, `ledger-${++counter}.json`)

const TODAY = '2026-11-09'
const fakeNow = () => new Date(2026, 10, 9, 12, 0, 0).getTime()

function ledger(overrides = {}) {
  return {
    version: 1,
    config: {
      currency: 'CNY',
      symbol: '¥',
      decimals: 2,
      pricingCurrency: 'USD',
      exchangeRate: 10,
      budget: { enabled: true, amount: 100, period: 'month', customStart: null, customEnd: null, detail: true },
      ...(overrides.config ?? {}),
    },
    days: {
      '2026-11-01': {
        date: '2026-11-01',
        input: 100,
        output: 50,
        calls: 5,
        cost: 1,
        costCny: 10,
        costEur: 0.9,
        sessions: [{ id: 'session-a', title: 'A', at: 1, cost: 1, costCny: 10, costEur: 0.9 }],
      },
      [TODAY]: {
        date: TODAY,
        input: 200,
        output: 80,
        calls: 3,
        cost: 0.5,
        costCny: 5,
        costEur: 0.45,
        sessions: [{ id: 'session-b', title: 'B', at: 2, cost: 0.5, costCny: 5, costEur: 0.45 }],
      },
      ...(overrides.days ?? {}),
    },
    ...(overrides.extra ?? {}),
  }
}

function meterFor(data, options = {}) {
  const file = freshFile()
  writeFileSync(file, JSON.stringify(data))
  return createCostMeter({ file, now: fakeNow, cacheMs: 0, ...options })
}

test('resolveCostLedgerFile defaults to the cost-meter storage path', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home'
  try {
    assert.equal(resolveCostLedgerFile({}), join('/tmp/dsh-home', 'storages', 'cost-meter', 'ledger.json'))
    assert.equal(resolveCostLedgerFile({ costMeterFile: '/tmp/custom.json' }), '/tmp/custom.json')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('today/month/total and monthly budget are computed in the display currency', () => {
  const meter = meterFor(ledger())
  const snapshot = meter.snapshot()
  assert.equal(snapshot.available, true)
  assert.deepEqual(snapshot.currency, { code: 'CNY', symbol: '¥', decimals: 2 })
  assert.equal(snapshot.today.date, TODAY)
  assert.equal(snapshot.today.amount, 5)
  assert.equal(snapshot.month.amount, 15)
  assert.equal(snapshot.total.amount, 15)
  assert.equal(snapshot.budget.enabled, true)
  assert.equal(snapshot.budget.amount, 100)
  assert.equal(snapshot.budget.spent, 15)
  assert.equal(snapshot.budget.percent, 15)
  assert.equal(snapshot.budget.start, '2026-11-01')
  assert.equal(snapshot.budget.end, TODAY)
  assert.equal(snapshot.budget.periodKey, '2026-11')
  assert.equal(meter.sessionCost('session-b'), 5)
  assert.equal(meter.sessionCost('missing'), undefined)
})

test('day, all and custom budget periods use their own windows', () => {
  const day = meterFor(ledger({ config: { budget: { enabled: true, amount: 10, period: 'day' } } })).snapshot()
  assert.equal(day.budget.periodKey, TODAY)
  assert.equal(day.budget.spent, 5)
  assert.equal(day.budget.percent, 50)

  const all = meterFor(ledger({ config: { budget: { enabled: true, amount: 100, period: 'all' } } })).snapshot()
  assert.equal(all.budget.periodKey, 'all')
  assert.equal(all.budget.spent, 15)

  const custom = meterFor(
    ledger({ config: { budget: { enabled: true, amount: 10, period: 'custom', customStart: '2026-11-01', customEnd: '2026-11-01' } } }),
  ).snapshot()
  assert.equal(custom.budget.periodKey, '2026-11-01..2026-11-01')
  assert.equal(custom.budget.spent, 10)
  assert.equal(custom.budget.percent, 100)
  assert.equal(custom.budget.over, true)
})

test('USD display uses the pricing amount directly', () => {
  const usd = meterFor(ledger({ config: { currency: 'USD', symbol: '$', pricingCurrency: 'USD', exchangeRate: 1 } })).snapshot()
  assert.equal(usd.today.amount, 0.5)
  assert.equal(usd.budget.spent, 1.5)
})

test('a disabled budget still reports spend without a percentage', () => {
  const disabled = meterFor(ledger({ config: { budget: { enabled: false, amount: 100, period: 'month' } } })).snapshot()
  assert.equal(disabled.budget.enabled, false)
  assert.equal(disabled.budget.percent, 15)
  assert.equal(disabled.today.amount, 5)
})

test('missing, corrupt and version-mismatched ledgers degrade gracefully', () => {
  const missing = createCostMeter({ file: join(workspace, 'nope.json'), now: fakeNow })
  assert.equal(missing.snapshot().available, false)
  assert.match(missing.snapshot().reason, /not found/)

  const corrupt = createCostMeter({ file: freshFile(), now: fakeNow })
  writeFileSync(corrupt.file, '{not json')
  assert.equal(corrupt.snapshot().available, false)

  const wrongVersion = meterFor(ledger({ extra: { version: 2 } }))
  assert.equal(wrongVersion.snapshot().available, false)
  assert.match(wrongVersion.snapshot().reason, /unsupported ledger version/)
})

test('formatting helpers and cards include cost and budget', () => {
  assert.equal(formatMoney(12.3456, { symbol: '¥', decimals: 2 }), '¥12.35')
  assert.equal(formatPercent(12.34), '12.3%')
  assert.equal(formatPercent(null), '—')

  const snapshot = meterFor(ledger()).snapshot()
  const statusLine = formatCostStatusLine({ snapshot, sessionAmount: 5 })
  assert.match(statusLine, /Сегодня ¥5\.00/)
  assert.match(statusLine, /сессия ¥5\.00/)
  assert.match(statusLine, /бюджет 15\.0%/)

  const card = formatBudgetCard({ status: snapshot })
  assert.match(card, /Потрачено: ¥15\.00 из ¥100\.00/)
  assert.match(card, /Осталось: ¥85\.00/)
  assert.match(card, /Сегодня \(2026-11-09\): ¥5\.00/)

  const alert = formatBudgetAlertCard({ threshold: 80, status: snapshot })
  assert.match(alert, /80%/)
  assert.match(alert, /¥15\.00/)

  const digest = formatDigestCard({ date: '09.11.2026', sessions: [], usage: {}, cost: snapshot })
  assert.match(digest, /Сегодня ¥5\.00/)
  assert.match(digest, /Бюджет: 15\.0%/)
})

test('localDayKey matches the cost-meter calendar key', () => {
  assert.equal(localDayKey(new Date(2026, 10, 9, 23, 59)), '2026-11-09')
  assert.equal(localDayKey(new Date(2026, 0, 1, 0, 0)), '2026-01-01')
})
