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

## Структура

| Путь | Что это |
|---|---|
| `dsh-max-notify/index.js` | cordis-плагин: `name`, `inject`, `apply(ctx, config)` |
| `dsh-max-notify/lib/transport.mjs` | клиент MAX Bot API на `node:https` с встроенным CA |
| `dsh-max-notify/lib/extract.mjs` | видимый текст ассистента и разбор `turn/end` |
| `dsh-max-notify/lib/format.mjs` | заголовок и тело уведомления |
| `dsh-max-notify/certs/ca-chain.pem` | Russian Trusted Sub CA + Root CA |
| `dsh-max-notify/cordis.patch.yml` | bundle-patch: вставка строки `max-notify` |
| `dsh-max-notify/tools/` | `pair.mjs` (chat_id), `send-test.mjs` |
| `dsh-max-notify/test/` | `node --test` (33 теста) |
| `research/` | как писать плагины DSH, MAX Bot API, каталог фич |

## Ограничения

- Пересылается только финальный текст хода (не стрим и не tool-шаги).
- MAX markdown не поддерживает списки/таблицы: `- пункт` отрисуется текстом.
- Отправка односторонняя; для приёма сообщений нужен webhook (публичный HTTPS
  :443 с сертификатом, которому доверяет MAX) либо long polling в отдельном
  цикле. Текущая версия использует long polling только в `tools/pair.mjs`.
- **Всё, что агент пишет, уходит на серверы MAX.** Для чувствительных сессий —
  `enabled: false` или `dryRun: true`.
- Один `chatId` на строку `max-notify`; для нескольких получателей — отдельные
  профили/патчи.

## Проверка

```bash
cd dsh-max-notify && npm test          # 33 unit tests
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
