/**
 * Message cards for the MAX remote control ("Пульт"): approvals, agent
 * questions, status, session list, help and delivery summaries.
 *
 * MAX markdown supports bold/italic/inline code/links, but NOT lists or
 * tables — cards use plain lines and numbered prefixes.
 */

import { formatMoney, formatPercent } from './cost-meter.mjs'

/** Trim a string to `max` characters with an ellipsis. */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/** Short session tag: last 8 characters of the id. */
export function shortSessionId(sessionId) {
  const value = String(sessionId ?? '')
  return value.length > 8 ? value.slice(-8) : value || '?'
}

function clock(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function folderOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const normalized = cwd.replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).pop() || normalized
}

/** Approval card: one tool action waits for a decision. */
export function formatApprovalCard({ title, toolName, reason } = {}) {
  const lines = [`🔐 **Разрешить \`${truncate(toolName || '?', 40)}\`?**`]
  if (title) lines.push(`🗂 ${truncate(title, 100)}`)
  if (reason) lines.push(`📝 ${truncate(reason, 200)}`)
  return lines.join('\n')
}

/** Final state of an approval card after a decision. */
export function formatApprovalResult({ outcome, toolName, by } = {}) {
  const label =
    outcome === 'allowed-once'
      ? '✅ Разрешено'
      : outcome === 'rejected'
        ? '⛔ Отклонено'
        : outcome === 'cancelled'
          ? '⏹ Отменено'
          : '⚠️ Недоступно'
  const where =
    by === 'gui'
      ? ' (GUI)'
      : by === 'max'
        ? ' (MAX)'
        : by === 'timeout'
          ? ' (таймаут)'
          : by === 'rule'
            ? ' (правило)'
            : ''
  return `${label}${where}${toolName ? ` · ${truncate(toolName, 40)}` : ''}`
}

/** Question card (single or multiple questions). */
export function formatQuestionCard({ questions, answered = 0 } = {}) {
  const items = Array.isArray(questions) ? questions : []
  const lines = []
  if (items.length > 1) lines.push(`❓ **Вопросы агента** (${answered}/${items.length})`, '')
  items.forEach((question, index) => {
    const header = question?.header ? `${question.header}: ` : ''
    lines.push(`**${index + 1})** ${header}${truncate(question?.question ?? '', 900)}`)
    if (question?.detail) lines.push(`_${truncate(question.detail, 500)}_`)
    const options = Array.isArray(question?.options) ? question.options : []
    options.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}. ${truncate(option?.label ?? '', 300)}`)
    })
    if (question?.multiSelect) lines.push('   _(можно несколько: номера через пробел)_')
    lines.push('')
  })
  lines.push('Выбери кнопкой или ответь номером/текстом.')
  return lines.join('\n')
}

/** Status card. */
export function formatStatusCard({ title, sessionId, running, agentStatus, model, provider, cwd, updatedAt } = {}) {
  const lines = [`🤖 **${truncate(title || 'Сессия', 100)}**`]
  const state = `${runnerLabel({ running, agentStatus })}${model ? ` · \`${provider ? `${provider}/` : ''}${model}\`` : ''}`
  lines.push(state)
  if (cwd) lines.push(`📁 \`${truncate(cwd, 160)}\``)
  if (updatedAt) lines.push(`🕒 ${clock(updatedAt)}${sessionId ? ` · ${shortSessionId(sessionId)}` : ''}`)
  return lines.join('\n')
}

/** One-line cost summary for `/status`. */
export function formatCostStatusLine({ snapshot, sessionAmount } = {}) {
  if (!snapshot?.available) {
    return `💰 Стоимость: нет данных cost-meter${snapshot?.reason ? ` (${snapshot.reason})` : ''}`
  }
  const currency = snapshot.currency ?? {}
  const parts = [`💰 Сегодня ${formatMoney(snapshot.today?.amount, currency)}`]
  if (Number.isFinite(sessionAmount)) parts.push(`сессия ${formatMoney(sessionAmount, currency)}`)
  const budget = snapshot.budget
  if (budget?.enabled && budget.percent !== null) {
    parts.push(`бюджет ${formatPercent(budget.percent)}`)
  }
  return parts.join(' · ')
}

