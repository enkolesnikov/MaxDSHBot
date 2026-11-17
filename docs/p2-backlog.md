# P2 backlog (аудит 17.11.2026)

Закрыто в 1.8.0: все P1. Закрыто в 1.9.0: пункты ниже, помеченные ✅.
Остаток — с пометкой ⏳; приоритет сверху вниз.

## Дубли и структура

1. `targetQuery()` ✅ — 8 копий (`deliverables`, `progress`, `observer`, `bot`,
   `interactions`, `index`): вынести `createTargetQuery(target)` в `lib/target.mjs`.
2. `isTopLevelSession` ✅ — 4 копии (`index`, `progress`, `observer`,
   `interactions`): одна функция, сохранить вариант с `Number.isFinite`.
3. `formatBytes` ✅ — 2 реализации (`incoming`, `workspace-tools`), разный вывод
   >1 GiB; `folderOf`/`shortCwd`, `clock`/`formatClock` — свести в `lib/format.mjs`.
4. `preferredWorkspacePath` ⏳ — два хранилища (`index`, `bot`).
5. `index.js` (1870 строк) ⏳: вынести webhook/route lifecycle и `deliver`
   в `lib/webhook-runtime.mjs` / `lib/deliver.mjs` — только после teardown-тестов.

## Наблюдаемость

6. `pollStopped` ✅ не сбрасывается в `bot.start()`; `/health` может врать после
   восстановления. Сбрасывать и хранить `pollFailuresTotal` отдельно.
7. `lastError` ✅/`lastErrorAt` не очищаются; показывать возраст ошибки.
8. Дайджест привязан ✅ к точной минуте (`observer.mjs:228`): перейти на
   «не раньше», дедуп через `digest:<day>`.
9. Сбои digest ⏳/budget/subscription логируются как `debug` — поднять до `warn`.
10. Нестойкие счётчики ✅ outbox персистятся в state — перестать.

## Кэши и лимиты

11. Неограниченные `Map` ✅: `titleCache`, `imagesSent`, `scheduleChoices`,
    `modelChoices`, `workspaceChoices`, `goals/todos`, `questionsByChat` —
    LRU 500 + очистка по `session/disposed`/`dispose()`.
12. `limits.mjs` ✅: `timer.unref()` может оставить `acquire` неразрешённым; LRU
    вместо FIFO-вытеснения; `waitFor()` мутирует бакеты.
13. `transport` ✅: нет капа тела ответа (5–10 МБ); `request()` не проверяет
    `isTrustedMaxUrl` для `baseUrl`; порт не проверяется.
14. `cost-meter` ✅: синхронный stat+read+parse до 8 МиБ, кэш только по `mtimeMs`,
    тихое «unavailable» при несовпадении версии.
15. `dryRun` ✅ частичный: только финальная отправка, остальные вызовы идут в сеть.

## Безопасность/конфиг

16. Read-only ✅ разрешает `web_search`/`web_fetch` — вынести в флаг
    `readOnlyNetwork` или убрать.
17. Voice endpoint ✅: разрешён `http:` и любой хост — требовать https + allowlist.
18. Дрейф нормализации ✅ private profile vs overlay: `quietHours` (`25:00`),
    `digestTime` (`99:99`), `buttonsPresets`, `messageStyle` — переиспользовать
    `sanitizeSettingsPatch`.
19. GET настроек ✅ отдаёт не-allowlisted поля (`voiceEndpoint`, `voiceModel`,
    `autonomyEnabled`) — фильтровать по `SETTINGS_KEYS`.
20. Три парсера ✅ булевых с разной семантикой (`settings`, `config`, `voice`).
21. Мёртвый код ⏳: `coerceHttpsUrl`, ранг `inherit`, `MAX_MESSAGES_PER_SECOND`,
    `bundledCaPath`, импорт `extname`.
22. `recursive mkdir` ⏳ без промежуточных 0700 (`settings`, `incoming`,
    `transport`).

## Тесты/инфраструктура

23. `createFakeCtx` ✅ без `effect` — teardown-ветка не исполняется; добавить и
    тесты HMR-замены, in-flight после dispose, пропуска минуты дайджеста.
24. `createFakeClient` ⏳/`tick` продублированы в 6 файлах — вынести в
    `test/helpers/fakes.mjs`.
25. 21 из 38 ✅ транспортных тестов тихо skip без openssl — либо crypto-сертификат,
    либо fail в CI.
26. `check` перечисляет ✅ 32 `lib/*.mjs` вручную — заменить на glob.
27. Keepalive ⏳-интервалы в interactions/voice маскируют unref-таймеры — перейти
    на виртуальные таймеры.
28. Нет теста «CDN ⏳ без Authorization» и реального cold-start outbox.
