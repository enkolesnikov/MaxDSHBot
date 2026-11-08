import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteSchedule,
  describeSchedule,
  formatSchedulesCard,
  listSchedules,
  setScheduleActive,
} from '../lib/schedules.mjs'

/** Local-time ISO instant, so `ДД.ММ ЧЧ:ММ` assertions are timezone-independent. */
function localIso(year, month, day, hours, minutes) {
  return new Date(year, month - 1, day, hours, minutes).toISOString()
}

const WHEN = localIso(2026, 11, 8, 21, 30)

/** Fake schedule service that records requests and returns/throws configured values. */
function makeService({ listResult, editResult, listError, editError } = {}) {
  const calls = { list: [], edit: [] }
  const resolve = (value) => (typeof value === 'function' ? value() : value)
  return {
    calls,
    async list(request) {
      calls.list.push(request)
      if (listError) throw listError
      return resolve(listResult)
    },
    async edit(request) {
      calls.edit.push(request)
      if (editError) throw editError
      return resolve(editResult)
    },
  }
}

test('listSchedules normalizes entries and drops unknown fields', async () => {
  const service = makeService({
    listResult: {
      items: [
        {
          id: 'task-a',
          kind: 'after',
          title: 'Деплой',
          prompt: 'Проверь деплой',
          scheduledAt: WHEN,
          status: 'active',
          target: { kind: 'session', sessionId: 's1' },
          executionActive: true,
          updatedAt: '2026-11-08T15:00:00.000Z',
          extra: 'ignored',
        },
      ],
      total: 1,
      shown: 1,
    },
  })

  const result = await listSchedules(service)

  assert.deepEqual(result, {
    ok: true,
    total: 1,
    items: [
      {
        id: 'task-a',
        kind: 'after',
        title: 'Деплой',
        prompt: 'Проверь деплой',
        scheduledAt: WHEN,
        status: 'active',
        targetKind: 'session',
        executionActive: true,
        updatedAt: '2026-11-08T15:00:00.000Z',
      },
    ],
  })
  assert.deepEqual(service.calls.list, [{ limit: 50 }])
})

test('listSchedules tolerates missing fields and stringifies ids', async () => {
  const service = makeService({ listResult: { items: [{ id: 7 }, null] } })

  const result = await listSchedules(service)

  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.deepEqual(result.items[0], {
    id: '7',
    title: '',
    kind: '',
    prompt: '',
    scheduledAt: null,
    status: 'unknown',
    targetKind: '',
    executionActive: false,
    updatedAt: null,
  })
  assert.equal(result.items[1].id, '')
  assert.equal(result.items[1].status, 'unknown')
})

test('listSchedules passes active and clamps the page limit', async () => {
  const service = makeService({ listResult: { items: [], total: 0 } })

  await listSchedules(service, { active: true, limit: 10 })
  await listSchedules(service, { active: false, limit: 0 })
  await listSchedules(service, { limit: 1000 })
  await listSchedules(service, { limit: 12.5 })

  assert.deepEqual(service.calls.list, [
    { active: true, limit: 10 },
    { active: false, limit: 50 },
    { limit: 500 },
    { limit: 50 },
  ])
})

test('listSchedules falls back to item count and rejects non-object results', async () => {
  const fallback = await listSchedules(makeService({ listResult: { items: [{ id: 'a' }] } }))
  assert.equal(fallback.total, 1)

  const broken = await listSchedules(makeService({ listResult: undefined }))
  assert.equal(broken.ok, false)
  assert.match(broken.error, /некорректный ответ/)
})

test('listSchedules reports a missing service and service exceptions', async () => {
  const missing = await listSchedules(undefined)
  assert.equal(missing.ok, false)
  assert.match(missing.error, /dsh-schedule/)

  const failing = await listSchedules(makeService({ listError: new Error('boom') }))
  assert.deepEqual(failing, { ok: false, error: 'Не удалось получить список задач: boom' })
})

test('setScheduleActive pauses a task and forwards the revision', async () => {
  const service = makeService({ editResult: { id: 'task-a', status: 'paused' } })

  const result = await setScheduleActive(service, {
    id: '  task-a  ',
    active: false,
    expectedUpdatedAt: '2026-11-08T15:00:00.000Z',
  })

  assert.deepEqual(result, {
    ok: true,
    id: 'task-a',
    active: false,
    result: { id: 'task-a', status: 'paused' },
  })
  assert.deepEqual(service.calls.edit, [
    {
      id: 'task-a',
      action: 'update',
      patch: { active: false },
      expectedUpdatedAt: '2026-11-08T15:00:00.000Z',
    },
  ])
})

test('setScheduleActive resumes and omits an absent revision', async () => {
  const service = makeService({ editResult: { id: 'task-b', status: 'active' } })

  const result = await setScheduleActive(service, { id: 'task-b', active: true })

  assert.equal(result.ok, true)
  assert.equal(result.active, true)
  assert.deepEqual(service.calls.edit, [{ id: 'task-b', action: 'update', patch: { active: true } }])
})

