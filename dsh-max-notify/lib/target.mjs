/**
 * One definition of the MAX send-target query. Every outbound module used to
 * build `{chatId}`/`{userId}` itself; a single helper keeps the precedence and
 * the "no target" case consistent.
 */
export function targetQuery(target) {
  if (target?.chatId !== undefined && target?.chatId !== null) return { chatId: target.chatId }
  if (target?.userId !== undefined && target?.userId !== null) return { userId: target.userId }
  return {}
}
