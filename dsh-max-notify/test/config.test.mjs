import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig } from '../lib/config.mjs'
import { SETTINGS_DEFAULTS, SETTINGS_KEYS } from '../lib/settings-validate.mjs'

// A complete target so normalizeConfig does not depend on token/chat env vars.
const base = { botToken: 't', chatId: '1' }

test('config defaults match the GUI overlay defaults for shared keys (no drift)', () => {
  // quietHours differs on purpose: the config default is unset (undefined), the
  // overlay stores null for "disabled"; both mean the same thing to the policy.
  for (const key of Object.keys(SETTINGS_KEYS)) {
    assert.equal(Object.hasOwn(DEFAULTS, key), true, `config DEFAULTS is missing ${key}`)
    if (key === 'quietHours') continue
    assert.deepEqual(DEFAULTS[key], SETTINGS_DEFAULTS[key], `default drift for ${key}`)
  }
  assert.equal(DEFAULTS.quietHours, undefined)
  assert.equal(SETTINGS_DEFAULTS.quietHours, null)
})

test('normalizeConfig rejects invalid quiet hours, digest time and message style', () => {
  // Values the strict GUI overlay rejects must not survive in the private
  // profile (P2 normalization drift: 25:00, 99:99, arbitrary messageStyle).
  const invalid = normalizeConfig({
    ...base,
    quietHours: { start: '25:00', end: '06:00' },
    digestTime: '99:99',
    messageStyle: 'fancy',
  })
  assert.equal(invalid.quietHours, undefined)
  assert.equal(invalid.digestTime, DEFAULTS.digestTime)
  assert.equal(invalid.digestTime, '21:00')
  assert.equal(invalid.messageStyle, 'compact')

  // Other shapes the overlay rejects: missing end, one-digit clock, non-string
  // style, out-of-range times, a non-HH:MM mode value.
  const more = normalizeConfig({
    ...base,
    quietHours: { start: '22:00' },
    digestTime: '7:5',
    messageStyle: 42,
    mode: 'quiet',
  })
  assert.equal(more.quietHours, undefined)
  assert.equal(more.digestTime, '21:00')
  assert.equal(more.messageStyle, 'compact')
  assert.equal(more.mode, 'all')

  const badEnd = normalizeConfig({ ...base, digestTime: '24:00' })
  assert.equal(badEnd.digestTime, '21:00')
  const badQuietHours = normalizeConfig({ ...base, quietHours: { start: '22:00', end: '24:00' } })
  assert.equal(badQuietHours.quietHours, undefined)
})

test('normalizeConfig accepts and normalizes valid overlay values', () => {
  const config = normalizeConfig({
    ...base,
    quietHours: { start: '22:30', end: '06:15' },
    digestTime: '07:05',
    messageStyle: ' DETAILED ',
  })
  assert.deepEqual(config.quietHours, { start: '22:30', end: '06:15' })
  assert.equal(config.digestTime, '07:05')
  assert.equal(config.messageStyle, 'detailed')

  // The overlay semantics: an enum is trimmed/lowercased, null disables quiet
  // hours, and the messageStyle default is compact.
  assert.equal(normalizeConfig({ ...base, mode: ' ERRORS ' }).mode, 'errors')
  assert.equal(normalizeConfig({ ...base, quietHours: null }).quietHours, undefined)
  assert.equal(normalizeConfig({ ...base }).messageStyle, 'compact')
})

