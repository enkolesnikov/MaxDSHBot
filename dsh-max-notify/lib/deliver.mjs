/**
 * Final-message delivery pipeline (extracted from index.js, no behavior change).
 *
 * One completed agent turn is formatted, chunked under the MAX text limit and
 * sent; markdown tables are attached as CSV/Markdown files, images and the
 * inline keyboard ride on the last chunk, chunks are threaded under a
 * per-session anchor (and remember their mids), and when MAX is unavailable the
 * durable outbox queues each chunk for a later retry. An optional TTS audio
 * follows the text unless a chunk was queued. `dryRun` stops right after
 * formatting/chunking: nothing is sent and no attachment is collected.
 *
 * Every collaborator is injected so the pipeline can be exercised without the
 * plugin host (see index.js for the production wiring and
 * test/split-regression.test.mjs for a focused dry-run test).
 */
export function createDeliver({
  client,
  config,
  logger,
  state,
  policy,
  ensureTargetAllowed = async () => true,
  resolveTitle = () => undefined,
  formatNotification,
  splitText,
  maxTextLimit,
  buildTableFiles,
  finalKeyboard,
  collectFinalImages,
  outbox,
  shouldSpeak,
  synthesizeSpeech,
  uploadAndSendAudio,
  noteSession,
} = {}) {
  /**
   * @param {object} session - session whose answer is being delivered.
   * @param {string} text - final assistant text.
   * @param {object} [reason] - `turn/end` reason (marks aborted turns).
   * @param {object} [message] - final assistant message (image blocks).
   * @param {Array<object>} [toolImageRefs] - image refs collected during the turn.
   * @param {number|string} [turn] - turn number for the outbox dedupe key.
   * @param {number} [seq] - assistant message sequence for the dedupe key.
   */
  return async function deliver(session, text, reason, message, toolImageRefs = [], turn, seq) {
    if (!(await ensureTargetAllowed())) return
    const decision = policy.decide('final')
    if (!decision.send) {
      logger.debug('final reply suppressed (%s)', decision.reason)
      return
    }
    let displayText = text
    let tableAttachments = []
    if (config.tableFiles && config.tableMaxFiles > 0) {
      const tables = buildTableFiles(text, { maxTables: config.tableMaxFiles })
      if (tables.files.length > 0) {
        for (const file of tables.files) {
          try {
            const uploaded = await client.uploadMedia({
              buffer: Buffer.from(file.content, 'utf8'),
              filename: file.filename,
              type: 'file',
            })
            if (uploaded?.token) tableAttachments.push({ type: 'file', payload: { token: uploaded.token } })
          } catch (error) {
            logger.warn('cannot upload %s to MAX: %s', file.filename, error?.message || String(error))
          }
        }
        if (tableAttachments.length > 0) displayText = tables.strippedText
      }
    }
    const payload = formatNotification({
      text: displayText,
      cwd: session?.header?.cwd,
      title: resolveTitle(session),
      sessionId: session?.id,
      reason,
      format: config.format,
      includeHeader: config.includeHeader,
      includeSessionId: config.includeSessionId,
      messageStyle: config.messageStyle,
    })
    const chunkLimit = Math.min(maxTextLimit, Math.max(200, Number(config.maxChars) || maxTextLimit))
    const chunks = splitText(payload, chunkLimit).slice(0, 8)
    if (config.dryRun) {
      logger.info('[dry-run] would send %d chunk(s) to MAX: %s', chunks.length, chunks[0]?.slice(0, 120))
      return
    }
    const keyboard = finalKeyboard(session)
    const images = await collectFinalImages(session, text, message, toolImageRefs)
    const attachments =
      images.length > 0 || tableAttachments.length > 0 || keyboard
        ? [...images, ...tableAttachments, ...(keyboard ?? [])]
        : undefined
    const finalKey = `final:${session?.id ?? 'unknown'}:${turn ?? 'na'}:${seq ?? 'na'}`
    let threadMid = config.threads ? state.getAnchor?.(session.id) : undefined
    let queuedAny = false
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1
      const params = {
        chatId: config.chatId,
        userId: config.chatId === undefined ? config.userId : undefined,
        text: chunk,
        format: config.format,
        notify: decision.notify,
        disableLinkPreview: config.disableLinkPreview,
        ...(isLast && attachments ? { attachments } : {}),
        ...(threadMid ? { link: { type: 'reply', mid: threadMid } } : {}),
      }
      let sent
      if (outbox) {
        const result = await outbox.deliverNow(params, { dedupeKey: `${finalKey}:c${index}`, kind: 'final' })
        if (result?.skipped) continue
        if (result?.queued) {
          queuedAny = true
          logger.warn('MAX is unavailable; final reply chunk %d queued: %s', index + 1, result.error)
          continue
        }
        sent = result?.response
      } else {
        sent = await client.sendMessage(params)
      }
      const mid = sent?.message?.body?.mid
      if (mid) {
        state.mapMessage?.(session.id, mid)
        if (!threadMid && config.threads) {
          threadMid = mid
          state.setAnchor?.(session.id, mid)
        }
      }
      logger.debug('MAX message sent%s', mid ? ` (mid ${mid})` : '')
    }
    if (config.voiceTts && !queuedAny && !config.dryRun) {
      const speak = shouldSpeak(text, config)
      if (speak.ok) {
        try {
          const audio = await synthesizeSpeech({
            text,
            endpoint: config.voiceTtsEndpoint || config.voiceEndpoint,
            apiKey: config.voiceTtsApiKey || config.voiceApiKey,
            model: config.voiceTtsModel,
            voice: config.voiceTtsVoice,
            format: config.voiceTtsFormat,
            speed: config.voiceTtsSpeed,
            maxChars: config.voiceTtsMaxChars,
          })
          if (audio.ok) {
            const result = await uploadAndSendAudio({
              buffer: audio.buffer,
              format: config.voiceTtsFormat,
              caption: '🔊',
              dedupeKey: `tts:${finalKey}`,
            })
            if (!result.ok) logger.warn('cannot send TTS audio: %s', result.error)
          } else {
            logger.warn('TTS failed: %s', audio.error)
          }
        } catch (error) {
          logger.warn('TTS failed: %s', error?.message || String(error))
        }
      }
    }
    noteSession?.(String(session.id))
  }
}
