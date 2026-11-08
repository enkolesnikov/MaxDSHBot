/**
 * DSH Web client bundle for dsh-max-notify.
 *
 * Hand-written classic script (no build step): the shell evaluates it with
 * `window.__ModuleLoader__` and the factory receives `require` for baseline
 * modules only. The component renders in the Plugins → bundle settings slot and
 * talks to the host route `/max-notify/settings.json` on the same origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-max-notify',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NAME = 'dsh-max-notify'

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0', color: 'inherit', maxWidth: 760 },
      section: { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 12, border: '1px solid var(--dsh-border, #333)', background: 'color-mix(in srgb, currentColor 3%, transparent)' },
      title: { margin: 0, fontSize: 15, opacity: 0.9 },
      row: { display: 'grid', gridTemplateColumns: 'minmax(180px, 260px) 1fr', gap: 10, alignItems: 'center' },
      label: { fontSize: 13, opacity: 0.8 },
      input: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #444)', background: 'var(--dsh-input-bg, rgba(255,255,255,0.04))', color: 'inherit', fontSize: 13 },
      select: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #444)', background: 'var(--dsh-input-bg, rgba(255,255,255,0.04))', color: 'inherit', fontSize: 13 },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
      button: { alignSelf: 'flex-start', padding: '8px 18px', borderRadius: 9, border: 'none', background: '#7c5cff', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
      hint: { fontSize: 12, opacity: 0.6, margin: 0 },
      ok: { fontSize: 12, color: '#2ecc71' },
      error: { fontSize: 12, color: '#ff6b6b' },
    }

    async function request(method, body) {
      const response = await fetch('/max-notify/settings.json', {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = { ok: false, error: `HTTP ${response.status}` }
      }
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      return payload
    }

    function Field(props) {
      return h('label', { style: styles.row },
        h('span', { style: styles.label }, props.label),
        props.children)
    }

    function Toggle(props) {
      return h('label', { style: styles.check },
        h('input', { type: 'checkbox', checked: props.value === true, onChange: (event) => props.onChange(event.target.checked) }),
        props.label)
    }

    function SettingsPage() {
      const [state, setState] = React.useState({ status: 'loading' })
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        request('GET')
          .then((payload) => {
            if (!alive) return
            setDraft(payload.values || {})
            setState({ status: 'ready', statusInfo: payload.status, version: payload.version })
          })
          .catch((error) => {
            if (alive) setState({ status: 'error', message: error.message })
          })
        return () => { alive = false }
      }, [])

      const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

      const save = async (event) => {
        event.preventDefault()
        setNotice(null)
        try {
          const payload = await request('POST', draft)
          setDraft(payload.values || draft)
          setNotice(payload.restartRequired ? 'Сохранено. Изменения применятся после перезагрузки плагина (HMR/рестарт DSH).' : 'Сохранено.')
        } catch (error) {
          setNotice(`Ошибка: ${error.message}`)
        }
      }

      if (state.status === 'loading') return h('p', { style: styles.hint }, 'Загрузка настроек…')
      if (state.status === 'error') return h('p', { style: styles.error }, `Не удалось загрузить настройки: ${state.message}`)

      const quiet = draft.quietHours || {}

      return h('form', { onSubmit: save, style: styles.page },
        h('p', { style: styles.hint }, `dsh-max-notify ${state.version || ''} · транспорт: ${state.statusInfo?.transport || '—'} · подписка webhook: ${state.statusInfo?.webhookSubscribed ? 'да' : 'нет/не используется'}`),

        h('section', { style: styles.section },
          h('h4', { style: styles.title }, 'Уведомления'),
          h(Field, { label: 'Режим' },
            h('select', { style: styles.select, value: draft.mode || 'all', onChange: (e) => update('mode', e.target.value) },
              h('option', { value: 'all' }, 'все'),
              h('option', { value: 'errors' }, 'только ошибки'),
              h('option', { value: 'mute' }, 'тишина'))),
          h(Toggle, { label: 'Push-уведомления (notify)', value: draft.notify !== false, onChange: (v) => update('notify', v) }),
          h(Field, { label: 'Дайджест' },
            h('span', { style: styles.check },
              h('input', { type: 'checkbox', checked: draft.digestEnabled === true, onChange: (e) => update('digestEnabled', e.target.checked) }),
              h('input', { type: 'time', style: styles.input, value: draft.digestTime || '21:00', onChange: (e) => update('digestTime', e.target.value) }))),
          h(Field, { label: 'Тихие часы' },
            h('span', { style: styles.check },
              h('input', { type: 'time', style: styles.input, value: quiet.start || '23:00', onChange: (e) => update('quietHours', { ...quiet, start: e.target.value }) }),
              h('span', { style: styles.hint }, '—'),
              h('input', { type: 'time', style: styles.input, value: quiet.end || '08:00', onChange: (e) => update('quietHours', { ...quiet, end: e.target.value }) })))),

        h('section', { style: styles.section },
          h('h4', { style: styles.title }, 'Ответы и файлы'),
          h(Toggle, { label: 'Reply-ветки сессий', value: draft.threads !== false, onChange: (v) => update('threads', v) }),
          h(Toggle, { label: 'Markdown-таблицы файлами', value: draft.tableFiles !== false, onChange: (v) => update('tableFiles', v) }),
          h(Field, { label: 'Максимум таблиц' },
            h('input', { type: 'number', min: 0, max: 8, style: styles.input, value: draft.tableMaxFiles ?? 4, onChange: (e) => update('tableMaxFiles', Number(e.target.value)) })),
          h(Toggle, { label: 'Приём файлов из MAX', value: draft.receiveFiles !== false, onChange: (v) => update('receiveFiles', v) }),
          h(Toggle, { label: 'Нативные входящие изображения', value: draft.nativeIncomingImages === true, onChange: (v) => update('nativeIncomingImages', v) })),

        h('section', { style: styles.section },
          h('h4', { style: styles.title }, 'Голос'),
          h(Toggle, { label: 'Расшифровывать голосовые (STT)', value: draft.voiceTranscribe === true, onChange: (v) => update('voiceTranscribe', v) }),
          h(Field, { label: 'OpenAI-совместимый endpoint' },
            h('input', { type: 'url', placeholder: 'https://api.openai.com/v1', style: styles.input, value: draft.voiceEndpoint || '', onChange: (e) => update('voiceEndpoint', e.target.value || null) })),
          h(Field, { label: 'Модель' },
            h('input', { type: 'text', placeholder: 'whisper-1', style: styles.input, value: draft.voiceModel || '', onChange: (e) => update('voiceModel', e.target.value) }))),

        h('section', { style: styles.section },
          h('h4', { style: styles.title }, 'Озвучка ответов (TTS)'),
          h(Toggle, { label: 'Озвучивать финальные ответы', value: draft.voiceTts === true, onChange: (v) => update('voiceTts', v) }),
          h(Field, { label: 'Режим' },
            h('select', { style: styles.select, value: draft.voiceTtsMode || 'short', onChange: (e) => update('voiceTtsMode', e.target.value) },
              h('option', { value: 'off' }, 'выкл'),
              h('option', { value: 'short' }, 'только короткие'),
              h('option', { value: 'always' }, 'все ответы'))),
          h(Field, { label: 'Голос' },
            h('input', { type: 'text', placeholder: 'alloy', style: styles.input, value: draft.voiceTtsVoice || '', onChange: (e) => update('voiceTtsVoice', e.target.value) })),
          h(Field, { label: 'Модель TTS' },
            h('input', { type: 'text', placeholder: 'gpt-4o-mini-tts', style: styles.input, value: draft.voiceTtsModel || '', onChange: (e) => update('voiceTtsModel', e.target.value) })),
          h(Field, { label: 'Лимит символов' },
            h('input', { type: 'number', min: 20, max: 2000, style: styles.input, value: draft.voiceTtsMaxChars ?? 600, onChange: (e) => update('voiceTtsMaxChars', Number(e.target.value)) }))),

        h('section', { style: styles.section },
          h('h4', { style: styles.title }, 'Интерактив'),
          h(Field, { label: 'Таймаут approvals, мс' },
            h('input', { type: 'number', min: 0, max: 600000, step: 1000, style: styles.input, value: draft.approvalTimeoutMs ?? 120000, onChange: (e) => update('approvalTimeoutMs', Number(e.target.value)) })),
          h(Toggle, { label: 'Live-прогресс', value: draft.progress !== false, onChange: (v) => update('progress', v) }),
          h(Toggle, { label: 'Typing-индикатор', value: draft.typing !== false, onChange: (v) => update('typing', v) })),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('button', { type: 'submit', style: styles.button }, 'Сохранить'),
          notice ? h('span', { style: notice.startsWith('Ошибка') ? styles.error : styles.ok }, notice) : null),
        h('p', { style: styles.hint }, 'Секреты (токен бота, webhook secret, API-ключи) здесь не редактируются — они остаются в приватном cordis.patch.yml / .env.'),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: NAME,
        inject: () => ({}),
      }, SettingsPage)), 'dsh-max-notify: settings page')
    }

    return { name: NAME, inject: ['slots'], apply }
  },
})
