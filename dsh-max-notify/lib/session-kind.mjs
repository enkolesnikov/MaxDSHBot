/**
 * Session-kind predicates shared by the notifier, progress cards, observer and
 * approval routing. The `Number.isFinite` guard is deliberate: a malformed
 * `delegationDepth` must not silently turn a subagent into a top-level session.
 */
export function isTopLevelSession(session) {
  const header = session?.header
  if (!header) return true
  if (header.origin === 'subagent') return false
  const depth = Number(header.delegationDepth ?? 0)
  return !(Number.isFinite(depth) && depth > 0)
}