test('normalizeConfig validates buttonsPresets with the same rules as the overlay', () => {
  // Bare strings are no longer accepted (they bypassed the prompt limit).
  assert.deepEqual(normalizeConfig({ ...base, buttonsPresets: ['дай ещё', 'объясни'] }).buttonsPresets, [])
  // Non-array and oversized arrays fall back to the default.
  assert.deepEqual(normalizeConfig({ ...base, buttonsPresets: 'nope' }).buttonsPresets, [])
  assert.deepEqual(
    normalizeConfig({
      ...base,
      buttonsPresets: Array.from({ length: 7 }, (_, index) => ({ label: `l${index}`, prompt: 'p' })),
    }).buttonsPresets,
    [],
  )
  // Per-item limits: label 1..40, prompt 1..500 characters.
  assert.deepEqual(normalizeConfig({ ...base, buttonsPresets: [{ label: 'l', prompt: 'p'.repeat(501) }] }).buttonsPresets, [])
  assert.deepEqual(normalizeConfig({ ...base, buttonsPresets: [{ label: 'x'.repeat(41), prompt: 'p' }] }).buttonsPresets, [])
  assert.deepEqual(normalizeConfig({ ...base, buttonsPresets: [{ label: '', prompt: 'p' }] }).buttonsPresets, [])
  // Valid presets are trimmed and kept.
  assert.deepEqual(
    normalizeConfig({ ...base, buttonsPresets: [{ label: ' Ok ', prompt: ' Do it ' }] }).buttonsPresets,
    [{ label: 'Ok', prompt: 'Do it' }],
  )
  const six = Array.from({ length: 6 }, (_, index) => ({ label: `l${index}`, prompt: 'p' }))
  assert.deepEqual(normalizeConfig({ ...base, buttonsPresets: six }).buttonsPresets, six)
})

test('normalizeConfig parses booleans with fallback semantics', () => {
  assert.equal(normalizeConfig({ ...base, notify: 'off' }).notify, false)
  assert.equal(normalizeConfig({ ...base, notify: 'YES' }).notify, true)
  assert.equal(normalizeConfig({ ...base, notify: 0 }).notify, false)
  assert.equal(normalizeConfig({ ...base, notify: 1 }).notify, true)
  // Unknown values are ignored and the built-in default is used.
  assert.equal(normalizeConfig({ ...base, notify: 'maybe' }).notify, DEFAULTS.notify)
  assert.equal(normalizeConfig({ ...base, notify: 'maybe' }).notify, true)
})

test('insecureVoiceEndpoint is an explicit opt-in and defaults to false', () => {
  assert.equal(DEFAULTS.insecureVoiceEndpoint, false)
  assert.equal(normalizeConfig({ ...base }).insecureVoiceEndpoint, false)
  assert.equal(normalizeConfig({ ...base, insecureVoiceEndpoint: true }).insecureVoiceEndpoint, true)
  // The unified parser accepts the same spellings as every other boolean.
  assert.equal(normalizeConfig({ ...base, insecureVoiceEndpoint: 'on' }).insecureVoiceEndpoint, true)
  assert.equal(normalizeConfig({ ...base, insecureVoiceEndpoint: '0' }).insecureVoiceEndpoint, false)
  assert.equal(normalizeConfig({ ...base, insecureVoiceEndpoint: 'nope' }).insecureVoiceEndpoint, false)
})

test('webhook entry byte cap is clamped to the queue byte cap, defaults unchanged', () => {
  // Public defaults stay 64KiB entry / 8MiB queue.
  assert.equal(DEFAULTS.webhookEntryBytesMax, 64 * 1024)
  assert.equal(DEFAULTS.webhookQueueBytesMax, 8 * 1024 * 1024)

  // An entry cap above the queue budget is clamped down to it.
  const clamped = normalizeConfig({ ...base, webhookEntryBytesMax: 1024 * 1024, webhookQueueBytesMax: 64 * 1024 })
  assert.equal(clamped.webhookQueueBytesMax, 64 * 1024)
  assert.equal(clamped.webhookEntryBytesMax, 64 * 1024)

  // A deliberately smaller HTTP body cap is preserved (it may be stricter).
  const smaller = normalizeConfig({ ...base, webhookEntryBytesMax: 32 * 1024 })
  assert.equal(smaller.webhookEntryBytesMax, 32 * 1024)
  assert.equal(smaller.webhookQueueBytesMax, DEFAULTS.webhookQueueBytesMax)

  // Defaults are not drifting through normalization.
  const defaults = normalizeConfig({ ...base })
  assert.equal(defaults.webhookEntryBytesMax, DEFAULTS.webhookEntryBytesMax)
  assert.equal(defaults.webhookQueueBytesMax, DEFAULTS.webhookQueueBytesMax)
})
