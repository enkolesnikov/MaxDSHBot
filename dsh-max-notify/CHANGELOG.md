# Changelog

All notable changes to `dsh-max-notify` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.12.0] — 2026-11-24

Техдолг-аудит 24.11: три read-only аудита и шесть параллельных фиксов.

### Fixed

- **Settings API на всех поддерживаемых DSH:** маршрут всегда объявляет
  `auth: 'required'` (адмиссия 0.2.3+), а на rc.x с `requestRejection`
  дополнительно выполняется ручная fail-closed проверка. Закрыт обход
  аутентификации в legacy-ветке и сохранена работа на обеих версиях.
- **Polling больше не залипает на poison-апдейте:** ошибка одного update не
  рвёт батч; попытки считаются по ключу (LRU 500), после 3 неудач апдейт
  пропускается с warn, маркер батча двигается. Тред-офф: транзиентная ошибка
  больше не переотправляется целиком (см. «Известные ограничения»).
- **Webhook-подписка повторяется после неудачного старта:** тик retry-таймера
  переподписывает при `active && webhookAutoSubscribe && !subscribed`, с
  in-flight guard и бэкоффом до 5 минут; сброс при успехе.
- **Переполнение очереди outbox:** вытесняется самый старый
  низкоприоритетный элемент (раньше — самый новый при равном приоритете);
  `enqueue()` честно возвращает `false`, если элемент вытеснен, а
  `deliverNow()` отдаёт `{queued:false, lost:true}`; observer логирует
  непоставленное уведомление.
- **Webhook-очередь:** вытеснение по count/byte-cap теперь видно (warn, audit,
  `webhookDroppedTotal`, `webhookLastDropAt`); `dispose`/`routeDispose` честно
  сбрасывают `transport/webhookActive`; teardown старой HMR-генерации не
  снимает подписку живой (реестр рантаймов).
- **Транспорт:** `Retry-After` ограничен 60 с (warn при усечении); 2xx с
  непустым не-JSON телом на write-методах — `max.bad.response` вместо
  ложного успеха (пустое тело и GET разрешены); `"`/CR/LF/NUL в имени файла
  вычищаются перед multipart.
- **Персистентность:** present-but-invalid `schemaVersion`/`version` блокирует
  запись с `.future-*` бэкапом (state и outbox); очередь webhook обрезается
  по count/byte при загрузке и в `setWebhookQueue`; `entryBytesMax` клампится
  к `queueBytesMax`.
- **Redaction:** dead-letter `update`/`error` редактируются, audit ротируется
  после 5 МиБ; health рекурсивно редактирует вложенные строки; секреты из
  `*File` регистрируются после чтения; файл токена с правами шире 0600 даёт
  warn.
- **Cost-meter:** битый ledger кэшируется по mtime+size и не перечитывается
  на каждый snapshot.
- **Index:** `titleCache` → LRU 500 с очисткой на `session/disposed`;
  `isTopLevelSession` из общего модуля; `null` chatId/userId трактуются как
  отсутствующие; стартовый лог печатает все части (было 6 `%s` на 9 args);
  убраны мёртвые импорты; комментарии teardown/requestRejection приведены к
  фактам (удалён в DSH 0.2.3-alpha.1, установлен 0.2.3-alpha.2).

### Docs / package

- README/ROADMAP/SECURITY/CHANGELOG выровнены: 568 тестов, 13 команд,
  webhook body 64 КиБ, DSH 0.2.3-alpha.2, отсутствие ложных claim'ов про
  members/pin; `LICENSE` добавлен в npm-пакет; `check` покрывает `tools/*.mjs`;
  битые ссылки на docs заменены на абсолютные GitHub URL.
