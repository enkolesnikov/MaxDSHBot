# Аудит 1.6

Проведён тремя независимыми аудитами (безопасность, надёжность/совместимость,
качество/техдолг) + исправления Lead. Шрифт/тема MAX не оценивались.

## Исправлено

| Зона | Проблема | Фикс |
|---|---|---|
| DSH rc.2 | `getService('webServer')` в apply до активации сервиса → webhook 405, settings 404, тихий polling | `ctx.inject(['webServer'])` / `['connection','webServer']`, fallback, health-диагностика, route lifecycle |
| P0 транспорт | `AUDIO_EXTENSIONS` undefined → не-картинки из `present` терялись | `classifyUploadType` из workspace-tools + тест |
| P1 транспорт | `sendMessage` не передавал `chatKey/priority` → per-chat лимит/critical полоса мертвы | передача в `request` |
| Allowlist | проверялся только для финалов; transient `getChat` кэшировался навсегда | guarded client на все send/upload/edit; retry transient |
| Группы | `allowedChatIds` позволял любому участнику управлять агентом | при обоих списках sender обязан быть в `allowedUserIds` |
| Токен | `Authorization` уходил на произвольные https-хосты и redirect | host allowlist `platform-api2.max.ru`/`*.max.ru`, no auth на CDN, redirect reject |
| Webhook | 200 до durable save; poison update клинил очередь | `state.save()` до 200; dead-letter после 3 попыток |
| Webhook secret | принимался любой | 32–256 `[A-Za-z0-9_-]`, иначе fallback polling |
| GUI | voice endpoint/TTS можно было перенаправить через overlay | ключи убраны из overlay; endpoint только в приватном профиле |
| Файлы | state/outbox/heartbeat/inbox 0644 | 0600/0700, corrupt-файлы в `.corrupt-*` |
| Outbox | pending/delivered дубли | skip pending/delivered, dedupe
| Lifecycle | `bot.stop()` ставил disposed до `start()` | `stopPolling()` отдельно |
| CI/гигиена | refs/original с chat id, личные каталоги, CI write token | refs удалены, `.gitignore`, `permissions: contents: read`, concurrency/timeout |
| UX/тесты | 358 тестов; `uploadTypeFor`/allowlist/rc.2/secret покрыты | +5 тестов |

## Отложено (1.7)

1. Распил `index.js` (2051 строка): `lib/config.mjs` первым, затем forwarding/
   final-delivery/host-фасад/events/lifecycle.
2. Удаление мёртвой standalone HTML-страницы настроек (~300 строк, только тесты).
3. Единый `target/send-params` и `formatMoney/formatCost` хелперы.
4. State schema migration/fsync/queue-by-bytes; full async shutdown.
5. Полный контрактный тест клиента с локальным HTTPS-сервером и Node 20 CI.
6. Реальный cold start `dsh-web` с проверкой webhook в первые секунды (после
   согласованного окна рестарта).

## Проверки

- `npm test`: 358/358.
- 1.6.1: `lib/config.mjs` вынесен из `index.js` (324 строки), поведение без изменений.
- `npm run check`: OK; `npm pack --dry-run`: 45 файлов.
- Live hot-reload: `transport=webhook`, `webhookActive=true`, `webhookSubscribed=true`,
  `/max/webhook` → 401 без секрета, `/max-notify/settings.json` → 401 без cookie.
- История/оффлайн: старые SHA 422/404; свежий клон — 0 sensitive-совпадений.