test('setScheduleActive validates input before calling the service', async () => {
  const service = makeService({ editResult: { deleted: true } })

  const noId = await setScheduleActive(service, { id: '   ', active: true })
  assert.equal(noId.ok, false)
  assert.match(noId.error, /id/)

  const badActive = await setScheduleActive(service, { id: 'task-a', active: 'yes' })
  assert.equal(badActive.ok, false)
  assert.match(badActive.error, /boolean/)

  const badRevision = await setScheduleActive(service, {
    id: 'task-a',
    active: true,
    expectedUpdatedAt: 42,
  })
  assert.equal(badRevision.ok, false)
  assert.match(badRevision.error, /expectedUpdatedAt/)

  const missing = await setScheduleActive(undefined, { id: 'task-a', active: true })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /dsh-schedule/)

  assert.deepEqual(service.calls.edit, [])
})

test('setScheduleActive maps not-found and conflict codes', async () => {
  const notFound = await setScheduleActive(
    makeService({ editResult: { id: 'task-a', code: 'schedule_not_found' } }),
    { id: 'task-a', active: true },
  )
  assert.equal(notFound.ok, false)
  assert.equal(notFound.code, 'schedule_not_found')
  assert.equal(notFound.active, true)
  assert.match(notFound.error, /не найдена/i)

  const conflict = await setScheduleActive(
    makeService({ editResult: { id: 'task-a', code: 'schedule_conflict' } }),
    { id: 'task-a', active: false },
  )
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'schedule_conflict')
  assert.match(conflict.error, /изменилась/)

  const unknownCode = await setScheduleActive(
    makeService({ editResult: { id: 'task-a', code: 'invalid_rule' } }),
    { id: 'task-a', active: false },
  )
  assert.equal(unknownCode.ok, false)
  assert.equal(unknownCode.code, 'invalid_rule')
})