/** Budget card for `/budget`. */
export function formatBudgetCard({ status } = {}) {
  if (!status?.available) {
    return `💰 **Бюджет**\n\nДанные cost-meter недоступны${status?.reason ? `: ${status.reason}` : '.'}\nПроверь плагин dsh-cost-meter и его ledger.`
  }
  const currency = status.currency ?? {}
  const budget = status.budget ?? {}
  const today = status.today ?? {}
  const month = status.month ?? {}
  const total = status.total ?? {}
  const lines = ['💰 **Бюджет**', '']
  if (budget.enabled) {
    const percent = budget.percent
    const icon = percent === null ? '⚪' : percent >= 100 ? '🔴' : percent >= 80 ? '🟡' : '🟢'
    lines.push(`Потрачено: ${formatMoney(budget.spent, currency)} из ${formatMoney(budget.amount, currency)} (${formatPercent(percent)}) ${icon}`)
    lines.push(`Осталось: ${formatMoney(budget.remaining, currency)}`)
    lines.push(`Период: ${budget.period} (${budget.start}–${budget.end})`)
  } else {
    lines.push('Бюджет в cost-meter выключен — проценты и алерты не считаются.')
    lines.push('Включить: настройки dsh-cost-meter → Budget.')
  }
  lines.push('')
  lines.push(`Сегодня (${today.date ?? '—'}): ${formatMoney(today.amount, currency)}`)
  lines.push(`Месяц: ${formatMoney(month.amount, currency)} · всего: ${formatMoney(total.amount, currency)}`)
  return lines.join('\n')
}

/** Budget threshold alert. */
export function formatBudgetAlertCard({ threshold, status } = {}) {
  const budget = status?.budget ?? {}
  const currency = status?.currency ?? {}
  const icon = threshold >= 100 ? '🚨' : '⚠️'
  const label = threshold >= 100 ? 'Бюджет исчерпан' : 'Бюджет близко к лимиту'
  const lines = [`${icon} **${label}**`, '']
  lines.push(`Порог: ${threshold}% · потрачено ${formatPercent(budget.percent)}`)
  lines.push(`Сумма: ${formatMoney(budget.spent, currency)} из ${formatMoney(budget.amount, currency)}`)
  lines.push(`Период: ${budget.period} (${budget.start}–${budget.end})`)
  return lines.join('\n')
}

function runnerLabel({ running, agentStatus } = {}) {
  if (running || agentStatus === 'busy' || agentStatus === 'running') return '🟢 работает'
  if (agentStatus === 'error') return '🔴 ошибка'
  return '⚪ бездействует'
}

/** Session list card: numbered choices for `/use N`. */
export function formatSessionsCard({ items, activeId } = {}) {
  const sessions = Array.isArray(items) ? items : []
  if (sessions.length === 0) return '🗂 Сессий пока нет.'
  const lines = ['🗂 **Сессии**', '']
  sessions.forEach((item, index) => {
    const marker = item.sessionId === activeId ? '▶️' : '•'
    const state = item.running ? ' 🟢' : ''
    const title = item.title ? `«${truncate(item.title, 80)}»` : `\`${shortSessionId(item.sessionId)}\``
    const folder = folderOf(item.cwd)
    lines.push(`${marker} ${index + 1}) ${title}${state}${folder ? ` · ${folder}` : ''}`)
  })
  lines.push('', 'Выбери: `/use N` (или номер сообщением).')
  return lines.join('\n')
}

/** Compact help: the 12 everyday commands. */
export function formatHelpCard() {
  return [
    '🕹 **Пульт DSH**',
    '',
    '`/status` — сессия, модель, стоимость',
    '`/stop` — остановить ход',
    '`/sessions` · `/use N` — выбрать сессию',
    '`/new [папка]` — новая сессия',
    '`/model` — модель',
    '`/mode all|errors|mute` · `/mute 30m`',
    '`/budget` — деньги и бюджет',
    '`/schedules` — задачи',
    '`/health` — состояние плагина',
    '`/help all` — все команды',
    '',
    'Просто текст — отправится агенту.',
  ].join('\n')
}

/** Full help, including advanced/hidden commands. */
export function formatHelpAllCard() {
  return [
    '🕹 **Все команды**',
    '',
    '**Основные**',
    '`/status` · `/stop` · `/sessions` · `/use N` · `/new` · `/model`',
    '`/mode` · `/mute` · `/budget` · `/schedules` · `/health`',
    '',
    '**Сессии и проект**',
    '`/current` (алиас status) · `/rename` · `/fork` · `/compact`',
    '`/search` · `/archive` · `/pin` / `/unpin` · `/workspace`',
    '',
    '**Управление и файлы**',
    '`/approve` · `/schedules mode` · `/diff` · `/send`',
    '',
    '**Прочее**',
    '`/digest` · `/settings` · `/say` · `/version` · `/ping` · `/unmute`',
    '',
    'Скрытые команды работают, но не показываются в меню.',
  ].join('\n')
}

/** Deliverables summary text (files are sent as attachments). */
export function formatDeliverablesCard({ files } = {}) {
  const list = Array.isArray(files) ? files : []
  const names = list
    .slice(0, 5)
    .map((file) => `• \`${truncate(String(file.path ?? file), 80)}\``)
    .join('\n')
  return [`📎 **Файлы от агента** (${list.length})`, '', names].join('\n')
}

