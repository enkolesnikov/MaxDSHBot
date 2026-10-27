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
- **Команды**: `/status`, `/stop`, `/sessions`, `/use N`, `/current`, `/help`
  (архивные сессии из Workspace в списке и дайджесте не показываются)
  (меню команд регистрируется через `PATCH /me/commands`).
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
| `progress` / `progressDelayMs` / `progressThrottleMs` / `typing` | `true` / `2500` / `2000` / `true` | live-карточка прогресса |
| `deliverables` | `true` | отправлять файлы из `present` вложениями |
| `forwardImages` / `forwardToolImages` / `maxImages` | `true` / `true` / `4` | картинки из ответа и tool-результатов |
| `receiveFiles` | `true` | принимать файлы/фото из MAX |
| `inboxDir` | `<cwd>/max-inbox` | папка для входящих (поддерживает `%cwd%`) |
| `maxIncomingFiles` / `maxIncomingBytes` | `4` / `25 MiB` | лимиты входящих вложений |
| `registerCommands` / `greetOnStart` | `true` / `true` | меню команд MAX и приветствие по Start |
| `notifySubagents` / `notifyJobs` / `notifyGoals` / `notifyErrors` | `true` | уведомления о событиях |
| `todoProgress` | `true` | TODO-прогресс в MAX |
| `quietHours` | — | `{start: '23:00', end: '08:00'}` — без push ночью |
| `digestEnabled` / `digestTime` | `false` / `21:00` | ежедневный дайджест |
| `mode` | `all` | стартовый режим: `all`, `errors`, `mute` |
| `stateFile` | `$DSH_HOME/max-notify/state.json` | marker и активная сессия (вне репозитория) |

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
| `dsh-max-notify/lib/state.mjs` | marker, активная сессия, режим, дата дайджеста (вне репозитория) |
| `dsh-max-notify/lib/policy.mjs` | режимы уведомлений и тихие часы |
| `dsh-max-notify/lib/observer.mjs` | события, TODO-прогресс и дайджест |
| `dsh-max-notify/tools/` | `pair.mjs` (chat_id), `send-test.mjs` |
| `dsh-max-notify/test/` | `node --test` (112 тестов) |
| `research/` | как писать плагины DSH, MAX Bot API, каталог фич |

## Ограничения

- Пересылается только финальный текст хода (не стрим и не tool-шаги).
- MAX markdown не поддерживает списки/таблицы: `- пункт` отрисуется текстом.
- Приём сообщений — long polling (`GET /updates`): **один поллер на токен**;
  запущенный `tools/pair.mjs` конкурирует с плагином за события. Для
  production MAX рекомендует webhook (публичный HTTPS :443 с сертификатом,
  которому доверяет MAX) — тогда polling в плагине надо выключить (`polling: false`).
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
cd dsh-max-notify && npm test          # 112 unit tests
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