test('setScheduleActive reports service exceptions', async () => {
  const result = await setScheduleActive(makeService({ editError: new Error('offline') }), {
    id: 'task-a',
    active: true,
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /offline/)
})

test('deleteSchedule confirms a deletion', async () => {
  const service = makeService({ editResult: { id: 'task-a', deleted: true } })

  const result = await deleteSchedule(service, {
    id: ' task-a ',
    expectedUpdatedAt: '2026-11-08T15:00:00.000Z',
  })

  assert.deepEqual(result, { ok: true, id: 'task-a', deleted: true })
  assert.deepEqual(service.calls.edit, [
    {
      id: 'task-a',
      action: 'delete',
      expectedUpdatedAt: '2026-11-08T15:00:00.000Z',
    },
  ])
})

test('deleteSchedule maps not-found, conflict and unconfirmed results', async () => {
  const notFound = await deleteSchedule(
    makeService({ editResult: { id: 'task-a', code: 'schedule_not_found' } }),
    { id: 'task-a' },
  )
  assert.deepEqual(notFound, {
    ok: false,
    id: 'task-a',
    deleted: false,
    code: 'schedule_not_found',
    error: 'Задача не найдена',
  })

  const conflict = await deleteSchedule(
    makeService({ editResult: { id: 'task-a', code: 'schedule_conflict' } }),
    { id: 'task-a' },
  )
  assert.equal(conflict.ok, false)
  assert.equal(conflict.deleted, false)
  assert.equal(conflict.code, 'schedule_conflict')
  assert.match(conflict.error, /изменилась/)

  const unconfirmed = await deleteSchedule(makeService({ editResult: {} }), { id: 'task-a' })
  assert.equal(unconfirmed.ok, false)
  assert.equal(unconfirmed.deleted, false)
  assert.match(unconfirmed.error, /не подтвердил/)
})

test('deleteSchedule validates the id and reports exceptions', async () => {
  const service = makeService({ editResult: { deleted: true } })

  const noId = await deleteSchedule(service, { id: '' })
  assert.equal(noId.ok, false)
  assert.match(noId.error, /id/)

  const missing = await deleteSchedule(undefined, { id: 'task-a' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /dsh-schedule/)

  const failing = await deleteSchedule(makeService({ editError: 'denied' }), { id: 'task-a' })
  assert.equal(failing.ok, false)
  assert.match(failing.error, /denied/)

  assert.deepEqual(service.calls.edit, [])
})

test('describeSchedule renders every timing kind', () => {
  const base = {
    id: 'task-a',
    title: 'Проверка',
    scheduledAt: WHEN,
    status: 'active',
    target: { kind: 'session' },
  }

  assert.match(describeSchedule({ ...base, kind: 'after', afterSeconds: 5400 }), /через 1 ч 30 мин/)
  assert.match(describeSchedule({ ...base, kind: 'after' }), /через некоторое время/)
  assert.match(describeSchedule({ ...base, kind: 'at' }), /в указанное время/)
  assert.match(describeSchedule({ ...base, kind: 'every', everySeconds: 900 }), /каждые 15 мин/)
  assert.match(describeSchedule({ ...base, kind: 'every' }), /по интервалу/)
  assert.match(describeSchedule({ ...base, kind: 'daily' }), /ежедневно/)
  assert.match(describeSchedule({ ...base, kind: 'weekly' }), /еженедельно/)
  assert.match(describeSchedule({ ...base, kind: 'cron' }), /cron-расписанию/)
  assert.match(describeSchedule({ ...base, kind: 'rrule' }), /RRULE/)
})

test('describeSchedule renders status, local time, target and execution mark', () => {
  const line = describeSchedule({
    kind: 'daily',
    title: '  Отчёт  ',
    scheduledAt: WHEN,
    status: 'active',
    target: { kind: 'new_once' },
    executionActive: true,
  })

  assert.equal(line, '🟢 активно «Отчёт» · ежедневно · 08.11 21:30 · цель: новая сессия · выполняется')

  assert.match(
    describeSchedule({ title: 'X', status: 'paused', target: { kind: 'session' } }),
    /^⏸ на паузе/,
  )
  assert.match(
    describeSchedule({ title: 'X', status: 'ended', target: { kind: 'new' } }),
    /^⏹ завершено/,
  )
  assert.match(describeSchedule({ title: 'X', status: 'ended', target: { kind: 'new' } }), /каждый раз/)
})

test('describeSchedule survives unknown fields and bad values', () => {
  const line = describeSchedule({
    kind: 'mystery',
    status: 'broken',
    title: '',
    scheduledAt: 'not-a-date',
    target: { kind: 'somewhere' },
    afterSeconds: 'soon',
  })

  assert.match(line, /^❔ неизвестный статус/)
  assert.match(line, /Без названия/)
  assert.match(line, /расписание/)
  assert.match(line, /—/)
  assert.match(line, /somewhere/)

  assert.equal(describeSchedule(null), '❔ Задача без данных')
  assert.match(describeSchedule({}), /не указана/)
  assert.match(describeSchedule({ title: 'Без даты' }), /—/)
  assert.doesNotThrow(() => describeSchedule({ target: null, scheduledAt: {} }))

  const inherited = describeSchedule({
    title: 'X',
    status: 'toString',
    kind: 'constructor',
    target: { kind: 'constructor' },
  })
  assert.match(inherited, /^❔ неизвестный статус/)
  assert.match(inherited, /расписание/)
  assert.doesNotMatch(inherited, /function/)
})

test('formatSchedulesCard handles an empty list', () => {
  assert.equal(formatSchedulesCard(), '⏰ Запланированные задачи\n\nЗадач нет')
  assert.equal(formatSchedulesCard({ items: [], total: 0 }), '⏰ Запланированные задачи\n\nЗадач нет')
})

test('formatSchedulesCard numbers tasks and appends command hints', () => {
  const card = formatSchedulesCard({
    items: [
      { id: 'a', title: 'Первая', kind: 'at', status: 'active', scheduledAt: WHEN, target: { kind: 'session' } },
      { id: 'b', title: 'Вторая', kind: 'daily', status: 'paused', scheduledAt: WHEN, target: { kind: 'new' } },
    ],
    total: 2,
  })

  const lines = card.split('\n')
  assert.equal(lines[0], '⏰ Запланированные задачи')
  assert.equal(lines[2], `1. ${describeSchedule({
    id: 'a',
    title: 'Первая',
    kind: 'at',
    status: 'active',
    scheduledAt: WHEN,
    target: { kind: 'session' },
  })}`)
  assert.match(lines[3], /^2\. /)
  assert.ok(lines.includes('/schedules pause N'))
  assert.ok(lines.includes('/schedules resume N'))
  assert.ok(lines.includes('/schedules cancel N'))
  assert.doesNotMatch(card, /и ещё/)
})

test('formatSchedulesCard shows at most ten tasks and reports the remainder', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Задача ${index + 1}`,
    kind: 'at',
    status: 'active',
    scheduledAt: WHEN,
    target: { kind: 'session' },
  }))

  const card = formatSchedulesCard({ items, total: 12 })

  assert.match(card, /^10\. /m)
  assert.doesNotMatch(card, /^11\. /m)
  assert.match(card, /… и ещё 2/)
  assert.equal(card.match(/^\d+\. /gm).length, 10)

  const fallbackTotal = formatSchedulesCard({ items })
  assert.match(fallbackTotal, /… и ещё 2/)

  const smallerTotal = formatSchedulesCard({ items: items.slice(0, 3), total: 1 })
  assert.doesNotMatch(smallerTotal, /и ещё/)
})

test('formatSchedulesCard tolerates malformed input', () => {
  assert.equal(formatSchedulesCard(null), '⏰ Запланированные задачи\n\nЗадач нет')
  const card = formatSchedulesCard({ items: [null, 'строка'] })
  assert.match(card, /^1\. ❔ Задача без данных$/m)
  assert.match(card, /^2\. ❔ Задача без данных$/m)
})
