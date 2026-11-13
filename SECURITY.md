# Безопасность

## Секреты

В репозитории **не должно быть** токенов и персональных идентификаторов:

- токен бота MAX хранится только в `.env` (gitignored) или в файле, на который
  указывает `botTokenFile`; в примерах — `replace_with_your_max_bot_token`;
- личный конфиг (`chatId`, `allowedUserIds`, путь к `.env`) — в
  `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, а не в этом репозитории;
- состояние плагина (marker поллинга, активная сессия) — в
  `$DSH_HOME/max-notify/state.json` (вне репозитория);
- переменные окружения — через `.env`/systemd, не через код.

После клонирования создайте свой `.env` из `.env.example` (`chmod 600`).

## Ограничение доступа

- `allowedUserIds` / `allowedChatIds` включают fail-closed режим: плагин
  проверяет `GET /chats/{chatId}`, что это личный диалог разрешённого
  пользователя, и не отправляет никуда больше.
- Входящие сообщения из MAX принимаются только от разрешённого `user_id`;
  остальные игнорируются.
- Approvals/вопросы решаются по принципу «первый ответивший канал» (MAX или Web
  GUI); при отсутствии ответа — fail-closed.
- **С v0.6 интерактив fail-closed по умолчанию**: если `allowedUserIds` и
  `allowedChatIds` пусты, команды, approvals и long polling выключаются
  (уведомления продолжают работать). Включать `allowUnlistedUsers: true` можно
  только осознанно: любой участник чата сможет управлять агентом.
- **Таймаут approvals** (`approvalTimeoutMs`, 120 с): неотвеченный запрос
  отклоняется, а не висит вечно. «Запомнить разрешение» доступно только для
  инструментов из явного `approvalRememberTools` и живёт 1 ч (настраивается).
- **`/approve never`** отключает запросы подтверждений для сессии — это
  понижает защиту. Команда требует второго подтверждения (`... confirm`),
  действует только для allowlisted-пользователя и видна в audit-логе.
- **Аудит**: решения по approvals/вопросам и команды пишутся в
  `$DSH_HOME/max-notify/audit.jsonl` (0600) — только метаданные, без текстов
  сообщений и секретов.
- **Redaction**: токен бота, `?r=`-креды загрузки и `Authorization` вычищаются
  из логов (`lib/redact.mjs`).
- **Durable outbox** хранится в `$DSH_HOME/max-notify/outbox.json` (вне
  репозитория); в нём текст сообщений — как и state, это приватные данные
  пользователя, доступ ограничен правами `$DSH_HOME`.

## Webhook

- Включайте `transport: webhook` только с `webhookSecret` (32–256 символов `[A-Za-z0-9_-]`
  `[A-Za-z0-9_-]`); заголовок `X-Max-Bot-Api-Secret` сравнивается в
  constant-time, при несовпадении — `401`.
- Маршрут `/max/webhook` отвечает `200` только после durable-записи обновления
  в `state.json`; ограничение тела — 1 МиБ, при переполнении `413`.
- Публичный URL обязан быть `https://`; сертификат и домен проверяет MAX.
  Nginx/Let's Encrypt на этом сервере уже настроены; long polling и webhook
  взаимоисключающие.
- Подписку можно удалить: `tools/webhook.mjs unsubscribe` или
  `webhookRemoveOnStop: true`.

## Если токен утёк

1. Отзовите токен в MAX: business.max.ru → Чат-боты → настройки бота.
2. Выпустите новый и обновите `.env` / `botTokenFile`.
3. Проверьте, что `.env` не попал в git (`git log --all -- .env`).

## Сообщить об уязвимости

Используйте GitHub Security Advisories («Report a vulnerability» в разделе
Security этого репозитория) вместо публичного issue.

## Дополнительно с 1.6

- `allowedChatIds` без `allowedUserIds` — явное доверие всему чату; если заданы
  оба списка, отправитель должен быть и в `allowedUserIds`.
- Бот-токен отправляется только на `platform-api2.max.ru` и `*.max.ru`; на
  pre-signed CDN URL — без `Authorization`; cross-host redirect отклоняется.
- `state.json`, `outbox.json`, `health.json`, `max-inbox/` — 0600/0700.
- STT/TTS endpoint и модель не редактируются через GUI-overlay (только
  приватный профиль), чтобы нельзя было перенаправить API-ключ.
- Deliverable cap — 50 МиБ (защита от OOM); webhook poison update уходит в
  dead-letter после 3 попыток.
