# dsh-max-notify

Плагин для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), который отправляет **последнее сообщение агента после каждого хода** в
мессенджер [MAX](https://max.ru) через бота.

- Ноль runtime-зависимостей: `node:` builtins + относительные импорты (требование
  для `link:`-установленных DSH-плагинов, которые не могут резолвить
  `@deepseek-ai/*`).
- Слушает `session/event` (`assistant/message` + `turn/end`) — ровно одно
  сообщение на ход, а не на каждый шаг инструментов.
- С собой везёт цепочку **Russian Trusted Root CA**: `platform-api2.max.ru`
  не доверяется системным хранилищем (Node/curl по умолчанию падают).
- Учитывает лимиты MAX: 4000 символов (чанкинг по абзацам), 2 сообщения/сек на
  чат, ретраи `429 Retry-After` и 5xx/сетевых ошибок.
- Фильтры: subagent-сессии игнорируются; `interrupted`/`forked` (синтетические
  закрытия восстановления со старым текстом) пропускаются.
- **Recipient allowlist (fail-closed)** — «только мне»: проверка `GET
  /chats/{chatId}`, что это личный диалог с разрешённым пользователем.
- Плохой/отсутствующий конфиг не ломает профиль: плагин просто логирует
  предупреждение и остаётся выключенным.

### Наблюдатель (v0.3)

- **События**: уведомления о завершении дочернего агента (с итогом), фоновых
  задач (`ctx.jobs`), изменении цели (`goal/changed`), ошибках агента.
- **TODO-прогресс**: «📋 2/5» при изменении числа выполненных задач
  (`todo_write`), без спама на промежуточных статусах.
- **Режимы уведомлений**: `/mode all|errors|mute`, `/mute 30m|2h`, `/unmute`;
  `quietHours` («не будить ночью»): некритичные уведомления приходят без push,
  критичные (подтверждения/вопросы/ошибки) — всегда.
- **Дайджест**: ежедневно в `digestTime` (или `/digest` вручную) — активные
  сессии, live-токены, цели, прогресс задач; дата отправки хранится в state.

### Пульт управления (v0.2)

- **Двусторонний чат**: текст, отправленный боту в MAX, уходит в активную
  сессию (`sessionController.prompt`), ответ приходит обратно.
- **Команды**: `/status`, `/stop`, `/sessions`, `/use N`, `/current`, `/new [папка]`,
  `/model`, `/rename`, `/fork`, `/compact`, `/plan`, `/search`, `/archive`,
  `/pin`/`/unpin`, `/workspace`, `/approve`, `/budget`, `/cost`, `/health`,
  `/version`, `/ping`,
  `/help` (архивные сессии из Workspace в списке и дайджесте не показываются;
  меню команд — `PATCH /me/commands`).
- **Кнопки под ответом**: «Продолжить», «Стоп», «Открыть GUI».
- **Live-прогресс**: одно сообщение редактируется во время работы
  (инструмент, текст, таймер) + `typing_on`; удаляется в конце хода.
- **Подтверждения и вопросы из MAX**: waterfall-перехват
  `approval/request`/`user-questions/request` с `prepend`, гонка «MAX vs GUI»
  (`Promise.race`): кто ответил первым — тот и прав, вторая сторона получает
  «решено в другом месте». Таймаут/обрыв — fail-closed.
- **Файлы**: `deliverables/presented` загружается в MAX (`POST /uploads`) и
  приходит вложениями (изображения — фото, остальное — файлами).
- **Картинки из финального ответа** (v0.3.1): image-блоки сообщения,
  изображения из tool-результатов и упомянутые в тексте (`![alt](path)`,
  `./shot.png`, `https://…/pic.png`) уходят в MAX фотографиями; код-фрагменты
  игнорируются, дубли с `present` не отправляются.
- **Приём файлов из MAX** (v0.4.0): файл/фото, отправленный боту, скачивается
  в `<рабочая папка сессии>/max-inbox/`, агенту передаётся промпт с путями и
  типами (read/read_image); лимиты размера/количества, безопасные имена,
  отчёт об ошибках в чат.

### Надёжность и безопасность (v0.6)

- **Durable outbox**: финальные ответы и уведомления переживают недоступность
  MAX и перезагрузку плагина; exponential backoff, TTL 48 ч, приоритетная
  очередь, дедупликация по бизнес-ключу.
- **At-least-once long polling**: marker сдвигается только после обработки
  батча, обработанные update-id сохраняются — повторная доставка не создаёт
  второй промпт.
- **Глобальный лимитер**: 2 запроса/с на чат и 30/с суммарно; approvals и
  ошибки идут в critical-lane и не ждут очереди уведомлений.
- **Approvals без зависаний**: таймаут 120 с (настраивается) отклоняет запрос,
  карточка помечается «таймаут»; кнопка «Разрешить и запомнить» хранит правило
  для инструмента на 1 ч (только для явного `approvalRememberTools`).
- **Fail-closed**: без `allowedUserIds`/`allowedChatIds` интерактив (команды,
  approvals, polling) выключен; уведомления работают. Осознанный escape —
  `allowUnlistedUsers: true`.
- **Наблюдаемость**: `/health`, `/version`, `/ping`, heartbeat-файл,
  health snapshot (последний poll/ошибка, глубина outbox, ожидания лимитера),
  audit log `$DSH_HOME/max-notify/audit.jsonl` (0600), redaction токенов в логах.
- **Защита от флуда** входящих сообщений и единая очередь всех HTTP-вызовов MAX.

### Управление сессиями (v0.7)

- **`/model`** — каталог моделей с выбором по номеру или `provider/model`;
  **`/rename`**, **`/fork`** (ветка становится активной), **`/compact`**.
- **`/plan`** / **`/plan off`** / **`/plan status`** — режим плана; **review
  плана в MAX**: полный план приходит файлом `plan.md`, кнопки «Approve /
  Keep planning», свободный текст уходит агенту как фидбек.
- **`/search <текст>`** — поиск по содержимому сессий (результаты выбираются
  через `/use N`).
- **`/archive`** — архивирует текущую сессию и переключает на следующую;
  **`/pin`** / **`/unpin`**.
- **`/workspace`** — список рабочих папок; `/workspace N` задаёт папку для
  последующих `/new`, `/workspace add <path>` регистрирует новую.
- **`/approve`** — политика подтверждений (`ask`/`never`) с двухшаговым
  подтверждением.
- **Кнопки-пресеты** под финальным ответом: `buttonsPresets: [{label, prompt}]`.
- `/sessions` показывает заголовки и холодных сессий (projection cache).

### Стоимость и бюджет (v0.8)

- **`/budget`** (и `/cost`): бюджет, потрачено/осталось/период, стоимость
  сегодня/месяц/всего; если бюджет в `dsh-cost-meter` выключен — подсказка.
- **`/status`** и `/current` показывают стоимость за сегодня, стоимость сессии и
  процент бюджета.
- **Дайджест** включает стоимость и процент бюджета.
- **Алерты бюджета** 80%/100% (`budgetAlertThresholds`) — один раз за период,
  с сохранением в state и дедупликацией; 100% идёт critical-каналом.
- Read-only: ledger `$DSH_HOME/storages/cost-meter/ledger.json` не изменяется;
  нет файла/битая версия — просто нет блока стоимости.
- Настройки: `costMeterEnabled`, `costMeterFile`, `budgetAlertEnabled`,
  `budgetAlertThresholds`. Бюджет включается в настройках самого cost-meter.

## Быстрый старт

```bash
git clone https://github.com/enkolesnikov/MaxDSHBot.git
cd MaxDSHBot

cp .env.example .env && chmod 600 .env   # MAX_BOT_TOKEN=..., MAX_CHAT_ID=...
node dsh-max-notify/tools/pair.mjs       # узнать chat_id: нажать Start в диалоге с ботом
node dsh-max-notify/tools/send-test.mjs "проверка"

./dsh-max-notify/install.sh              # профиль web (или: ./install.sh tui)
```

Установка использует `dsh plugin --profile <p> add link:<путь>`: пакет
добавляется в `dsh.profile.bundles`, его `cordis.patch.yml` вставляет строку
`max-notify`, а DSH пересобирает профиль (HMR) или подхватывает при следующем
запуске.

**Приватные значения не коммитьте.** `botTokenFile`/`chatId`/`allowedUserIds`
лучше держать в собственном `cordis.patch.yml` профиля
(`$DSH_HOME/profiles/<p>/cordis.patch.yml`) как override строки с тем же `id`:

```yaml
- id: max-notify
  config:
    botTokenFile: /path/to/MaxDSHBot/.env
    chatId: 123456789
    allowedUserIds: [987654321]
```

Конфиг в override **заменяет объект целиком**.

## Конфигурация

Все ключи — в `dsh-max-notify/cordis.patch.yml` (или в override профиля):

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `botToken` / `botTokenFile` | env `MAX_BOT_TOKEN` | токен бота или файл с `MAX_BOT_TOKEN=...` |
| `chatId` / `userId` | env `MAX_CHAT_ID` | получатель (чат/диалог или user_id) |
| `format` | `markdown` | `markdown` / `html` / текст |
| `notify` | `true` | push-уведомления |
| `disableLinkPreview` | `true` | отправляется **query-параметром** (требование MAX) |
| `includeHeader` | `true` | строка `**DSH** · 22:15 · <заголовок>` |
| `includeTitle` | `true` | заголовок сессии (`ctx.get('sessionTitle')`), иначе папка |
| `includeSessionId` | `false` | короткий тег сессии в заголовке |
| `includeSubagents` | `false` | пересылать и дочерние агент-сессии |
| `allowedUserIds` / `allowedChatIds` | env `MAX_ALLOWED_USER_IDS` / `..._CHAT_IDS` | allowlist получателя, fail-closed |
| `skipReasons` | `[interrupted, forked]` | окончания хода, которые не пересылаются |
| `maxChars` | `3800` | предохранитель (жёсткий лимит API — 4000) |
| `enabled` / `dryRun` | `true` / `false` | выключатель / только лог |
| `requestTimeoutMs` / `maxRetries` / `minIntervalMs` | `15000` / `3` / `600` | транспорт |
| `notifyOnStart` | `false` | одноразовое «плагин подключён» в MAX |
| `polling` / `pollTimeoutSec` | `true` / `25` | long polling `GET /updates` (один поллер на токен) |
| `interactive` | `true` | приём сообщений/кнопок и команды |
| `approvalChannel` / `questionChannel` | `both` | `both` (MAX + GUI гонка), `max`, `gui` |
| `buttons` / `webUrl` | `true` / env `DSH_WEB_URL` | кнопки под ответом и ссылка на GUI |
| `buttonsPresets` | `[]` | пресеты-кнопки: `[{label, prompt}]` (до 4) |
| `progress` / `progressDelayMs` / `progressThrottleMs` / `typing` | `true` / `2500` / `2000` / `true` | live-карточка прогресса |
| `deliverables` | `true` | отправлять файлы из `present` вложениями |
| `forwardImages` / `forwardToolImages` / `maxImages` | `true` / `true` / `4` | картинки из ответа и tool-результатов |
| `receiveFiles` | `true` | принимать файлы/фото из MAX |
| `inboxDir` | `<cwd>/max-inbox` | папка для входящих (поддерживает `%cwd%`) |
| `maxIncomingFiles` / `maxIncomingBytes` | `4` / `25 MiB` | лимиты входящих вложений |
| `registerCommands` / `greetOnStart` | `true` / `true` | меню команд MAX и приветствие по Start |
| `newSessionDir` | — | папка для `/new` (по умолчанию — папка активной сессии) |
| `notifySubagents` / `notifyJobs` / `notifyGoals` / `notifyErrors` | `true` | уведомления о событиях |
| `todoProgress` | `true` | TODO-прогресс в MAX |
| `quietHours` | — | `{start: '23:00', end: '08:00'}` — без push ночью |
| `digestEnabled` / `digestTime` | `false` / `21:00` | ежедневный дайджест |
| `mode` | `all` | стартовый режим: `all`, `errors`, `mute` |
| `stateFile` | `$DSH_HOME/max-notify/state.json` | marker, активная сессия, health, dedupe-ключи (вне репозитория) |
| `outboxEnabled` / `outboxMaxItems` / `outboxTtlHours` | `true` / `200` / `48` | durable-очередь недоставленных сообщений |
| `outboxFile` | `$DSH_HOME/max-notify/outbox.json` | файл outbox (вне репозитория) |
| `ratePerChatPerSecond` / `rateGlobalPerSecond` | `2` / `30` | глобальный лимитер MAX API |
| `approvalTimeoutMs` | `120000` | таймаут approvals, `0` — ждать бесконечно |
| `approvalRememberTools` / `approvalRememberMs` | `[]` / `3600000` | «запомнить разрешение» только для явно перечисленных инструментов |
| `allowUnlistedUsers` | `false` | разрешить интерактив без allowlist (небезопасно) |
| `incomingPerMinute` / `incomingBurst` | `30` / `10` | защита от флуда входящих |
| `auditLog` / `auditFile` | `true` / `$DSH_HOME/max-notify/audit.jsonl` | аудит approvals/вопросов/команд |
| `heartbeatFile` | — | JSON-файл здоровья для внешнего мониторинга |
| `costMeterEnabled` / `costMeterFile` | `true` / `$DSH_HOME/storages/cost-meter/ledger.json` | read-only адаптер стоимости |
| `budgetAlertEnabled` / `budgetAlertThresholds` | `true` / `[80, 100]` | алерты бюджета (один раз за период) |

## Структура

| Путь | Что это |
|---|---|
| `dsh-max-notify/index.js` | cordis-плагин: `name`, `inject`, `apply(ctx, config)` |
| `dsh-max-notify/lib/transport.mjs` | клиент MAX Bot API на `node:https` с встроенным CA |
| `dsh-max-notify/lib/extract.mjs` | видимый текст ассистента и разбор `turn/end` |
| `dsh-max-notify/lib/format.mjs` | заголовок и тело уведомления |
| `dsh-max-notify/certs/ca-chain.pem` | Russian Trusted Sub CA + Root CA |
| `dsh-max-notify/cordis.patch.yml` | bundle-patch: вставка строки `max-notify` |
| `dsh-max-notify/lib/bot.mjs` | long polling, команды, маршрутизация сообщений |
| `dsh-max-notify/lib/interactions.mjs` | approvals/вопросы/кнопки, гонка MAX vs GUI |
| `dsh-max-notify/lib/progress.mjs` | live-карточка прогресса и typing |
| `dsh-max-notify/lib/deliverables.mjs` | uploads файлов из `present` |
| `dsh-max-notify/lib/state.mjs` | marker, сессии, health, dedupe-ключи, approval-правила (вне репозитория) |
| `dsh-max-notify/lib/limits.mjs` | глобальный лимитер MAX API (2/с на чат, 30/с) |
| `dsh-max-notify/lib/outbox.mjs` | durable-очередь с retry и дедупликацией |
| `dsh-max-notify/lib/health.mjs` | health snapshot для `/health` и heartbeat |
| `dsh-max-notify/lib/audit.mjs` | JSONL-аудит решений (0600) |
| `dsh-max-notify/lib/redact.mjs` | redaction токенов в логах |
| `dsh-max-notify/lib/cost-meter.mjs` | read-only адаптер ledger dsh-cost-meter |
| `dsh-max-notify/CHANGELOG.md` | история версий |
| `ROADMAP.md` | дорожная карта 0.6 → 1.0 |
| `dsh-max-notify/lib/policy.mjs` | режимы уведомлений и тихие часы |
| `dsh-max-notify/lib/observer.mjs` | события, TODO-прогресс и дайджест |
| `dsh-max-notify/tools/` | `pair.mjs` (chat_id), `send-test.mjs` |
| `dsh-max-notify/test/` | `node --test` (187 тестов) |
| `research/` | как писать плагины DSH, MAX Bot API, каталог фич |

## Ограничения

- Пересылается только финальный текст хода (не стрим и не tool-шаги).
- MAX markdown не поддерживает списки/таблицы: `- пункт` отрисуется текстом.
- **Fail-closed**: без `allowedUserIds`/`allowedChatIds` интерактив выключен
  (уведомления идут). Это защита от «кто угодно управляет агентом»; вернуть
  старое поведение можно `allowUnlistedUsers: true`, но тогда бот открыт всем,
  кто знает чат.
- Приём сообщений — long polling (`GET /updates`): **один поллер на токен**;
  запущенный `tools/pair.mjs` конкурирует с плагином за события. Webhook —
  в дорожной карте (0.9): MAX требует публичный HTTPS :443 с доверенным
  сертификатом; nginx с Let's Encrypt на этом сервере уже готов.
- Approvals по умолчанию истекают через 120 с (fail-closed). Если нужно ждать
  дольше — `approvalTimeoutMs: 0`.
- Outbox гарантирует **at-least-once**: при сбое между отправкой и записью
  ключа возможен повтор; дедупликация закрывает типовые случаи (reload,
  повторный батч polling).
- Approvals/вопросы в режиме `both` гоняются с Web GUI: кто ответил первым, тот
  и прав; карточка в проигравшем канале помечается «решено в другом месте».
- `interactive`/`polling` требуют `sessionController` (есть в web-профиле);
  без него остаются уведомления и кнопки, но не команды/инъекция промптов.
- **Всё, что агент пишет, уходит на серверы MAX.** Для чувствительных сессий —
  `enabled: false` или `dryRun: true`.
- Один `chatId` на строку `max-notify`; для нескольких получателей — отдельные
  профили/патчи.

## Проверка

```bash
cd dsh-max-notify && npm test          # 187 unit test
node tools/send-test.mjs "проверка"    # реальная отправка
DSH_HOME=$HOME/.dsh dsh --profile web --dump-config | grep -A12 'id: max-notify'
```

TLS-цепочка проверена `openssl verify` (leaf → Russian Trusted Sub CA →
Russian Trusted Root CA), живая отправка — HTTP 200 с `mid`, серверный
markdown-разбор (`strong`, `monospaced`, `link`) подтверждён `GET /messages`.

## Исследование

- [research/dsh/plugin-api.md](research/dsh/plugin-api.md) — как устроены
  плагины DSH (entry, config, события, установка/HMR), 900+ строк с file:line.
- [research/max/max-api.md](research/max/max-api.md) — MAX Bot API: auth, TLS,
  сообщения, лимиты, pairing.
- [research/max/max-interactive.md](research/max/max-interactive.md) —
  интерактивный бот: `/updates`, webhook, правка сообщений, кнопки/callback,
  команды, uploads, typing.
- [research/messenger-features.md](research/messenger-features.md) — каталог
  возможностей и план развития (двусторонний чат, approvals, live-прогресс).

## Лицензия

MIT — см. [LICENSE](LICENSE).
