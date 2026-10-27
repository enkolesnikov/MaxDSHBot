/**
 * Pure helpers for turning DSH session events into the text a human should receive.
 *
 * A DSH session appends `assistant/message` events for each model step and
 * closes each user-visible turn with `turn/end` ({ turn, reason }). The plugin
 * keeps the latest assistant text per live session and forwards it when the
 * matching turn ends, which yields exactly "the last message of the agent"
 * once per turn instead of once per tool step.
 */

/** Visible text of an AssistantMessage (TextBlocks only; reasoning/tool blocks are skipped). */
export function extractAssistantText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/** Human-readable suffix for a turn/end reason (`completed` is implicit). */
export function describeReason(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  if (!kind || kind === 'completed') return ''
  if (kind === 'aborted') {
    const cause = typeof reason?.reason === 'string' ? reason.reason : reason?.reason?.kind
    return cause ? `прерван: ${cause}` : 'прерван'
  }
  if (kind === 'blocked') return 'заблокирован'
  return kind
}
