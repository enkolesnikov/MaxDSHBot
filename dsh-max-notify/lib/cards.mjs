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
export function formatApprovalCard({ title, toolName, reason, callId } = {}) {
  const lines = ['🔐 **Требуется разрешение**', '']
  lines.push(`🔧 Инструмент: \`${toolName || '?'}\``)
  if (reason) lines.push(`📝 Причина: ${truncate(reason, 500)}`)
  if (title) lines.push(`🗂 Сессия: ${truncate(title, 120)}`)
  if (callId) lines.push(`🆔 \`${truncate(String(callId), 40)}\``)
  lines.push('', 'Разрешить выполнение?')
  return lines.join('\n')
}

/** Final state of an approval card after a decision. */
export function formatApprovalResult({ outcome, toolName, by } = {}) {
  const label =
    outcome === 'allowed-once'
      ? '✅ **Разрешено**'
      : outcome === 'rejected'
        ? '⛔ **Отклонено**'
        : outcome === 'cancelled'
          ? '⏹ **Отменено**'
          : '⚠️ **Решение недоступно**'
  const where =
    by === 'gui'
      ? ' (в GUI)'
      : by === 'max'
        ? ' (в MAX)'
        : by === 'timeout'
          ? ' (таймаут)'
          : by === 'rule'
            ? ' (авто-правило)'
            : ''
  return `${label}${where}${toolName ? `\n\n🔧 ${toolName}` : ''}`
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
  const lines = ['🤖 **Статус**', '']
  lines.push(`🗂 Сессия: ${truncate(title || '—', 160)} \`${shortSessionId(sessionId)}\``)
  lines.push(`⚙️ Состояние: ${runnerLabel({ running, agentStatus })}`)
  if (model) lines.push(`🧠 Модель: \`${provider ? `${provider}/` : ''}${model}\``)
  if (cwd) lines.push(`📁 Папка: \`${truncate(cwd, 200)}\``)
  if (updatedAt) lines.push(`🕒 Обновлена: ${clock(updatedAt)}`)
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

/** Command help card. */
export function formatHelpCard() {
  return [
    '🕹 **Пульт DSH**',
    '',
    '`/status` — статус активной сессии',
    '`/stop` — остановить текущий ход',
    '`/sessions` — список сессий',
    '`/use N` — выбрать сессию',
    '`/current` — текущая сессия',
    '`/new [папка]` — новая сессия (папка создаётся)',
    '`/model [N|provider/model]` — модель сессии',
    '`/rename <название>` — переименовать сессию',
    '`/fork` — ответвить сессию',
    '`/compact` — сжать историю',
    '`/plan` / `/plan off` — режим плана',
    '`/search <текст>` — поиск по сессиям',
    '`/archive` — архивировать текущую, `/pin` / `/unpin`',
    '`/workspace` — папки, `/workspace N` — папка для `/new`',
    '`/approve` — политика подтверждений',
    '`/mode [all|errors|mute]` — режим уведомлений',
    '`/mute [30m|2h]` — тишина, `/unmute` — вернуть',
    '`/budget` — стоимость и бюджет',
    '`/digest` — дайджест сейчас',
    '`/help` — эта справка',
    '',
    'Просто текст — отправится агенту как следующее сообщение. Под ответом есть кнопки «Продолжить»/«Стоп».',
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
export function formatSubagentCard({ title, childId, stopReason, excerpt } = {}) {
  const lines = ['🤖 **Дочерний агент завершён**', '']
  if (title) lines.push(`🗂 Родитель: ${truncate(title, 120)}`)
  if (childId) lines.push(`🧩 Дочерний: \`${truncate(String(childId), 40)}\``)
  if (stopReason) lines.push(`🏁 Итог: \`${truncate(String(stopReason), 60)}\``)
  if (excerpt) lines.push('', `💬 ${truncate(excerpt, 500)}`)
  return lines.join('\n')
}

/** Background job settled. */
export function formatJobCard({ job } = {}) {
  const status = job?.status ?? 'settled'
  const icon = status === 'completed' ? '✅' : status === 'killed' ? '⏹' : status === 'failed' ? '❌' : 'ℹ️'
  const lines = [`${icon} **Фоновая задача: ${status}**`, '']
  if (job?.label) lines.push(`🏷 ${truncate(job.label, 120)}`)
  if (job?.id) lines.push(`🆔 \`${truncate(String(job.id), 60)}\``)
  if (job?.detail) lines.push(`📝 ${truncate(job.detail, 300)}`)
  return lines.join('\n')
}

/** Goal lifecycle change. */
export function formatGoalCard({ title, goal, operation } = {}) {
  const phase = goal?.phase ?? 'active'
  const icon = GOAL_ICON[phase] ?? '🎯'
  const lines = [`${icon} **Цель: ${phase}**${operation ? ` (${operation})` : ''}`, '']
  if (goal?.objective) lines.push(`🎯 ${truncate(goal.objective, 500)}`)
  if (goal?.maxGoalRounds !== undefined) {
    lines.push(`🔁 Раундов: ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds}`)
  }
  if (goal?.blockedReason?.message) lines.push(`⛔ ${truncate(goal.blockedReason.message, 300)}`)
  if (title) lines.push(`🗂 Сессия: ${truncate(title, 120)}`)
  return lines.join('\n')
}

/** Agent failure. */
export function formatErrorCard({ title, turn, step, error } = {}) {
  const message =
    typeof error === 'string' ? error : (error && (error.message || error.toString?.())) || 'неизвестная ошибка'
  const lines = ['❌ **Ошибка агента**', '']
  if (turn !== undefined || step !== undefined) lines.push(`📍 Ход ${turn ?? '?'}, шаг ${step ?? '?'}`)
  if (title) lines.push(`🗂 Сессия: ${truncate(title, 120)}`)
  lines.push('', `\`${truncate(message, 800)}\``)
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

/** Daily digest. */
export function formatDigestCard({ date, sessions = [], usage, goals = [], todos = [], cost } = {}) {
  const lines = [`📊 **Дайджест DSH** · ${date ?? ''}`, '']
  lines.push(`🗂 Активных сессий за сутки: ${sessions.length}`)
  for (const session of sessions.slice(0, 4)) {
    const mark = session.running ? ' 🟢' : ''
    lines.push(`• ${truncate(session.title || shortSessionId(session.sessionId), 80)}${mark}`)
  }
  if (usage && (usage.input || usage.output || usage.total)) {
    const total = usage.total || usage.input + usage.output
    lines.push('', `🧮 Токены (live): in ${usage.input ?? 0} · out ${usage.output ?? 0} · всего ${total}`)
  }
  if (cost?.available) {
    const currency = cost.currency ?? {}
    lines.push('', `💰 Сегодня ${formatMoney(cost.today?.amount, currency)} · месяц ${formatMoney(cost.month?.amount, currency)}`)
    if (cost.budget?.enabled && cost.budget.percent !== null) {
      lines.push(
        `📊 Бюджет: ${formatPercent(cost.budget.percent)} (${formatMoney(cost.budget.spent, currency)}/${formatMoney(cost.budget.amount, currency)})`,
      )
    }
  }
  const activeGoals = goals.filter((goal) => goal?.phase && goal.phase !== 'complete')
  if (activeGoals.length > 0) {
    lines.push('', `🎯 Цели: ${activeGoals.length}`)
    for (const goal of activeGoals.slice(0, 3)) {
      lines.push(`• ${GOAL_ICON[goal.phase] ?? '🎯'} ${truncate(goal.objective ?? '', 120)}`)
    }
  }
  const todoSummaries = todos.filter((entry) => entry.todos?.length > 0)
  if (todoSummaries.length > 0) {
    lines.push('', '📋 Задачи:')
    for (const entry of todoSummaries.slice(0, 3)) {
      const completed = entry.todos.filter((item) => item?.status === 'completed').length
      lines.push(`• ${truncate(entry.title || '—', 80)}: ${completed}/${entry.todos.length}`)
    }
  }
  lines.push('', 'Подробнее: `/status`, `/sessions`.')
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

/** Approval policy card. */
export function formatApprovalPolicyCard({ policy, override, title } = {}) {
  const lines = ['🔐 **Политика подтверждений**', '']
  if (title) lines.push(`🗂 Сессия: ${truncate(title, 120)}`)
  lines.push(`Текущая: \`${policy ?? 'ask'}\`${override ? ' (явно задана для сессии)' : ' (по умолчанию)'}`)
  lines.push('', '`/approve ask` — спрашивать, `/approve never` — не спрашивать (с подтверждением).')
  return lines.join('\n')
}
