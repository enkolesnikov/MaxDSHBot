# Changelog

All notable changes to `dsh-max-notify` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