/** A short "prompt accepted" confirmation. */
export function formatAccepted({ title, text } = {}) {
  return `📨 Отправлено в ${title ? `«${truncate(title, 80)}»` : 'сессию'}:\n\n${truncate(text, 500)}`
}

// ── notifications ("Наблюдатель") ──────────────────────────────────────────

const TODO_ICON = { completed: '✅', in_progress: '🔄', pending: '⬜' }
const GOAL_ICON = { active: '🎯', paused: '⏸️', blocked: '⛔', complete: '✅' }

/** Subagent finished running. */
export function formatSubagentCard({ childId, stopReason, excerpt } = {}) {
  const parts = ['🤖 Дочерний агент', stopReason ? truncate(String(stopReason), 40) : '']
  if (childId) parts.push(truncate(String(childId), 30))
  if (excerpt) parts.push(truncate(excerpt, 140))
  return parts.filter(Boolean).join(' · ')
}

/** Background job settled. */
export function formatJobCard({ job } = {}) {
  const status = job?.status ?? 'settled'
  const icon = status === 'completed' ? '✅' : status === 'killed' ? '⏹' : status === 'failed' ? '❌' : 'ℹ️'
  const label = job?.label || job?.id || 'задача'
  return `${icon} Фоновая задача · ${truncate(String(label), 100)}`
}

/** Goal lifecycle change. */
export function formatGoalCard({ title, goal, operation } = {}) {
  const phase = goal?.phase ?? 'active'
  const icon = GOAL_ICON[phase] ?? '🎯'
  const objective = goal?.objective ? truncate(goal.objective, 120) : ''
  const parts = [`${icon} Цель: ${phase}${operation ? ` (${operation})` : ''}`]
  if (objective) parts.push(objective)
  if (title) parts.push(truncate(title, 80))
  return parts.join(' · ')
}

/** Agent failure. */
export function formatErrorCard({ title, turn, step, error } = {}) {
  const message =
    typeof error === 'string' ? error : (error && (error.message || error.toString?.())) || 'неизвестная ошибка'
  const lines = [`❌ Ошибка${title ? ` · ${truncate(title, 100)}` : ''}`]
  if (turn !== undefined || step !== undefined) lines.push(`📍 Ход ${turn ?? '?'}, шаг ${step ?? '?'}`)
  lines.push(truncate(message, 300))
  return lines.join('\n')
}

/** TODO list progress. */
export function formatTodoCard({ title, todos } = {}) {
  const items = Array.isArray(todos) ? todos : []
  const completed = items.filter((item) => item?.status === 'completed').length
  const lines = [`📋 **TODO: ${completed}/${items.length}**`, '']
  if (title) lines.push(`🗂 ${truncate(title, 120)}`, '')
  for (const item of items.slice(0, 10)) {
    const icon = TODO_ICON[item?.status] ?? '⬜'
    lines.push(`${icon} ${truncate(item?.content ?? '', 200)}`)
  }
  if (items.length > 10) lines.push(`… ещё ${items.length - 10}`)
  return lines.join('\n')
}

/** Daily digest / briefing. */
export function formatDigestCard({ date, sessions = [], usage, goals = [], todos = [], cost, pending } = {}) {
  const lines = [`📊 **Брифинг** · ${date ?? ''}`]
  const active = Array.isArray(sessions) ? sessions.filter((item) => item?.running).length : 0
  lines.push(`✅ Сделано: ${active} активных · ${sessions.length} сессий за сутки`)
  const approvals = Number(pending?.approvals) || 0
  const questions = Number(pending?.questions) || 0
  lines.push(
    approvals + questions > 0
      ? `⏳ Ждёт тебя: ${approvals} approval · ${questions} вопрос`
      : '⏳ Ждёт тебя: ничего',
  )
  if (cost?.available) {
    const currency = cost.currency ?? {}
    let money = `💰 Деньги: ${formatMoney(cost.today?.amount, currency)} сегодня`
    if (cost.budget?.enabled && cost.budget.percent !== null) money += ` · бюджет ${formatPercent(cost.budget.percent)}`
    lines.push(money)
  }
  const goalsCount = Array.isArray(goals) ? goals.filter((goal) => goal?.phase && goal.phase !== 'complete').length : 0
  const todoCount = Array.isArray(todos) ? todos.filter((entry) => entry.todos?.length > 0).length : 0
  if (goalsCount + todoCount > 0) lines.push(`🎯 Дальше: ${goalsCount} целей · ${todoCount} TODO`)
  if (usage && (usage.input || usage.output || usage.total)) {
    const total = usage.total || usage.input + usage.output
    lines.push(`🧮 Токены: ${total}`)
  }
  return lines.join('\n')
}

