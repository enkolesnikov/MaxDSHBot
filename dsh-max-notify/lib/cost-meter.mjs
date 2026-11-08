/**
 * Read-only adapter for the `dsh-cost-meter` ledger.
 *
 * The cost meter is a separate plugin; its durable ledger lives at
 * `$DSH_HOME/storages/cost-meter/ledger.json` (schema version 1) and is owned by
 * that plugin. This module never writes it: it reads the file (size-capped,
 * mtime-cached, tolerant to a write in progress) and derives:
 *  - today's / current-month / lifetime spend in the display currency;
 *  - per-session spend by DSH session id;
 *  - the budget period window, spend, remaining and percent.
 *
 * The budget math mirrors cost-meter: its `budgetUsed` is expressed in the
 * pricing currency and the UI compares `budgetUsed * exchangeRate` with
 * `budget.amount` in the display currency. Ledger `cost` fields are in the
 * pricing currency; `costCny`/`costEur` are pre-converted.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const LEDGER_VERSION = 1
const MAX_LEDGER_BYTES = 8 * 1024 * 1024
const SYMBOLS = { CNY: '¥', EUR: '€', USD: '$', RUB: '₽', GBP: '£' }

/** Resolve the ledger file: explicit config path, or the cost-meter default. */
export function resolveCostLedgerFile(config = {}) {
  if (typeof config.costMeterFile === 'string' && config.costMeterFile.trim() !== '') return config.costMeterFile
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'cost-meter', 'ledger.json')
}

/** Local calendar day key, matching cost-meter's `localDayKey`. */
export function localDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  const pad = (number) => String(number).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function currencyOfConfig(config = {}) {
  const code = String(config.currency ?? 'CNY').toUpperCase()
  return {
    code,
    symbol: typeof config.symbol === 'string' && config.symbol !== '' ? config.symbol : (SYMBOLS[code] ?? code),
    decimals: Number.isInteger(config.decimals) && config.decimals >= 0 ? config.decimals : 2,
    pricingCode: String(config.pricingCurrency ?? 'USD').toUpperCase(),
    exchangeRate: toNumber(config.exchangeRate, 1) > 0 ? toNumber(config.exchangeRate, 1) : 1,
  }
}

/** Convert one ledger amount (pricing currency) to the display currency. */
function displayAmount(entry, currency) {
  if (!entry || typeof entry !== 'object') return 0
  if (currency.code === 'CNY' && Number.isFinite(Number(entry.costCny))) return Number(entry.costCny)
  if (currency.code === 'EUR' && Number.isFinite(Number(entry.costEur))) return Number(entry.costEur)
  if (currency.code === currency.pricingCode) return toNumber(entry.cost)
  return toNumber(entry.cost) * currency.exchangeRate
}

/** Format an amount with the ledger's currency symbol/decimals. */
export function formatMoney(amount, currency = {}) {
  const value = toNumber(amount)
  const decimals = Number.isInteger(currency.decimals) ? currency.decimals : 2
  const symbol = typeof currency.symbol === 'string' && currency.symbol !== '' ? currency.symbol : ''
  return `${symbol}${value.toFixed(decimals)}`
}

export function formatPercent(percent) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) return '—'
  return `${Number(percent).toFixed(1)}%`
}

function sumDays(days, predicate, currency) {
  let amount = 0
  let calls = 0
  let input = 0
  let output = 0
  for (const [date, day] of Object.entries(days ?? {})) {
    if (!predicate(date, day)) continue
    amount += displayAmount(day, currency)
    calls += toNumber(day?.calls)
    input += toNumber(day?.input)
    output += toNumber(day?.output)
  }
  return { amount, calls, input, output }
}

function budgetWindow(budget, today) {
  const period = budget.period === 'day' || budget.period === 'all' || budget.period === 'custom' ? budget.period : 'month'
  const monthStart = `${today.slice(0, 7)}-01`
  if (period === 'day') return { period, start: today, end: today, periodKey: today }
  if (period === 'month') return { period, start: monthStart, end: today, periodKey: today.slice(0, 7) }
  if (period === 'all') return { period, start: '0000-01-01', end: today, periodKey: 'all' }
  const start = typeof budget.customStart === 'string' && budget.customStart !== '' ? budget.customStart : monthStart
  const end = typeof budget.customEnd === 'string' && budget.customEnd !== '' ? budget.customEnd : today
  return { period, start, end, periodKey: `${start}..${end}` }
}

