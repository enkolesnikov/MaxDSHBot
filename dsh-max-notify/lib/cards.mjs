/**
 * Message cards for the MAX remote control ("Пульт"): approvals, agent
 * questions, status, session list, help and delivery summaries.
 *
 * MAX markdown supports bold/italic/inline code/links, but NOT lists or
 * tables — cards use plain lines and numbered prefixes.
 */

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
  const where = by === 'gui' ? ' (в GUI)' : by === 'max' ? ' (в MAX)' : ''
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