/** Model picker card for `/model`. */
export function formatModelsCard({ current, models, failures = [] } = {}) {
  const list = Array.isArray(models) ? models : []
  const lines = ['🧠 **Модели**', '']
  if (current?.model) {
    lines.push(
      `Текущая: \`${current.provider ? `${current.provider}/` : ''}${current.model}${current.reasoningEffort ? ` · ${current.reasoningEffort}` : ''}\``,
      '',
    )
  }
  if (list.length === 0) lines.push('Каталог моделей недоступен.')
  else {
    list.forEach((item, index) => {
      const mark = current && item.provider === current.provider && item.model === current.model ? ' ▶️' : ''
      lines.push(`${index + 1}) \`${item.provider}/${item.model}\` — ${truncate(item.name ?? item.model, 80)}${mark}`)
    })
    lines.push('', 'Выбери: `/model N` или `/model provider/model`.')
  }
  if (failures.length > 0) {
    lines.push('', `⚠️ Провайдеры с ошибкой: ${failures.map((item) => item.id).join(', ')}`)
  }
  return lines.join('\n')
}

/** Search results card. */
export function formatSearchCard({ query, items } = {}) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return `🔎 По запросу «${truncate(query ?? '', 80)}» ничего не найдено.`
  const lines = [`🔎 **Поиск:** «${truncate(query ?? '', 80)}»`, '']
  list.forEach((item, index) => {
    lines.push(`${index + 1}) ${item.title ? `«${truncate(item.title, 80)}»` : `\`${shortSessionId(item.sessionId)}\``}`)
    if (item.snippet) lines.push(`   ${truncate(item.snippet.replace(/\s+/g, ' '), 200)}`)
  })
  lines.push('', 'Выбрать: `/use N`.')
  return lines.join('\n')
}

/** Workspace (folder) list card for `/workspace`. */
export function formatWorkspacesCard({ items, activePath } = {}) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return '📁 Рабочих папок пока нет. Добавь: `/workspace add /path/to/dir`.'
  const lines = ['📁 **Рабочие папки**', '']
  list.forEach((item, index) => {
    const mark = activePath && item.path === activePath ? ' ▶️' : ''
    lines.push(`${index + 1}) ${truncate(item.title || folderOf(item.path) || item.path, 80)} — \`${truncate(item.path, 200)}\`${mark}`)
  })
  lines.push('', 'Выбрать папку для `/new`: `/workspace N`. Добавить: `/workspace add <path>`.')
  return lines.join('\n')
}

/** Plan-mode status card. */
export function formatPlanStateCard({ active, pending, action } = {}) {
  const lines = ['🧭 **Режим плана**', '']
  lines.push(`Состояние: ${active ? 'включён' : 'выключен'}${pending ? ' (переключение в следующем шаге)' : ''}`)
  if (action) lines.push(`Действие: ${action}`)
  lines.push('', '`/plan` — включить, `/plan off` — выключить.')
  return lines.join('\n')
}

/** Read-only effective settings card for `/settings`. */
export function formatSettingsCard(settings = {}) {
  const lines = ['⚙️ **Настройки**', '']
  lines.push(`${settings.version ?? '?'} · ${settings.transport ?? 'polling'} · режим: ${settings.mode ?? '?'}`)
  lines.push(`allowlist: ${settings.allowlist?.users ?? 0} users / ${settings.allowlist?.chats ?? 0} chats`)
  lines.push(`reply-ветки: ${settings.threads ? 'вкл' : 'выкл'} · таблицы: ${settings.tableFiles ? 'вкл' : 'выкл'}`)
  lines.push(`approvals: ${settings.approvalTimeoutMs ? `${Math.round(settings.approvalTimeoutMs / 1000)} с` : 'выкл'} · файлы: ${settings.receiveFiles ? 'вкл' : 'выкл'}`)
  if (settings.voiceTts || settings.voiceTranscribe) lines.push(`голос: STT ${settings.voiceTranscribe ? 'вкл' : 'выкл'} · TTS ${settings.voiceTts ? 'вкл' : 'выкл'}`)
  lines.push('', 'Полный конфиг — в GUI плагина.')
  return lines.join('\n')
}

/** Approval policy card. */
export function formatApprovalPolicyCard({ policy, override, title } = {}) {
  const lines = ['🔐 **Политика подтверждений**', '']
  if (title) lines.push(`🗂 Сессия: ${truncate(title, 120)}`)
  lines.push(`Текущая: \`${policy ?? 'ask'}\`${override ? ' (явно задана для сессии)' : ' (по умолчанию)'}`)
  lines.push('', '`/approve ask` — спрашивать, `/approve never` — не спрашивать (с подтверждением).')
  return lines.join('\n')
}