- Новый разбор остатка: [docs/tech-debt-2026-11-24.md](https://github.com/enkolesnikov/MaxDSHBot/blob/main/docs/tech-debt-2026-11-24.md).

### Known limitations

- Polling: после ошибки батч считается обработанным (маркер двигается), поэтому
  временный сбой MAX может потерять один апдейт — компенсируется dedupe/redelivery.
- Очередь webhook: при переполнении между `shift` и сменой head возможна потеря
  второго апдейта — видимость есть, логика drain ждёт отдельной задачи.
- Структурный долг (`index.js`/`bot.mjs` монолиты, три очереди отправки,
  `settings` overlay без unknown-keys, `fs-safe` symlink-политика, лимит тела
  voice) — в docs/tech-debt-2026-11-24.md.

### Tests

568 тестов на Node 20/22/24, `REQUIRE_TLS_TESTS=1` — 0 skip.

## [1.11.1] — 2026-11-24

### Fixed

- **Settings API возвращал 403 для валидной сессии** после обновления DSH:
  `connection.requestRejection` удалён в **DSH 0.2.3-alpha.1** (а не в
  0.2.2-rc.2, как предполагалось), плагин же использовал его как проверку
  доступа и fail-closed отвечал 403. Теперь маршрут
  `/max-notify/settings.json` объявляет `auth: 'required'` и полагается на
  admission веб-сервера; повторная проверка в handler удалена.
  Проверено на текущем рантайме **0.2.3-alpha.2**; `engines.dsh` не менялся.
  Добавлен регрессионный тест на отсутствие `requestRejection`.

### Tests

532 теста на Node 20/22/24 (`node --test`); живая проверка: `/max-notify/settings.json`
отдаёт 200 с cookie и 401 без.

## [1.11.0] — 2026-11-24

Приведение транспорта к изменениям MAX Bot API 2026 — разбор с датами и
ссылками: [docs/max-api-2026.md](https://github.com/enkolesnikov/MaxDSHBot/blob/main/docs/max-api-2026.md).

### Added

- **`getMessage(messageId)`** — `GET /messages/{messageId}`: получение одного
  сообщения по id.
- **`getVideo(videoToken)`** — `GET /videos/{videoToken}`: URL воспроизведения
  и метаданные видео-вложения.
- **`bot_admin_permissions_changed`:** изменение прав бота-администратора в
  канале/чате теперь пишется в лог уровнем `warn` с `chat_id` и сводкой прав.
  Health получает `lastAdminPermissionsAt` / `lastAdminPermissionsEvent`.
  Событие доставляется только через webhook, поэтому в список типов long
  polling оно не добавлено.

### Fixed

- **HTTP 200 + `success: false`** теперь считается ошибкой (`MaxApiError` с
  `code` и `message`), а не успехом. Проверка общая для всех JSON-ответов
  клиента: `PUT`/`DELETE /messages`, `POST /answers`, `POST`/`DELETE
  /subscriptions`, `POST /chats/{chatId}/actions`. Методы управления
  участниками (`.../members`) и закреплёнными сообщениями чата (`.../pin`)
  плагин не вызывает — они в API тоже отдают такие конверты, но в клиенте
  их нет (см. [docs/max-api-2026.md](https://github.com/enkolesnikov/MaxDSHBot/blob/main/docs/max-api-2026.md)).
- **Имя загружаемого файла** обрезается до 200 символов (лимит MAX) с
  сохранением расширения — и для явного `filename`, и для имени из пути.

## [1.10.0] — 2026-11-18

Закрытие остатка P2: модульная структура и тест-инфраструктура.

### Changed

- **`index.js` 2018 → 1711 строк:** webhook/route lifecycle вынесен в
  `lib/webhook-runtime.mjs` (342 строки, `createWebhookRuntime`), final-delivery
  pipeline — в `lib/deliver.mjs` (165 строк, `createDeliver`). Поведение,
  rc.2-порядок `ctx.inject`, 15-секундный fallback и teardown сохранены.
- **Одно хранилище workspace:** `preferredWorkspacePath` живёт только в
  `index.js`; `bot.mjs` читает через `runtime.getPreferredWorkspace()` и пишет
  через `setPreferredWorkspace()`.
- **`lib/fs-safe.mjs`:** `ensurePrivateDir()` создаёт все промежуточные каталоги
  с 0700 (не только лист), `writePrivateFile()` — файл 0600; используются в
  settings/incoming/transport/audit/heartbeat.
- **Логи:** сбои digest/budget/notification-хендлеров теперь `warn`, а не
  `debug`/тихий catch; ожидаемые «сервис отсутствует» остаются debug.
- **Тесты:** keepalive-хаки удалены (промисы ждутся детерминированно через
  `awaitSettled`); `createFakeClient`/`tick` мигрированы на общий
  `test/helpers/fakes.mjs` в interactions/progress/deliverables; CDN-контракт:
  `downloadToFile` на trusted CDN не шлёт `Authorization`, на API — шлёт.
- **`webhookRemoveOnStop`:** мёртвая ветка (disposer очищал `active` раньше
  проверки) исправлена через `everRegistered`; добавлен регрессионный тест.
- **`lib/audit.mjs`:** каталог 0700 вместо umask.
- 515 тестов на Node 20/22/24, `REQUIRE_TLS_TESTS=1` без skip.

### Deferred

Нет открытых P2-пунктов; `docs/p2-backlog.md` закрыт. Возможные future-темы:
cold-start тест с рестартом `dsh-web`, branch protection на GitHub,
secret_scanning_non_provider_patterns, полная миграция оставшихся тестовых
фейков (bot/index/observer).

## [1.9.0] — 2026-11-17

Закрытие P2-техдолга из аудита 17.11.

### Changed

- **Дедупликация:** общие `lib/target.mjs` (targetQuery), `lib/session-kind.mjs`
  (isTopLevelSession), `lib/format.mjs` (formatBytes/folderOf/formatClock);
  убраны копии в progress/deliverables/bot/observer/interactions/incoming/workspace-tools.
- **Кэши:** `lib/lru.mjs`; ограничены 500 записями `titleCache`, choices,
  approval/schedule confirmations, incoming buckets, `questionsByChat`,
  `imagesSent`, `goals/todos/todoProgress`; `observer.clearSession()` и
  `forwarding.dispose()` вызываются из lifecycle.
- **Наблюдаемость:** `pollStopped` сбрасывается на старте и успешном poll,
  `pollFailuresTotal` отделён от текущей серии, `lastErrorAgeMs` в snapshot,
  `/health` не врёт после восстановления; дайджест срабатывает по «не раньше»
  и догоняет пропущенную минуту; transient-счётчики outbox не пишутся в state.
- **Лимитер:** ref-таймер пока очередь непуста (не зависают `acquire`), LRU
  вытеснение бакетов чатов (500), `waitFor()` без мутации состояния.
- **Cost-meter:** инвалидация по `mtimeMs+size`, предупреждение о неизвестной
  версии леджера.
- **Транспорт:** кап ответа 8 МиБ, обязательный https и MAX-allowlist для
  `baseUrl` (loopback только с `allowInsecureBaseUrl` для тестов).
- **Конфиг/GUI:** общие валидаторы `lib/settings-validate.mjs`; строгие
  `quietHours`/`digestTime`, enum `messageStyle`, лимиты пресетов; единый
  парсер boolean; удалён мёртвый `coerceHttpsUrl`; GET настроек фильтруется по
  `SETTINGS_KEYS`; `insecureVoiceEndpoint` и `readOnlyNetwork` — явные флаги.
- **Безопасность:** read-only больше не разрешает `web_search`/`web_fetch`
  (opt-in `readOnlyNetwork: true`); STT endpoint требует https, если задан ключ.
- **dryRun:** не ходит в сеть за `getChat`/`getMe`/`setCommands`, не подписывает
  webhook, не запускает polling и TTS/STT, не принимает webhook-апдейты;
  локальные durable-файлы продолжают работать.
- **Тесты/CI:** `test/helpers/fakes.mjs`, `test/teardown.test.mjs` (dispose/HMR/
  ошибки durable-записи), `REQUIRE_TLS_TESTS=1` в CI (тихие skip больше
  невозможны), `check` через glob `lib/*.mjs`; 490 тестов на Node 20/22/24.

### Deferred

- Полный распил `index.js` (webhook-runtime/deliver), `preferredWorkspacePath`
  в одном хранилище, рекурсивные mkdir с промежуточными 0700, миграция старых
  тестов на общие фейки, удаление keepalive-хаков, тест CDN-без-Authorization.

## [1.8.0] — 2026-11-17

Закрытие P1-техдолга из аудита 17.11. Поведение местами строже — см. ниже.

### Fixed

- **Webhook-очередь:** байтовые лимиты `webhookEntryBytesMax` (64 КиБ) и
  `webhookQueueBytesMax` (8 МиБ); HTTP-слой отклоняет тело >64 КиБ с 413,
  переполнение вытесняет старые записи, а не блокирует event loop. В health
  добавлены `webhookQueueBytes` и `webhookLastDropAt`.
- **Dead-letter:** счётчик попыток сохраняется синхронно; в audit пишется
  redacted-копия update (до 4 КБ), чтобы poison можно было разобрать.
- **Redaction:** `registerSecret()` маскирует реальные runtime-секреты любой
  длины (включая 32-символьный webhook secret); `health.fail()`/`health.update()`
  редактируют строки на записи.
- **Deliverables:** путь из `present` проходит `realpath` + границу cwd сессии
  (как `/send`); файлы вне cwd пропускаются с warn, `fileSendAllowOutside`
  разрешает явно. Исправлен лог «over 4 GB» → 50 MB.
- **Autonomy:** заголовки расписаний больше не матчатся подстрокой — только
  точно или анкорным префиксом; `auto` без подтверждённой идентичности сессии
  понижается до интерактивного подтверждения. Расписания с `auto` должны
  указывать `targetSessionId`/`involvedSessionIds`.
- **Outbox:** гонка `deliverNow` устранена in-flight-набором; загруженные
  элементы нормализуются (`nextAt`/`createdAt`/`params`), битые отбрасываются
  с warn, TTL-дропы логируются.
- **Lifecycle:** единый `disposed`-флаг, `AbortController` для long-poll,
  ожидание очереди отправки при teardown, генерационный guard для
  subscribe/unsubscribe при HMR.
- **Тесты/CI:** восстановлены негативные тесты settings API (405/413/aborted/
  500); rc.2-fallback покрыт; CI-шаг `Sensitive-data guard` (generic-паттерны,
  без приватных значений) ловит PAT/токены/PEM/приватные `.ru`-домены/IPv4;
  всего 435 тестов на Node 20/22/24.
- Docs: webhook secret 32–256 (было 5–256), Node ≥20, 13 команд, устранены
  противоречия `todoProgress`.

### Changed

- `transport.getUpdates()` принимает `signal`; `deliverables.send(files,{cwd})`
  принимает cwd сессии; `state.pushWebhookQueue()` возвращает depth-Number с
  метриками.

## [1.7.0] — 2026-11-13

Закрытие техдолга после аудита 1.6.

### Changed

- `index.js` further decomposed: image/keyboard forwarding moved to
  `lib/forwarding.mjs` (1947 → 1870 строк), config already in `lib/config.mjs`.
- Removed the dead standalone HTML settings page/token handler from
  `lib/settings.mjs` (779 → 416 строк); production JSON API unchanged.
- `lib/state.mjs`/`lib/outbox.mjs`: future schema versions are preserved with
  `.future-*` backups and writes are blocked, atomic writes are fsync'd,
  corrupt files backed up, modes stay 0600/0700.
- CI: Node 20/22/24 matrix, actions pinned to commit SHAs; green on all three
  (test keepalive fixed Node 20/22 unref-timer cancellations).
- Transport contract tests expanded to 38 (local HTTPS: retries, Retry-After,
  uploads, downloads, host guard); total 400 tests.
- `docs/audit-1.6.md` and `docs/ux.md` counts updated.

### Deferred

- Full `index.js` split (host facade/events/final-delivery), async shutdown,
  provider-level state migration beyond schema guard, CDN-without-token test.

## [1.6.1] — 2026-11-13

Tech-debt follow-up.

### Changed

- Вынесены `DEFAULTS` и `normalizeConfig` из `index.js` в `lib/config.mjs`
  (`index.js` 2051 → 1947 строк); поведение не менялось, старые импорты
  `normalizeConfig` из `index.js` сохранены.
- `check` включает новый модуль; CI остаётся зелёным.

### Tests

358 tests, без изменений поведения.

## [1.6.0] — 2026-11-13

Аудит техдолга, безопасности и совместимости с DSH 0.2.2-rc.2.

### Fixed

- **DSH rc.2:** webhook и settings-маршруты больше не теряются из-за порядка
  активации `webServer`; используются `ctx.inject(['webServer'])` и
  `['connection','webServer']`, с fallback на polling и health-диагностикой.
  Маршруты переживают HMR и заменяют stale-регистрации.
- **Вложения `present`:** исправлен `uploadTypeFor` (`AUDIO_EXTENSIONS` был
  undefined); документы/аудио снова доходят, а не теряются с warning.
- **Транспорт:** `sendMessage` передаёт `chatKey`/`priority` в лимитер; per-chat
  лимит и critical-полоса работают. UA берёт реальную версию.
- **Allowlist:** проверяется для всех исходящих путей (observer/progress/
  approvals/files/TTS), а не только финала; транзиентный `getChat` больше не
  кэшируется навсегда. В чате с `allowedChatIds` при заданном `allowedUserIds`
  отправитель тоже должен быть в allowlist.
- **Webhook durability:** `save()` до ответа 200; poison-update уходит в
  dead-letter после 3 попыток; in-flight dedupe для poll/webhook.
- **Секреты:** webhook secret требует 32–256 `[A-Za-z0-9_-]`; endpoint STT/TTS
  больше не редактируется через GUI-overlay; токен не отправляется на
  не-MAX хосты и не уходит по cross-host redirect; deliverable cap 50 МиБ.
- **Файлы:** state/outbox/heartbeat/inbox — 0600/0700; corrupt state/outbox
  сохраняются как `.corrupt-*`; outbox не дублирует pending/delivered.
- **Lifecycle:** `stopPolling()` отделён от `dispose()`; heartbeat пишется после
  webhook setup; route-latch сбрасывается.
- CI: `permissions: contents: read`, concurrency, timeout; `.gitignore`
  закрывает личные каталоги; удалены старые `refs/original`.
- **Тесты:** 358 (было 353): транспорт/типы, allowlist всех путей, deferred
  routes, secret strength, in-flight/очереди.

### Deferred

- Распил `index.js` на модули, удаление мёртвой HTML-страницы настроек,
  унификация target/format-хелперов, полный state schema migration.

## [1.5.0] — 2026-11-09

Брифинг и статус.

### Added

- **`/brief`**: компактный брифинг — что работает, сколько сессий за сутки,
  что ждёт (approvals/questions), деньги/бюджет и ближайшие расписания.
- Команда добавлена в компактное меню и `/help`; `/digest` остаётся скрытым.

### Fixed

- `/status`: заголовок сессии больше не расползается на несколько строк
  (обрезка 30 символов), папка показывается как basename, а не полный `/root/…`.
- Деньги в `/status`: два знака после запятой; если стоимость сессии больше
  «сегодня», подпись «сессия всего» — больше не выглядит противоречиво.
- Русские склонения в брифинге/дайджесте («2 сессии», «2 вопроса»).

### Tests

353 tests (was 349): briefing, status/cost regressions, `/brief`, menu/help.

## [1.4.0] — 2026-11-09

UX-аудит: тише, короче, понятнее.

### Changed

- **Компактный заголовок** финального ответа: `🕒 20:03 · Название` вместо
  `**DSH** · 20:03:28 · Название`; `messageStyle: detailed` возвращает старый вид.
- **12 команд в меню** вместо 31; компактный `/help` (≤450 символов) и полный
  `/help all`; продвинутые команды скрыты из меню, но работают.
- **Тихие уведомления по умолчанию**: subagent/job/goal/TODO выключены;
  остаются final, errors, approvals/questions, budget alerts.
- Approval-карточка: без callId, причина ≤200 символов, короткие кнопки;
  результат — одна строка; GUI-ответы больше не создают отдельную карточку.
- Job/subagent/goal-карточки — одна строка; ошибки — 1–3 строки.
- Digest стал «брифингом»: сделано / ждёт тебя / деньги / дальше.
- GUI: toggles уведомлений и формата сообщений; TTS-секция скрыта (TTS frozen).
- `docs/ux.md`: аудит функций и список «оставлено / скрыто / потенциально удалить».

### Tests

349 tests (was 341): compact header/cards/help, quiet defaults, GUI notices,
live settings keys, feature-audit regressions.

## [1.3.0] — 2026-11-09

Автономные расписания.

### Added

- **Политики автономности для задач `/schedules`**: `inherit` (обычный),
  `read-only` (разрешены только read-инструменты, остальное отклоняется) и
  `auto` (все approvals разрешаются автоматически, только после явного
  подтверждения). Команда `/schedules mode N inherit|read-only|auto`.
- **Авто-ответы на approvals во время запуска по расписанию**: карточка в MAX не
  создаётся; решение и причина пишутся в audit log (`kind: autonomy`).
- **Сопоставление запуска с задачей**: по target/involved session, а для
  `new`-сессий — по заголовку и свежей receipt-записи; при нескольких политиках
  выбирается наименее привилегированная.
- `schedulePolicies` в state (переживают reload), отображение режима в
  `/schedules`, `autonomyEnabled` в конфиге, `lib/autonomy.mjs`.
- `/schedules` card показывает `🤖 auto` / `🔎 read-only`; auto требует
  двухшагового подтверждения.

### Tests

341 test (was 330): autonomy helpers/matching, interactions without cards, bot
command, policy persistence.

## [1.2.0] — 2026-11-09

Голос и инструменты.

### Added

- **TTS (озвучка ответов)**: опциональная озвучка через OpenAI-совместимый
  `/audio/speech`; режимы `off|short|always`, выбор голоса/модели, лимит
  символов, отдельное аудио-сообщение (MAX требует `audio` единственным
  вложением). Команда `/say <текст>` — ручная озвучка. Ошибки TTS не ломают
  доставку текста; ровно одно аудио на ход, дедупликация через outbox.
- **`/diff [--staged] [путь]`**: git diff рабочей папки сессии отправляется
  файлом `diff.patch`; лимит 1 МиБ, усечение и понятные ошибки.
- **`/send <путь>`**: отправка файла из папки сессии в MAX; путь вне cwd
  запрещён по умолчанию, лимит 25 МиБ, тип (image/audio/file) по расширению.
- **Live-настройки**: allowlisted-настройки из GUI применяются без рестарта
  строки (режим, дайджест, тихие часы, reply-ветки, таблицы, TTS, approvals и
  т.д.); transport/webhook/секреты по-прежнему требуют перезагрузки.
- **GUI**: секция «Озвучка», статус применения настроек.
- `lib/tts.mjs`, `lib/workspace-tools.mjs`; `sending_audio` action; audio upload
  type в транспорте.

### Fixed

- Восстановлены релизы v0.8–v1.1 и topics после пересоздания репозитория.

### Tests

330 unit/integration tests (was 316): TTS (5), workspace tools (6), bot
commands, TTS delivery, live settings, plus existing coverage.

## [1.1.0] — 2026-11-09

GUI-настройки, голос и нативные изображения.

### Added

- **Страница настроек в GUI DSH**: тонкий клиентский плагин без сборки
  (`client/client.js`, слот `plugins.bundle.config`) + host-маршрут
  `/max-notify/settings.json`, защищённый `connection.requestRejection`
  (та же cookie/Origin-проверка, что у панели). Правки сохраняются в
  `$DSH_HOME/max-notify/config.json` (0600, atomic) и применяются после
  перезагрузки строки; секреты страница не редактирует.
- **Нативные входящие изображения**: при `nativeIncomingImages` картинки из MAX
  передаются агенту image-партами (base64, mediaType по сигнатуре), с fallback
  на текстовый prompt, если route/модель не принимает изображения.
- **Голосовая расшифровка (STT)**: опциональный OpenAI-совместимый endpoint
  (`voiceTranscribe`, `voiceEndpoint`, `voiceApiKey`/`voiceApiKeyFile`,
  `voiceModel`, `voiceLanguage`); аудио из MAX расшифровывается и уходит агенту
  как текст, ошибки не блокируют передачу файла.
- `settingsPage`/`settingsFile` в конфиге; `settingsSummary` расширен.
- Пакет: `dsh.client` metadata, `exports["./client"]`, `files` включает `client/`;
  клиентский бандл проверен в boot-графе живого DSH.

### Tests

315 unit/integration tests (was 249): media (13), voice (22), settings (4),
settings API route, native-image prompt, плюс существующее покрытие.

### Deferred to 1.2

TTS (озвучка ответов), внешний каталог плагинов, multi-chat/roles.

## [1.0.0] — 2026-11-09

Первый стабильный релиз: «чат как пульт» стал полноценным рабочим местом.

### Added

- **Reply-ветки сессий**: первый MAX-ответ сессии становится якорем, следующие
  ответы приходят реплаями к нему; ответ пользователя на любой ответ
  маршрутизируется в исходную сессию. Якоря и mid→session сохраняются в state.
- **Таблицы → файлы**: markdown-таблицы из финального ответа дополнительно
  уходят в MAX как `table-N.csv` и `table-N.md`, текст ответа заменяется
  плейсхолдером; code fences не считаются таблицами.
- **`/schedules`**: список запланированных задач, `/schedules pause|resume N`,
  `/schedules cancel N` с двухшаговым подтверждением. Для операций используется
  `ctx.get('schedule')`, `expectedUpdatedAt` защищает от конфликтов.
- **Forwarded-сообщения**: входящий forward из MAX разворачивается и передаётся
  агенту как обычный текст/вложения.
- **`/settings`**: снимок эффективных настроек (transport, режим, allowlist,
  таймауты, фичи) без раскрытия секретов.
- `/help` и меню команд MAX расширены (`/schedules`, `/settings`).

### Changed

- `package.json` 1.0.0; в пакет добавлены `lib/tables.mjs`, `lib/schedules.mjs`,
  `test/tables.test.mjs`, `test/schedules.test.mjs`.
- Конфиг: `threads` (true), `tableFiles` (true), `tableMaxFiles` (4).

### Tests

249 unit/integration tests (was 200): таблицы, расписания, reply-маршрутизация,
forwarded, `/settings`, плюс существующее покрытие.

### Deferred to 1.1

GUI-страница настроек с редактированием, голосовые STT/TTS и нативные входящие
изображения — требуют отдельного клиентского/внешнего слоя; в 1.0 есть
read-only `/settings` и стабильные файлы/ветки/расписания.

## [0.9.0] — 2026-11-09

«Production-транспорт»: webhook-режим MAX + публикация npm.

### Added

- **Webhook-транспорт** (opt-in, `transport: webhook`): маршрут
  `/max/webhook` регистрируется через `webServer.register`, secret
  `X-Max-Bot-Api-Secret` проверяется в constant-time, тело ограничено 1 МиБ,
  ответ `200` после durable-записи обновления.
- **Durable webhook queue** в `state.json`: обновление сохраняется до ответа,
  обрабатывается идемпотентно (общий dedupe с polling), очередь переживает
  reload/рестарт; при ошибке MAX получает `503` и повторяет доставку.
- **Управление подпиской**: `GET/POST /subscriptions` в транспорте; авто-подписка
  на старте (`webhookPublicUrl`, `webhookSecret`, `webhookAutoSubscribe`),
  опциональная отписка на остановке; CLI `tools/webhook.mjs status|subscribe|unsubscribe`.
- `/health` показывает transport, состояние webhook-подписки и глубину очереди.
- `bot_admin_permissions_changed` в update_types; fallback на long polling, если
  webServer/secret/URL не сконфигурированы.
- **npm**: `dsh-max-notify@0.9.0` (публикация 0.8.0 выполнена ранее).

### Changed

- `package.json` 0.9.0; в пакет добавлены `lib/webhook.mjs` и `tools/webhook.mjs`.

### Tests

200 unit/integration tests (was 187): webhook handler (secret/method/body/limits/
503), durable queue, index route registration + idempotent processing, subscription
helpers.

## [0.8.0] — 2026-11-09

«Стоимость и бюджет»: read-only интеграция с `dsh-cost-meter`.

### Added

- `lib/cost-meter.mjs` — адаптер ledger `$DSH_HOME/storages/cost-meter/ledger.json`
  (version 1, size cap 8 МиБ, mtime-cache, graceful degradation): сегодня,
  календарный месяц, всего, стоимость по DSH session id, окно/потрачено/
  остаток/процент бюджета. Валюта, символ и decimals берутся из конфига
  cost-meter; конвертация `cost` × `exchangeRate` повторяет логику UI.
- `/budget` (и `/cost`): бюджет, потрачено/осталось/период, сегодня/месяц/всего;
  если бюджет выключен — подсказка, где включить.
- `/status` и `/current` показывают стоимость за сегодня, стоимость сессии и
  процент бюджета.
- Дайджест включает стоимость за сегодня/месяц и процент бюджета.
- **Опубликовано в npm** как `dsh-max-notify@0.8.0`
  (`dsh plugin --profile web add dsh-max-notify`); в пакете есть `icon.svg`,
  `locale/{en,zh,ru}.json` и `engines.dsh`/`dsh.manifestVersion`.
- **Алерты бюджета**: пороги `budgetAlertThresholds` (по умолчанию 80/100)
  срабатывают один раз за период, сохраняются в state (`budgetAlerts`),
  дедуплицируются через outbox; 80% — обычный, 100% — critical.
- Конфиг: `costMeterEnabled`, `costMeterFile`, `budgetAlertEnabled`,
  `budgetAlertThresholds` (env `MAX_NOTIFY_COST_FILE`).

### Changed

- `/help` дополнен `/budget`; команды в меню MAX обновлены.
- `package.json` 0.8.0.

### Tests

187 unit tests (was 173): ledger fixtures (CNY/USD, day/month/all/custom,
disabled/missing/corrupt/version mismatch), budget cards, `/budget`, `/status`
cost line, alert dedupe, digest cost, state persistence.

## [0.7.0] — 2026-11-09

«Полное управление»: все частые действия из MAX без возврата в веб-GUI.

### Added

- `/model` — каталог моделей (`sessionController.modelCatalog`) с выбором по
  номеру или `provider/model` (`selectModel`).
- `/rename <title>`, `/fork` (новая сессия становится активной), `/compact`
  (исполнение `/compact` через `commands.execute`).
- `/plan`, `/plan off`, `/plan status` через `ctx.planMode` (`set`/`get`).
- **Plan review в MAX**: `user-questions` с `intent.kind === 'plan-review'`
  рендерится отдельной карточкой, полный план уходит файлом `plan.md`,
  кнопки «Approve / Keep planning», свободный текст — фидбек агенту.
- `/search <query>` по содержимому сессий; результаты нумеруются и работают с
  `/use N`.
- `/archive` (архивирует текущую и переключает на следующую), `/pin`/`/unpin`.
- `/workspace`, `/workspace N`, `/workspace add <path>`: выбор папки для
  последующих `/new` и регистрация новой папки.
- `/approve` — просмотр политики approvals, переключение `ask`/`never` через
  двухшаговое подтверждение.
- Кнопки-пресеты под финальным ответом (`buttonsPresets:
  [{label, prompt}]`, до 4).
- `/sessions` показывает заголовки холодных сессий через projection cache.

### Changed

- `/help` и меню команд MAX расширены новыми командами.
- `package.json` 0.7.0.

### Tests

173 unit tests (was 161): model/rename/fork/compact/plan/search/archive/pin/
workspace/approve, preset callbacks, plan-review file card and free-text feedback.

## [0.6.0] — 2026-11-08

«Надёжность и безопасность»: доставка без потерь и дублей, approvals без
зависаний, безопасные дефолты, наблюдаемость.

### Added

- **Durable outbox** (`lib/outbox.mjs`): final replies and notifications survive
  MAX outages and reloads; exponential backoff, 48 h TTL, 200-item cap, priority
  lanes, de-duplication by business key (`final:<session>:<turn>:<seq>:c<n>`,
  `subagent:<id>`, `job:<id>`, `digest:<date>`, …).
- **Global outbound scheduler** (`lib/limits.mjs`): 2 requests/second per chat and
  30/second overall (configurable), critical lane for approvals/questions/errors.
- **At-least-once long polling**: the marker advances only after a batch is
  handled; processed update ids are persisted (`msg:<chat>:<mid>`,
  `cb:<callback_id>`, `bot_started`, `bot_added/removed`) so redelivery does not
  duplicate prompts.
- **Approval timeout** (`approvalTimeoutMs`, default 120 s; `0` disables): an
  unanswered approval is rejected, the card shows «таймаут», the model sees
  `rejected` instead of hanging forever.
- **Remembered approvals** (`approvalRememberTools`, `approvalRememberMs`): the
  «Разрешить и запомнить» button stores a per-tool rule (TTL 1 h, explicit
  allowlist only, audited).
- **Health**: `/health`, `/version`, `/ping` commands; health snapshot with last
  poll/update/send, last error, outbox depth, limiter waits; optional
  `heartbeatFile`; 401/405 polling stops are recorded.
- **Audit log** (`lib/audit.mjs`): JSONL at `$DSH_HOME/max-notify/audit.jsonl`
  (0600) for approvals, questions and commands — metadata only, never bodies.
- **Log redaction** (`lib/redact.mjs`): bot tokens, `?r=` upload credentials and
  `Authorization` values never reach the journal.
- **Flood protection** for incoming MAX messages (`incomingPerMinute`,
  `incomingBurst`), with a single warning per 5 minutes.
- `/health`, `/version`, `/ping`; stale approval/question cards are marked after
  a plugin reload.
- Package metadata for the DSH marketplace: `engines.dsh`,
  `dsh.manifestVersion`, repository/keywords, `CHANGELOG.md`.

### Changed

- **Fail-closed remote control**: if `interactive` is on and neither
  `allowedUserIds` nor `allowedChatIds` is configured, commands/approvals/polling
  are disabled (notifications keep working). Set `allowUnlistedUsers: true` to
  keep the old permissive behaviour.
- Final replies are sent through the outbox path, so a failed send is queued
  instead of dropped. All MAX calls go through the shared rate limiter.
- Polling marks updates processed before advancing the marker; a failed handler
  leaves the marker unchanged and the batch is retried idempotently.
- `state.json` schema v2 (health, processed keys, pending cards, approval rules);
  existing v1 files migrate automatically. The marker is no longer advanced
  before handling.
- Store permission intent for the audit log; state/outbox remain outside the
  repo under `$DSH_HOME`.

### Fixed

- Duplicate final answers when a plugin reload replays the same turn (dedupe by
  turn + event seq).
- Lost notifications when the MAX API is temporarily unavailable.
- Hanging approvals when nobody answers in MAX or the GUI.
- Noisy retries bypassing the per-chat/send rate limit (edits, callbacks,
  actions and uploads now share the limiter).

### Tests

161 unit tests (up from 121), including failure-injection for the outbox,
limiter priority, polling redelivery, approval timeout/remember, fail-closed
configuration and log redaction.

## [0.5.0] — 2026-10-27

- `/new [folder]` creates a session in a folder (creates the directory when
  missing); archived sessions are hidden from `/sessions`, `/use` and the digest.
- Receiving MAX attachments into `<cwd>/max-inbox` and forwarding images from the
  final answer (message blocks, tool results, markdown paths/URLs).

## [0.4.0] — 2026-10-27

- Two-way files: MAX attachments → workspace; `present` deliverables → MAX.
- Image extension derived from Content-Type; incoming files are gitignored.

## [0.3.1] — 2026-10-27

- Images from the final answer are forwarded as MAX photos.

## [0.3.0] — 2026-10-27

- «Наблюдатель»: subagent/job/goal/error notifications, TODO progress, modes and
  quiet hours, daily digest.

## [0.2.0] — 2026-10-26

- «Пульт»: two-way chat, commands, inline buttons, live progress, approvals and
  questions from MAX, `present` deliverables.

## [0.1.0] — 2026-10-25

- Initial plugin: final assistant message per turn → MAX, Russian Trusted CA
  bundle, chunking, retries, recipient allowlist.
