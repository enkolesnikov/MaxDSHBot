# MAX Bot API: интерактивный бот (кнопки, callback, команды, медиа, webhook)

Собрано 2026-10-27. База: `https://platform-api2.max.ru`, `Authorization: <token>` (без `Bearer`).
Источники: официальная OpenAPI-схема [`max-messenger/api-schema/schema.yaml`](https://github.com/max-messenger/api-schema)
(далее «схема») + страницы `dev.max.ru/docs-api/*.index.md` (далее «docs»).
Пометки: **[live]** — проверено реальным запросом ботом `@your_bot` в диалоге `chat_id 123456789`;
**[docs]** — только по документации.

---

## 0. TL;DR

| Вопрос | Ответ |
|---|---|
| Приём событий | `GET /updates` (long polling, dev) **или** webhook `POST /subscriptions` (только HTTPS:443, prod). Одновременно — нельзя |
| Кнопки | `attachments: [{type:"inline_keyboard", payload:{buttons:[[Button,...],...]}}]` в `POST /messages` **[live]** |
| Нажатие | update `message_callback` → `callback.callback_id` + `callback.payload` |
| Ответ на нажатие | `POST /answers?callback_id=...` body `{message?, notification?}`; `message.attachments: []` убирает клавиатуру |
| Редактирование | `PUT /messages?message_id=<mid>` (message_id — **query**, не path) **[live]** |
| Удаление | `DELETE /messages?message_id=<mid>` |
| Команды | `PATCH /me/commands` `{commands:[{name,description}]}`, ≤32 команд |
| «Печатает» | `POST /chats/{chatId}/actions` `{action:"typing_on"}` — работает и в диалоге **[live]** |
| Владелец чата | `GET /chats/{chatId}` → `owner_id` (виден только админам; у диалога `null`) **[live]** |

---

## 1. Приём событий: long polling `GET /updates`

| Параметр | Тип / значения | Заметки |
|---|---|---|
| `limit` | 1…1000, default 100 | размер страницы |
| `timeout` | 0…90 сек, default 30 | long-poll «висит» до события или таймаута |
| `marker` | int64 / `null` | курсор следующей страницы |
| `types` | csv, напр. `message_created,message_callback` | фильтр типов на стороне сервера |

Ответ: `{updates:[Update...], marker:<int64>}` **[live]** (`{"updates":[],"marker":55148}` при `timeout=0`).

**Семантика `marker`** [docs]: каждое обновление имеет порядковый номер; `marker` в ответе указывает на
*следующее ожидаемое* обновление. Передав `marker`, вы подтверждаете (commit) все предыдущие — они считаются
прочитанными и больше не вернутся (consume-once). **Если `marker` не передан или `null` — вы получите только
последнее обновление**, а не всю очередь (важный подводный камень).

**Несколько поллеров:** отдельного «consumer id» нет — курсор один на бота. Два параллельных поллера
будут «съедать» события друг друга и терять их; официально схема «один поллер + persist marker»
единственная рабочая. При активной webhook-подписке long polling **не работает** [docs: «При активной
подписке Long Polling не работает»]; методы `/updates` и `/answers` в схеме описаны с ответом `405`.

**Типы update** (дискриминатор `update_type`, полный mapping из схемы):

| `update_type` | Полезные поля |
|---|---|
| `message_created` | `message` (`sender`, `recipient`, `body.mid/seq/text/attachments`, `link`), `user_locale` |
| `message_callback` | `callback.{callback_id,payload,timestamp,user}`, `message` (исходное сообщение с клавиатурой, может быть `null`), `user_locale` |
| `message_edited` / `message_removed` | `message` / `message_id`, `chat_id` |
| `bot_started` | `chat_id`, `user`, `payload` (deeplink), `user_locale` |
| `bot_stopped` / `dialog_cleared` / `dialog_removed` / `dialog_muted` / `dialog_unmuted` | `chat_id`, `user` |
| `bot_added` / `bot_removed` | `chat_id`, `user`, `is_channel` |
| `user_added` / `user_removed` | `chat_id`, `user`, `inviter_id` / `admin_id`, `is_channel` |
| `chat_title_changed` | `chat_id`, `title`, `user` |
| `bot_admin_permissions_changed` | `chat_id`, `user`, `permissions` |
| `comment_created/edited/removed` | комментарии к постам каналов |

Важно: в групповых чатах `message_created` приходит боту **только если он админ с правом
`read_all_messages`** (схема, `MessageCreatedUpdate.description`).

---

## 2. Webhook `POST /subscriptions`

| Аспект | Требование |
|---|---|
| URL | `https://…`, порт **строго 443**, порт в URL не указывается; самоподписанные сертификаты запрещены (с 25.05.2026 HTTP отключён) |
| TLS | сертификат доверенного ЦС или Минцифры; CN/SAN должен совпадать с хостом; сервер обязан отдавать полную цепочку |
| Ответ endpoint'а | HTTP **200 в течение 30 секунд**; иначе — ошибка доставки |
| Retry | до **10** повторов, экспоненциально ×2.5: 60 s, 150 s, 375 s, … |
| Автоотписка | если за **8 часов** не было ни одного успешного ответа — бот отписывается автоматически |
| Secret | необязательный `secret` 5–256 символов, `^[\w-]+$`, приходит в заголовке `X-Max-Bot-Api-Secret` |
| Фильтр типов | `update_types: ["message_created","bot_started", …]` — да, фильтрация поддерживается |
| Body | `{"url":"…","secret":"…","update_types":[…]}`; `url` обязателен |

Обновление/удаление: отдельного `PUT` нет — повторный `POST /subscriptions` с новым `url`/`secret`/`update_types`
(документация прямо советует «чтобы обновить подписку, используйте текущий метод»). Удаление —
`DELETE /subscriptions?url=…`. Список — `GET /subscriptions` → `{subscriptions:[{url,time_to_live,update_types}]}`
(у нас сейчас `{"subscriptions":[]}` **[live]**).

**Long polling vs webhook — взаимоисключающие.** Docs: «Использовать одновременно оба типа нельзя — выберите
один из них»; при активной подписке long polling не работает. Для локальной разработки без публичного
HTTPS:443 остаётся только polling (или туннель).

---

## 3. Отправка / редактирование / удаление

| Возможность | Endpoint | Поля и ограничения |
|---|---|---|
| Отправить | `POST /messages?chat_id=<id>` (или `?user_id=`, `&disable_link_preview=`) | body `NewMessageBody`: `text` ≤ **4000**, `attachments[]`, `link`, `notify` (default true), `format`: `markdown`\|`html`\|`null`. Ответ — `{message:{…, body:{mid,seq,…}}}` **[live]** |
| Изменить | `PUT /messages?message_id=<mid>` | `message_id` — **query-параметр** (в path его нет). Body тот же `NewMessageBody`; `attachments:null` = не трогать, `attachments:[]` = удалить все вложения (в т.ч. клавиатуру) **[live]**. Ответ `{success:true}` |
| Удалить | `DELETE /messages?message_id=<mid>` | только свои сообщения в диалоге; в чате/канале — любые, если бот админ с правом удаления |
| Получить один | `GET /messages/{messageId}` | mid в path; `404` если нет доступа |
| История | `GET /messages?chat_id=<id>` или `?message_ids=mid1,mid2` | `count` 1…100 (default 50), `before`/`after` (unix ms); `from`/`to` deprecated. Порядок — от новых к старым |

`mid` берётся из ответа `POST /messages` → `message.body.mid` (вид `mid.sample`)
**[live]**, а также из любого `Message` в апдейтах. У редактирования есть срок: в диалоге сообщения
**без** кнопок редактируются только **< 7 суток**, с `inline_keyboard` — без ограничения по возрасту;
в группах/каналах — без ограничения.

**Reply / forward** — через поле `link` в `NewMessageBody`:
`"link": {"type":"reply"|"forward", "mid":"mid.…"}`. В `Message` это отражается как `link` (`LinkedMessage`:
`type`, `sender`, `chat_id`, `message`). Для комментариев допустим только `reply`.

---

## 4. Клавиатуры, кнопки, callback

Структура (проверено live):
```json
{"type":"inline_keyboard","payload":{"buttons":[
  [{"type":"callback","text":"A","payload":"probe:A"},{"type":"callback","text":"B","payload":"probe:B"}],
  [{"type":"link","text":"Docs","url":"https://dev.max.ru/docs-api"}]
]}}
```

| Ограничение | Значение |
|---|---|
| Кнопок всего | ≤ **210** |
| Рядов | ≤ **30** |
| Кнопок в ряду | ≤ **7** (≤ **3**, если в ряду есть `link`, `open_app`, `request_geo_location`, `request_contact`) |
| `text` кнопки | 1…128 символов (рекомендуется 20/10/5/3 при 1/2/3/4 кнопках в ряду) |
| `callback.payload` | ≤ **1024** символов (строка) |
| `link.url` | ≤ 2048 |
| `clipboard.payload` | ≤ 1024 |
| `open_app.payload` | ≤ 512, `^[\w-]*$`; обязателен `web_app` (username бота), опц. `contact_id` |

Типы кнопок (дискриминатор `type`): `callback`, `link`, `message` (отправляет текст от имени пользователя),
`request_contact`, `request_geo_location` (+`quick:bool`), `open_app`, `clipboard`.
Кнопки не пересылаются при forward сообщения.

**Что приходит при нажатии** — update `message_callback`:
`callback.callback_id` (строка, идентификатор нажатия), `callback.payload` (ваш payload), `callback.user`,
`callback.timestamp`, `message` (исходное сообщение; может быть `null`, если его удалили), `user_locale`.
Кнопка **не** присылает `chat_id` — берите его из `message.recipient.chat_id` или из `user.user_id`
(для диалога `chat_id` диалога ≠ `user_id`; у нас `chat_id 123456789` ↔ `user_id 987654321` **[live]**).

**Ответ на callback** — `POST /answers?callback_id=<id>` (+ `disable_link_preview`), body `CallbackAnswer`:
- `message`: `NewMessageBody` — **заменяет** исходное сообщение (текст/вложения/клавиатура; `attachments:[]` убирает
  клавиатуру), ограничения те же (текст ≤4000, ≤12 вложений);
- `notification`: строка — одноразовый тост/уведомление пользователю (лимит длины в docs/схеме не задан).

Ответ `{success:true}`; `405`, если callback уже обработан/недействителен либо активен webhook-режим.
Ответ на callback нужен обязательно, иначе клиент показывает «крутилку»/ошибку.

---

## 5. Команды бота

`PATCH /me/commands`, body `{"commands":[{"name":"start","description":"…"}]}`.

| Поле | Ограничение |
|---|---|
| `name` | 1…64 символа |
| `description` | 1…128 символов, nullable |
| Всего команд | ≤ **32** (`maxItems: 32`) |
| Удалить все | передать `"commands": []` |

Отображение: подсказки при вводе `/` в диалогах (iOS/Android/desktop) и групповых чатах; **в каналах не
поддерживается**. Частота изменений в docs не лимитирована (общий лимит 30 rps). Отдельного «get commands»
нет — ответ метода возвращает `BotCommandsInfo` (`commands[]`).
Распознавание в апдейтах: отдельного типа события нет — приходит обычный `message_created` с текстом
`/cmd` или `/cmd@bot`; парсить `message.body.text` (учесть, что `message`-кнопка тоже присылает текст).

---

## 6. Медиа

Flow (3 шага):
1. `POST /uploads?type=image|video|audio|file` → `{url, token?}`.
2. `POST <url>` с `Content-Type: multipart/form-data`, поле `data=@file` → `{token:"…"}` (или resumable: любой
   другой Content-Type + `Content-Range`; статус — `GET <url>`).
3. `POST /messages` с `attachments:[{type, payload:{token}}]`.

| Тип | Форматы | Лимиты |
|---|---|---|
| `image` | JPG, JPEG, PNG, GIF, TIFF, BMP, HEIC | ≤ **50 MB** И ≤ 7680×7680 px (оба условия) |
| `video` | MP4, MOV, MKV, WEBM | ≤ **250 MB** |
| `audio` | MP3, WAV, M4A и др. | ≤ **256 MB** И ≤ 60 минут |
| `file` | TXT, DOC, PDF и др. | ≤ **4 GB** |

- Один файл на один upload URL; `type=photo` больше не поддерживается (→ `image`).
- Для `image` payload: `{token}` **или** `{url}` (внешний URL без загрузки) **или** `{photos:{…}}`; поля взаимоисключающие.
- `video`/`audio`/`file` payload: `{token}`.
- После загрузки файл может обрабатываться: пока не готов — `POST /messages` вернёт `400`, нужен retry.
- Несколько вложений: **до 12 всего**; можно комбинировать несколько `image` + `video` + **одну** `inline_keyboard`.
  `file`, `audio`, `sticker`, `contact` — «MUST be the only attachment» (file/contact можно совместить только с
  одной клавиатурой; аудио и стикер — единственные).
- `GET /videos/{videoToken}` — прямой URL/метаданные видео.

---

## 7. Прочее

| Возможность | Endpoint | Детали |
|---|---|---|
| «Печатает» | `POST /chats/{chatId}/actions` body `{"action":"typing_on"}` | enum: `typing_on`, `sending_photo`, `sending_video`, `sending_audio`, `sending_file` (+ `mark_seen` в схеме, но не в docs). Работает и в диалоге **[live]**; ответ `{success:true}` |
| Инфо о чате | `GET /chats/{chatId}` | `type` (`dialog`/`chat`/`channel`), `status`, `title`, `owner_id` (**только админам**, у диалога отсутствует), `participants_count`, `is_public`, `link`, `dialog_with_user`, `pinned_message` |
| Участники | `GET /chats/{chatId}/members?user_ids=…&count=1..100&marker=…` | `user_ids` игнорирует `count`/`marker`; требует прав |
| Админы | `GET /chats/{chatId}/members/admins` | бот должен быть админом |
| Моё членство | `GET /chats/{chatId}/members/me` | `ChatMember` с `permissions` |
| Закреп | `GET/PUT/DELETE /chats/{chatId}/pin` | body `{message_id, notify}` |
| Упоминания | markup `[Имя](max://user/<user_id>)` | в markdown/HTML (`format`) либо через `markup[]` |
| Deeplink | `https://max.ru/<botName>?start=<payload>` | payload ≤ **128** символов (docs), поле `bot_started.payload` ≤512; iOS ≥2.7.0, Android ≥2.9.0 |
| Ссылка на сообщение | `Message.url` | `null` в диалогах и непубличных чатах |
| Комментарии | `GET/POST /messages/{messageId}/comments`, `PUT/DELETE …/comments/{commentId}` | только каналы, без вложений |

---

## 8. Лимиты и подводные камни

| Лимит / ловушка | Значение |
|---|---|
| Текст | **4000** символов raw `text` (разметка считается); длиннее — резать на части |
| Скорость | **2 сообщения/сек** на диалог/чат/канал; то же для edit/delete/answers; **30 rps** суммарно на `platform-api2.max.ru` |
| `429` | превышен rate limit — очередь/backoff |
| `401` | `{"code":"verify.token","message":"Invalid access_token"}` |
| `403` | бот заблокирован пользователем (`ChatStatus.suspended`), нет доступа к чату, или пересылка запрещена (`chat.denied`) |
| `404` | нет сообщения/чата или нет доступа |
| `405` | метод недоступен (например `/updates`/`/answers` при активном webhook, повторный ответ на callback) |
| `attachments` | ≤ 12 суммарно; `file`/`audio`/`contact`/`sticker` — фактически единственное вложение |
| Клавиатура | ≤210 кнопок / ≤30 рядов / ≤7 (3) в ряду; `payload` ≤1024 |
| `marker` | без него — только последнее обновление; всегда persist + commit вперёд |
| Вложения | upload-URL одноразовый (один файл на ссылку); при редактировании `mid` не меняется **[live]** |
| Диалог | `chat_id` ≠ `user_id`; `owner_id` в диалоге отсутствует → «владение» проверяйте через `type=dialog` + `dialog_with_user.user_id` **[live]** |
| Webhook | только 443, только валидный TLS, 200 за 30 s, иначе 10 retry и автоотписка через 8 ч |

---

## 9. Матрица: фича → поддерживается

| Фича | Статус | Комментарий |
|---|---|---|
| Приём сообщений | **да** | `GET /updates` (`message_created`) или webhook |
| Приём нажатий кнопок | **да** | `message_callback` → `callback.callback_id`/`payload` **[live: клавиатура отправлена]** |
| Отправка сообщения | **да** | `POST /messages`, ≤4000 симв. **[live]** |
| Редактирование | **да** | `PUT /messages?message_id=`, в диалоге без кнопок только <7 суток **[live]** |
| Удаление | **да** | `DELETE /messages?message_id=`; в диалоге только свои |
| Инлайн-кнопки | **да** | `inline_keyboard`, ≤210 кнопок **[live]** |
| Ответ на callback | **да** | `POST /answers?callback_id=` — `message` и/или `notification`; убрать клавиатуру = `attachments:[]` |
| Команды | **да** | `PATCH /me/commands`, ≤32; меню в диалогах и группах, не в каналах |
| Картинки/файлы | **да** | `/uploads` → multipart → `token`; file ≤4 GB, image ≤50 MB; file — единственное вложение |
| «Печатает» | **да** | `POST /chats/{chatId}/actions` `typing_on`, работает в диалоге **[live]** |
| Проверка владельца чата | **ограничено** | `GET /chats/{chatId}`: `owner_id` только для админов; в диалоге `null` → проверять `type`+`dialog_with_user.user_id` |
| Webhook | **да** | только HTTPS:443, TLS от доверенного ЦС/Минцифры, `secret`-заголовок; polling при этом отключается |

---

## 10. Live-проверки (2026-10-27, бот `My Bot`, `@your_bot`, chat 123456789)

| Проверка | Результат |
|---|---|
| `GET /me` | 200, `user_id 100000001` |
| `GET /chats/123456789` | 200, `type:"dialog"`, `status:"active"`, `dialog_with_user.user_id 987654321`, `owner_id` отсутствует |
| `GET /updates?limit=2&timeout=0&types=…` | 200, `{"updates":[],"marker":55148}` |
| `GET /messages?chat_id=…&count=1` | 200, история доступна в диалоге (несмотря на «нужен админ» в docs) |
| `GET /subscriptions` | 200, `{"subscriptions":[]}` → webhook не настроен |
| `POST /messages` + `inline_keyboard` (2 callback + 1 link) | 200, `mid.sample`, вложения вернулись в ответе |
| `PUT /messages?message_id=…` c `attachments:[]` | 200 `{success:true}`; `GET /messages/{mid}` → текст заменён, вложений нет, `mid` тот же |
| `POST /chats/123456789/actions` `typing_on` | 200 `{success:true}` (в диалоге, хотя docs говорят про групповой чат) |
| `DELETE /messages?message_id=mid.000…` (фейковый) | `{"success":false,"message":"Invalid chatId: 0"}` — невалидный mid даёт странную ошибку, не 404 |

## 11. Что осталось непроверенным

- Реальный webhook-цикл (нужен публичный HTTPS:443 с валидным сертификатом) — только по документации.
- Живой `message_callback` (кнопки отправлены, но нажатия в момент проверки не было; структура — по схеме).
- Лимит длины `notification` в `CallbackAnswer` — в схеме/docs не задан.
- Поведение `GET /updates` при активной подписке (ожидается `405`) — не проверялось, т.к. подписки нет.

## 12. Ссылки

- `GET /updates` — https://dev.max.ru/docs-api/methods/GET/updates
- `POST /subscriptions` — https://dev.max.ru/docs-api/methods/POST/subscriptions
- `POST /messages` — https://dev.max.ru/docs-api/methods/POST/messages
- `PUT /messages` — https://dev.max.ru/docs-api/methods/PUT/messages
- `POST /answers` — https://dev.max.ru/docs-api/methods/POST/answers
- `POST /uploads` — https://dev.max.ru/docs-api/methods/POST/uploads
- `PATCH /me/commands` — https://dev.max.ru/docs-api/methods/PATCH/me/commands
- `POST /chats/{chatId}/actions` — https://dev.max.ru/docs-api/methods/POST/chats/-chatId-/actions
- Клавиатура — https://dev.max.ru/docs-api/use-cases/sending-messages/keyboard
- Медиа — https://dev.max.ru/docs-api/use-cases/sending-messages/media
- Уведомления/webhook vs polling — https://dev.max.ru/docs-api/use-cases/event-notifications
- Схема OpenAPI — https://github.com/max-messenger/api-schema/blob/main/schema.yaml