/**
 * @param {object} options
 * @param {string} [options.file]
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {number} [options.cacheMs] - mtime-check throttle, default 1000 ms.
 */
export function createCostMeter({ file, logger, now = () => Date.now(), cacheMs = 1000 } = {}) {
  const path = file ?? resolveCostLedgerFile()
  let cache
  let cacheAt = 0
  let cacheMtime = 0

  function unavailable(reason) {
    return { available: false, reason, ledgerFile: path }
  }

  function build(ledger) {
    if (!ledger || typeof ledger !== 'object') return unavailable('ledger is not an object')
    if (ledger.version !== LEDGER_VERSION) return unavailable(`unsupported ledger version: ${ledger.version ?? '?'}`)
    const config = ledger.config ?? {}
    const currency = currencyOfConfig(config)
    const days = ledger.days && typeof ledger.days === 'object' ? ledger.days : {}
    const today = localDayKey(new Date(now()))
    const monthPrefix = today.slice(0, 7)
    const todaySum = sumDays(days, (date) => date === today, currency)
    const monthSum = sumDays(days, (date) => date.startsWith(monthPrefix), currency)
    const totalSum = sumDays(days, () => true, currency)

    const budgetConfig = config.budget ?? {}
    const enabled = budgetConfig.enabled === true
    const amount = Math.max(0, toNumber(budgetConfig.amount, 0))
    const window = budgetWindow(budgetConfig, today)
    const spent = window.period === 'all' ? totalSum.amount : sumDays(days, (date) => date >= window.start && date <= window.end, currency).amount
    const percent = amount > 0 ? (spent / amount) * 100 : null
    const budget = {
      enabled,
      amount,
      period: window.period,
      periodKey: window.periodKey,
      customStart: budgetConfig.customStart ?? null,
      customEnd: budgetConfig.customEnd ?? null,
      start: window.start,
      end: window.end,
      spent,
      remaining: Math.max(0, amount - spent),
      percent,
      over: percent !== null && percent >= 100,
      near: percent !== null && percent >= 80,
      detail: budgetConfig.detail !== false,
    }

    const sessionAmounts = {}
    for (const day of Object.values(days)) {
      const sessions = Array.isArray(day?.sessions) ? day.sessions : []
      for (const session of sessions) {
        const id = typeof session?.id === 'string' ? session.id : undefined
        if (!id) continue
        sessionAmounts[id] = toNumber(sessionAmounts[id]) + displayAmount(session, currency)
      }
    }

    return {
      available: true,
      ledgerFile: path,
      version: ledger.version,
      readAt: now(),
      currency: { code: currency.code, symbol: currency.symbol, decimals: currency.decimals },
      today: { date: today, amount: todaySum.amount, calls: todaySum.calls, input: todaySum.input, output: todaySum.output },
      month: { start: `${monthPrefix}-01`, amount: monthSum.amount },
      total: { amount: totalSum.amount },
      budget,
      sessionAmounts,
      days: Object.keys(days).length,
    }
  }

  function snapshot() {
    const at = now()
    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      return unavailable(error?.code === 'ENOENT' ? 'ledger not found' : `cannot stat ledger: ${error?.message || String(error)}`)
    }
    if (cache && at - cacheAt < cacheMs && stats.mtimeMs === cacheMtime) return cache
    if (stats.size > MAX_LEDGER_BYTES) return unavailable(`ledger is too large (${stats.size} bytes)`)
    try {
      const ledger = JSON.parse(readFileSync(path, 'utf8'))
      cache = build(ledger)
      cacheAt = at
      cacheMtime = stats.mtimeMs
      return cache
    } catch (error) {
      logger?.debug?.('cannot read cost-meter ledger %s: %s', path, error?.message || String(error))
      return {
        available: false,
        reason: `cannot read ledger: ${error?.message || String(error)}`,
        ledgerFile: path,
      }
    }
  }

  function sessionCost(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return undefined
    const value = snapshot()
    if (!value.available) return undefined
    const amount = value.sessionAmounts[id]
    return Number.isFinite(amount) ? amount : undefined
  }

  function budgetStatus() {
    const value = snapshot()
    if (!value.available) return { available: false, reason: value.reason, ledgerFile: value.ledgerFile }
    return { available: true, currency: value.currency, budget: value.budget, today: value.today, month: value.month, total: value.total }
  }

  return { snapshot, sessionCost, budgetStatus, file: path }
}
