# MAX Bot API: что изменилось в 2026

Короткая выжимка по официальной документации MAX, которая влияет на
`dsh-max-notify`. Проверено **2026-11-24** по
[истории изменений API](https://dev.max.ru/docs-api/changelog-api),
[общему описанию](https://dev.max.ru/docs-api/),
[медиафайлам](https://dev.max.ru/docs-api/use-cases/sending-messages/media/) и
страницам методов. Ссылки — в конце файла.

## Хронология

| Дата | Изменение |
|---|---|
| 25.05.2026 | Webhook только по HTTPS и только с доверенным сертификатом: HTTP и самоподписанные сертификаты не поддерживаются, порт — только 443 |
| Июнь 2026 | `GET /chats` (список чатов) удалён; добавлены ограничения на размеры медиа для `POST /uploads` |
| 19.07.2026 | Обязателен домен `platform-api2.max.ru` (вместо `platform-api.max.ru`) + сертификат Минцифры в trust store |
| Июль 2026 | Добавлен `PATCH /me/commands` — команды бота одним методом |
| Август 2026 | Comments API и события `comment_created` / `comment_removed` / `comment_edited`; параметр `description` в `PATCH /chats/{chatId}`; `disable_link_preview` в `POST /answers` |
| 09.09.2026 | Ограничена работа `POST /chats/{chatId}/members` |
| Сентябрь 2026 | Опубликована OpenAPI-спецификация: [max-messenger/api-schema](https://github.com/max-messenger/api-schema) |
| Октябрь 2026 | Событие `bot_admin_permissions_changed` (только webhook); выпущен официальный навык для AI-агентов [max-messenger/max-agents-skill](https://github.com/max-messenger/max-agents-skill) |
| Ноябрь 2026 | В ответах с `success: false` появилось поле `code`; у `bot_added` удалено поле `user`; ограничение длины имени файла при загрузке; уточнён `notify` |

## Домен, TLS и токен

- База API — `https://platform-api2.max.ru`. Старый `platform-api.max.ru`
  больше не гарантирован; с 19.07.2026 новый домен обязателен.
- `platform-api2.max.ru` цепочкой уходит в Russian Trusted Root CA
  (Минцифры). В стандартных trust store его нет — клиент должен добавить
  корневой/промежуточный сертификат сам.
- Токен передаётся **только** заголовком `Authorization: <access_token>`,
  без `Bearer`. Передача токена query-параметром больше не поддерживается.

## Ошибки: HTTP 200 с `success: false`

HTTP 200 означает «запрос дошёл и обработан», но не «операция выполнена».
Для части методов ошибка приходит с кодом 200 и телом
`{"success": false, "code": "...", "message": "..."}`:

- bots: `POST /subscriptions`, `DELETE /subscriptions`;
- chats: `POST /chats/{chatId}/members`, `DELETE /chats/{chatId}/members`,
  `DELETE /chats/{chatId}/members/me`, `DELETE /chats/{chatId}/pin`,
  `POST /chats/{chatId}/actions`;
- messages: `PUT /messages`, `DELETE /messages`.

Остальные методы возвращают ошибку обычным 4xx. Коды 5xx приходят без
стандартного тела. Поле `code` — строка вида `some.error`
(примеры: `not.found`, `chat.denied`, `proto.payload`). Разработчиков,
которые определяли ошибку по `message`, просят перейти на `code`.

Вывод: проверять нужно и HTTP-статус, и тело ответа; 200 сам по себе не успех.

## Удалено и ограничено

- **`GET /chats` удалён (июнь 2026).** Готового способа получить список всех
  групповых чатов и каналов, куда добавлен бот, нет. `chat_id` получают из
  событий: подписка `POST /subscriptions` или `GET /updates`, события
  `bot_added` / `bot_started`, а хранить и поддерживать список чатов должен
  разработчик (обрабатывать дубли и `bot_removed`). Long polling для
  получения списка чатов не предусмотрен.
  Нюанс: в шапке changelog формулировка «используйте `POST /subscriptions`»
  звучит как готовый список, но страница «Получение ID чата или канала»
  уточняет — перечисления чатов API не даёт, только события с `chat_id`.
- **`POST /chats/{chatId}/members` ограничен с 09.09.2026.** Публично
  детали ограничения не расписаны; для интеграций это значит: не строить
  сценарии на массовом добавлении участников.
- **`bot_added.user` удалён (ноябрь 2026).** В `GET /updates` при
  `update_type=bot_added` больше не возвращается объект `User`
  (и свойство `user` убрано из объекта `Update` для этого типа).
  У `bot_started` поле `user` осталось.
- **`type=photo` больше не поддерживается** в `POST /uploads` — использовать
  `type=image`.

## Новые возможности

- `PATCH /me/commands` — добавление, изменение и удаление команд бота
  (до 32 команд, `name` 1–64, `description` 1–128 символов).
- Comments API для постов в каналах (август 2026): `POST` / `GET` / `PUT` /
  `DELETE /messages/{messageId}/comments` и
  `GET /messages/{messageId}/comments/{commentId}`; события
  `comment_created`, `comment_removed`, `comment_edited`.
- `PATCH /chats/{chatId}` с параметром `description` — описание чата/канала.
- `disable_link_preview` в `POST /answers` — управление превью ссылок
  (query-параметр; в `PUT` методов его нет).
- `GET /messages/{messageId}` и `GET /videos/{videoToken}` — получение одного
  сообщения и данных видео (URL воспроизведения, метаданные). В плагине это
  методы клиента `getMessage(messageId)` / `getVideo(videoToken)` (с v1.11).
- `bot_admin_permissions_changed` — изменение прав бота-администратора в
  канале или групповом чате (октябрь 2026). Доставляется **только через
  webhook**; для длинного опроса недоступно.
- Официальный навык `max-agents-skill` для AI-агентов и OpenAPI-схема в
  репозитории `max-messenger/api-schema` (сентябрь–октябрь 2026).

## Медиа и загрузка

Типы вложений и лимиты `POST /uploads`:

| `type` | Форматы | Лимит |
|---|---|---|
| `image` | JPG, JPEG, PNG, GIF, TIFF, BMP, HEIC | до 50 МБ **и** до 7680 × 7680 px (оба условия) |
| `video` | MP4, MOV, MKV, WEBM | до 250 МБ |
| `audio` | MP3, M4A и другие | до 256 МБ **и** до 60 минут (оба условия) |
| `file` | TXT, DOC, PDF, распространённые форматы | до 4 ГБ |

- Имя загружаемого файла любого типа — **не более 200 символов**.
- Два режима загрузки: **multipart** (`Content-Type: multipart/form-data`,
  файл целиком, без возобновления) и **resumable** (любой другой/пустой
  `Content-Type`, загрузка частями и возобновление с последней успешной части;
  детали — `Content-Range`, статус через `GET` по upload-URL — в официальном
  навыке MAX).
- `POST /uploads` возвращает `url` (у каждого файла свой; хост не
  фиксирован) и токен. Один токен — один файл; токен можно переиспользовать.
- В одном сообщении — не более 12 вложений `image` + `video`.

## Лимиты запросов

- `POST /messages`: до **2 сообщений в секунду** в один диалог/чат/канал.
- Текст сообщения — до **4000 символов**.
- Общий лимит платформы — **30 запросов в секунду** на
  `platform-api2.max.ru`. Источник — официальный навык MAX
  (`references/bot-api.md`, сверено 21.09.2026): в проверенных разделах
  dev.max.ru это число не приводится, поэтому лимит считаем равным 30 rps
  **на токен бота**.
- Long polling: `timeout` 0–90 с (по умолчанию 30), `limit` 1–1000;
  минимальный интервал между запросами — 300 мс (по официальному навыку).
- `POST /answers`: до 2 ответов в секунду на диалог/чат/канал
  (по официальному навыку MAX).
- Webhook: ответ `HTTP 200` за 30 с, иначе до 10 повторов с интервалом
  ×2,5 (60 с, 150 с, 375 с, …); после 8 часов неудач — автоматическая
  отписка.

## Что плагин уже делает

| Требование API | В `dsh-max-notify` |
|---|---|
| `platform-api2.max.ru` + Минцифры CA | база по умолчанию, встроенная цепочка `certs/ca-chain.pem` |
| Токен только в `Authorization` | так и отправляется; query-токен не используется |
| Не более 2 сообщений/с на чат, 30 rps суммарно | лимитер: `ratePerChatPerSecond: 2`, `rateGlobalPerSecond: 30` |
| Текст до 4000 символов | чанкинг абзацами (`maxChars: 3800`), жёсткий лимит API — 4000 |
| `PATCH /me/commands` | `setCommands()` (меню бота, ≤32 команд) |
| HTTP 200 + `success: false` | с v1.11 считается ошибкой (`MaxApiError` с `code`/`message`) для всех методов из списка выше |
| `bot_added` без `user` | плагин у этого события использует только `chat_id` (лог); `update.user` нужен только `bot_started`, где он остался |
| `GET /chats` удалён | не используется: `chat_id` берётся из конфига и из `GET /updates` (`tools/pair.mjs`) |
| Webhook только HTTPS | регистрируется на публичном HTTPS-эндпоинте DSH (MAX принимает только HTTPS :443); без secret или `webServer` — fallback на polling |
| Имя файла ≤ 200 символов | с v1.11 обрезается с сохранением расширения |
| `GET /messages/{id}`, `GET /videos/{token}` | методы клиента `getMessage(messageId)` / `getVideo(videoToken)` (v1.11) |
| `bot_admin_permissions_changed` | пишется `warn`-лог с `chat_id` и сводкой прав, health получает `lastAdminPermissionsAt` / `lastAdminPermissionsEvent`; long polling это событие не получает |

## Что осознанно не используется

- **Comments API** — плагин не публикует посты и не модерирует комментарии;
  события `comment_*` не подписываются. Появится отдельная задача — тогда
  добавлять.
- **Управление участниками и админами чата** (`POST/DELETE
  /chats/{chatId}/members`, `.../members/admins`) — плагин не управляет
  составом чата: массовые операции и авто-добавление не нужны.
- **Закрепы чата** (`PUT/DELETE /chats/{chatId}/pin`) — `/pin` в плагине
  закрепляет **сессию DSH**, а не сообщение в MAX.
- **`PATCH /chats/{chatId}`** (в т.ч. `description`) — плагин не меняет
  настройки чужих чатов/каналов.
- **Resumable upload** — плагин грузит вложения multipart одним запросом:
  проще, без состояния на диск; для больших файлов есть `file` до 4 ГБ, но
  докачка не реализована.
- **`getVideo()` в основном потоке** — метод добавлен в клиент для полноты и
  внешних сценариев, но скачивание/пересылка видео автоматически не
  выполняется.
- **Long polling как production-транспорт** — MAX прямо рекомендует webhook
  для production; polling остаётся fallback и удобен для локальной отладки
  и `tools/pair.mjs`.

## Источники

- [История изменений MAX Bot API](https://dev.max.ru/docs-api/changelog-api)
- [Общее описание: домен, авторизация, ошибки, OpenAPI](https://dev.max.ru/docs-api/)
- [Медиафайлы: типы, лимиты, multipart и resumable](https://dev.max.ru/docs-api/use-cases/sending-messages/media/)
- [Подписка на webhook: HTTPS/TLS, 25.05.2026, secret, повторы](https://dev.max.ru/docs-api/methods/POST/subscriptions/)
- [Получение ID чата или канала (вместо удалённого `GET /chats`)](https://dev.max.ru/docs-api/use-cases/getting-chat-id/)
- [`GET /updates`: long polling, `timeout`, `marker`, `bot_added`](https://dev.max.ru/docs-api/methods/GET/updates/)
- [`POST /messages`: 4000 символов, 2 сообщения/с, `notify`](https://dev.max.ru/docs-api/methods/POST/messages/)
- [`PATCH /me/commands`](https://dev.max.ru/docs-api/methods/PATCH/me/commands/)
- [`GET /messages/{messageId}`](https://dev.max.ru/docs-api/methods/GET/messages/-messageId-/)
- [`GET /videos/{videoToken}`](https://dev.max.ru/docs-api/methods/GET/videos/-videoToken-/)
- [`POST /answers` (`disable_link_preview`)](https://dev.max.ru/docs-api/methods/POST/answers/)
- [OpenAPI-схема MAX](https://github.com/max-messenger/api-schema)
- [MAX Messenger Agent Skill](https://github.com/max-messenger/max-agents-skill)
