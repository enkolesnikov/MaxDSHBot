# Дорожная карта `dsh-max-notify`

Текущая версия: **0.8.0** (надёжность, управление, стоимость и бюджет). План рассчитан на
DSH 0.2.x (проверено на 0.2.2-rc.1, Node 24.9+).

Цель: из «уведомлятора + пульта» сделать надёжный продукт: доставка без
потерь/дублей, approvals без зависаний, безопасные дефолты, полное управление
сессиями, стоимость/бюджет, production-транспорт, публикация.

## Статус

| Версия | Тема | Ключевой результат | Статус |
|---|---|---|---|
| **0.6** | Надёжность и безопасность | outbox, dedupe, глобальный лимитер, таймаут approvals, fail-closed, `/health`, manifest | ✅ реализовано |
| **0.7** | Полное управление | `/model`, `/rename`, `/fork`, `/compact`, `/plan` + review, `/search`, `/archive`, `/pin`, `/workspace`, кнопки-пресеты | ✅ реализовано |
| **0.8** | Стоимость и бюджет | read-only адаптер `cost-meter` ledger, `/budget`, стоимость в `/status` и дайджесте, алерты 80/100 % | ✅ реализовано |
| **0.9** | Production-транспорт и публикация | webhook через `webServer`, npm-пакет, locale/icon, маркет, GitHub release | планируется |
| **1.0** | UX-продукт | настройки в GUI, таблицы→файлы, reply-ветки сессий, forwarded, native-картинки, голос STT/TTS, `/schedules` | планируется |
| 1.1+ | Backlog | несколько чатов/роли, MAX Mini App, proxy, unattended read-only/auto, `/diff`, отправка локальных файлов, локальный whisper | backlog |

## 0.6 — сделано

- Durable outbox с retry/backoff/TTL/priority и дедупликацией.
- Глобальный лимитер: 2 запроса/с на чат, 30/с глобально, critical-lane.
- Long polling at-least-once: marker после обработки, dedupe ключей обновлений.
- Таймаут approvals (120 с по умолчанию) и «запомнить для инструмента» (TTL 1 ч,
  только явный allowlist, audit).
- Fail-closed: без `allowedUserIds`/`allowedChatIds` интерактив выключен
  (`allowUnlistedUsers: true` — осознанный escape).
- `/health`, `/version`, `/ping`; health snapshot, heartbeat-файл, audit log,
  redaction токенов в логах, flood-protection входящих.
- Упаковка: `engines.dsh`, `dsh.manifestVersion`, repository/keywords,
  CHANGELOG; 161 тест, CI с `npm run check` + `npm test` + `npm pack --dry-run`.

## 0.7 — управление сессиями

1. `/model` через `sessionController.modelCatalog()` + `selectModel()`.
2. `/rename`, `/fork`, `/compact` (`commands.execute`), `/plan`/`/plan off`.
3. Карточка review плана: перехват `user-questions/request` с
   `intent.kind === 'plan-review'`, полный план `.md`-вложением + кнопки
   «Approve / Keep planning» + свободный фидбек.
4. `/sessions` с заголовками холодных сессий (`projections().values.title`),
   `/search`, `/archive`, `/pin`/`/unpin`, `/workspace` (list/create/switch).
5. `/approve` — политика approvals (`overrideOf`/`setPolicy`) с подтверждением.
6. Кнопки-пресеты под финальным ответом (`buttons.presets`).

## 0.8 — стоимость и бюджет

1. Read-only адаптер `$DSH_HOME/storages/cost-meter/ledger.json` (version 1,
   size cap, graceful degradation): сегодня/период, сессия, `config.currency`,
   `config.budget {enabled, amount, period, customStart, customEnd}`.
2. `/status` и `/budget` со стоимостью/процентом бюджета; строка в дайджесте.
3. Алерты ≥80 % и ≥100 % (один раз за период, с учётом `/mode`).

## 0.9 — production-транспорт и публикация

1. Webhook: `webServer.register('/max/webhook')`, secret constant-time, ack
   <1 с, очередь+dedupe, `POST/DELETE /subscriptions`, `update_types`,
   `bot_admin_permissions_changed`; nginx с LE-сертификатом уже проксирует 443.
2. npm publish `dsh-max-notify` (имя свободно): `engines.dsh`,
   `dsh.manifestVersion`, locale en/zh, icon, README-бейджи, GitHub release;
   заявка в каталог плагинов.
3. CI: `npm run check`, `npm test`, `npm pack --dry-run`.

## 1.0 — UX-продукт

1. Страница настроек (host RPC + client bundle, паттерн `dsh-notify-plugin`).
2. Таблицы из финального ответа → CSV/MD файлами (zero-dep).
3. Reply-ветки: якорное сообщение на сессию, ответы агента `link.reply`,
   маршрутизация ответа пользователя в сессию.
4. Forwarded unwrap; входящие картинки — нативными image-партами, если route
   поддерживает.
5. Голос: опциональные STT/TTS через OpenAI-совместимый endpoint.
6. `/schedules` (list/pause/delete через `ctx.schedule`), «молчать, если нечего
   сообщать».

## Практики, заложенные в дизайн

1. At-least-once + идемпотентность (OpenClaw MAX, MAX webhook retries).
2. Approvals без зависаний (MiMoCode: auto-reject по таймауту).
3. Scope approvals «запомнить для инструмента» (LinkGravity).
4. Сессии как ветки через reply (LinkGravity).
5. Таблицы — файлами (LinkGravity: image/CSV/MD; у нас zero-dep → CSV/MD).
6. Расписания и тихие проверки (LinkGravity).
7. Хранение секретов: env/файл/SecretRef, настройки — отдельным RPC-маршрутом.
8. Marketplace-метаданные: `manifestVersion`, `engines.dsh`, locale/icon.
9. Webhook-безопасность: constant-time secret, полная TLS-цепочка, ack <30 с.
10. Наблюдаемость: health, outbox depth, rate-limit waits, audit.

## Ссылки

- [MAX Agent Skill — webhooks/security](https://github.com/max-messenger/max-agents-skill)
- [MAX API changelog](https://dev.max.ru/docs-api/changelog-api)
- [LinkGravity](https://github.com/dev-sseul/linkgravity)
- [MiMoCode Telegram bot](https://github.com/morandot/mimocode-telegram-bot)
- [OpenClaw MAX channel](https://www.npmjs.com/package/@olegbalbekov/openclaw-max)
- [dsh-notify-plugin](https://www.npmjs.com/package/dsh-notify-plugin)
