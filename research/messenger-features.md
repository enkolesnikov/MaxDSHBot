# DSH × MAX: каталог возможностей для плагина dsh-max-notify

Дата: 2026-10-27. Основано на: исходниках DSH 0.2.1-rc.4 (пакеты в
`/usr/local/lib/nodejs/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/`),
документации MAX (`dev.max.ru/docs-api`), [MAX Messenger Agent
Skill](https://github.com/max-messenger/max-agents-skill), а также нашем
работающем транспорте (`dsh-max-notify/lib/transport.mjs`).

Документ отвечает на вопрос: **что ещё можно добавить в плагин**, с оценкой
осуществимости и сложности (S — до ~полудня, M — 1–3 дня, L — неделя+).

---

## 0.0 Статус реализации (v0.2.0, «Пульт»)

Реализовано в `dsh-max-notify` (коммит «remote control»):

- **1** двусторонний чат (MAX → `sessionController.prompt` → ответ обратно);
- **2** команды `/status`, `/stop`, `/sessions`, `/use`, `/current`, `/help`
  (+ меню `PATCH /me/commands`);
- **3** кнопки под ответом: «Продолжить», «Стоп», «Открыть GUI»;
- **4** live-прогресс (редактируемое сообщение + `typing_on`);
- **6** approvals из MAX (prepend + `Promise.race` MAX↔GUI, fail-closed);
- **7** вопросы `ask_user_question` кнопками/текстом;
- **13** deliverables (`present`) вложениями (`POST /uploads`);
- бонусы: `/status` с моделью/папкой, allowlist на входящие, состояние в
  `$DSH_HOME/max-notify/state.json`, 67 тестов.
- **v0.3.0 «Наблюдатель»**: события subagent/job/goal/error (п. 2), TODO-прогресс
  (п. 3), режимы/тихие часы (п. 4), ежедневный дайджест (п. 10).
- Не реализовано из каталога: 5/8/11/12/14–29 (см. ниже).

## 0. TL;DR

Максимальная польза — не «ещё уведомления», а превратить бота в **пульт
управления агентом** внутри MAX. Технически DSH уже даёт для этого всё
необходимое: waterfall-события `approval/request` и `user-questions/request`
(подтверждения/вопросы можно решать кнопками в MAX), `ctx.agents` (писать
агенту из MAX, останавливать, читать статус), `agent/assistant-stream`
(живой прогресс), `session/event` (`deliverables/presented`,
`approval/asked/decided`), `subagent/start|end`, `goal/changed`.

Рекомендуемый пакет «Пульт»: №1 (двусторонний чат) + №2 (/команды) +
№5 (approvals в MAX) + №6 (вопросы агента) + №9 (live-прогресс) +
№14 (deliverables файлами). Это ~60% ощущаемой пользы при среднем риске.

---

## 1. Что уже есть в плагине (v0.1)

- Отправка последнего сообщения ассистента после каждого хода (`turn/end`).
- Заголовок `**DSH** · время · заголовок сессии/папка`, markdown.
- TLS-цепочка Минцифры встроена, `platform-api2.max.ru`.
- Чанкинг 4000 символов, 2 msg/сек, ретраи 429/5xx, очередь.
- Allowlist «только мне»: `allowedUserIds` + проверка `GET /chats/{chatId}`
  (fail closed).
- Пропуск subagent-сессий и `interrupted/forked`.
- Pairing helper, ручной тест, dry-run, установка bundle-патчем.

---

## 1.5 Существующие решения в экосистеме DSH (важно)

**Готового MAX-плагина нет, но есть эталон для копирования: `dsh-notify-plugin`
(btboys/dsh-notify, MIT) — двусторонний Telegram-мост для DSH.** Он уже решает
все механические проблемы, которые нам предстоит решать:

- `dsh plugin --profile web add dsh-notify-plugin` — host-plane bundle.
- События: `conversationCompleted/Paused/Failed` (`turn/end` reason),
  `confirmationRequired` (`user-questions/request`), `authorizationRequired`
  (`approval/asked`), `todoProgress` (`todo/write`).
- Интерактив: `prepend` на waterfall `approval/request` и
  `user-questions/request` → карточка с inline-кнопками в Telegram,
  одновременно запрос **не блокируется** (`next()` сразу), затем
  `Promise.race([чат, GUI])` — «кто первый ответил», проигравший получает
  «уже обработано в другом месте». Кнопки «✅/❌», ответ Y/N, номера опций.
- Продолжение диалога из чата — через `ctx.sessionController.prompt(...)`
  (тот же вход, что у Web, умеет будить холодную сессию), а не через
  `agent.followup`.
- Команды `/sessions`, `/workspace`, `/current`, `/help` — на
  `ctx.sessionController.list` + `ctx.workspaceRegistry`.
- Белый список: только настроенный `chatId` может управлять.
- Своя страница настроек в Web (client bundle + собственный RPC-маршрут через
  `webServer`; известная ловушка: `ctx.connection.rpc.handle()` без inject
  падает — поэтому у них свой route).
- Конфиг персистится в `$DSH_HOME/notify/config.json`.

Другие DSH-нотификаторы (one-way, но полезные модели):
- `@goodandready/dsh-plugin-notify` — Slack/Discord/Feishu/custom + Web Push,
  DND, `onlyWhenAway`, `notifySubagents`, credential-ссылки.
- `dsh-notify-me` — approve/deny прямо из OS-уведомления, политики «когда
  будить», HMAC-подпись.
- `@ddtcorex/dsh-maestro-notifier` — реестр провайдеров, `send()` never-throw,
  токен write-only — хорошая форма «MAX = один из провайдеров».

Плагин-маркет DSH по умолчанию пуст (`indexes: []`); живые каталоги:
awesome-dsh-plugin.com, dsh-plugin.org, dshmk.com.

**Вывод:** стратегически выгодно не изобретать взаимодействие заново, а либо
(A) форкнуть `dsh-notify-plugin` и добавить канал MAX (переиспользуем
approvals/вопросы/сессии/настройки, ~S/M), либо (B) продолжить наш
`dsh-max-notify`, скопировав его механики (prepend+race,
`sessionController.prompt`, меню сессий) — больше контроля над MAX-спецификой
(кнопки, edit, файлы), но дольше.

---

## 2. Что даёт DSH: поверхности для мессенджер-плагина

Все события/сервисы доступны плагину без импорта `@deepseek-ai/*` (link:-
установка не умеет их резолвить); вызовы — через `ctx.on(...)`/`ctx.get(...)`
и структурные объекты.

| Возможность DSH | Как использовать | Что даёт в MAX |
|---|---|---|
| `session/event`: `turn/end`, `assistant/message` | уже используется | финальные сообщения |
| `session/event`: `deliverables/presented` | `{turn, callId, files:[{path,description}]}` — файлы, объявленные инструментом `present` | отправка файлов/архивов/скриншотов в MAX |
| `session/event`: `approval/asked`, `approval/decided` | аудит-события (log-only) | уведомление «нужно разрешение» |
| `session/event`: `goal/changed` | прогресс goal (проекция) | «цель достигнута/прогресс» в MAX |
| `agent/assistant-stream` | `{agent, frame:{type:'start'|'chunk'|'end', chunk}}` | live-прогресс: править одно сообщение в MAX |
| `agent/status`, `agent/error` | `idle/busy/error` | «агент думает / упал» |
| `agent/turn-stopping` | serial-waterfall перед закрытием хода | можно дождаться ответа владельца, не закрывая ход |
| `tools/pre-execute` (waterfall), `tools/execute`, `tools/post-execute` | имя инструмента, аргументы, результат | показ «что делает»; перехват/запрет; отправка файлов из результата |
| `approval/request` (waterfall; `ctx.on(..., {prepend:true})`) | `(req:{agent,toolName,callId,reason,signal}, next) => 'allowed-once'|'rejected'|'cancelled'|'unavailable'` | **кнопки «Разрешить/Отклонить» в MAX** |
| `user-questions/request` (waterfall) | `(req:{questions:[{id,question,header?,options?}], signal, wait}, next) => {answers:[{id,selected[],custom?}]}` | **вопросы агента (ask_user_question) в MAX** |
| `subagent/start`, `subagent/end` | `SubagentRunEndInfo {id, provider, stopReason, lastAssistantMessage?}` | «дочерний агент закончил: …» |
| `ctx.agents` | `list()`, `roots()`, `get(sessionId)`, `agent.followup/steer/inject/cancel`, `status` | писать агенту из MAX, /stop, статус |
| `ctx.sessionController` | `prompt({requestId, sessionId, mode:'queue'|'steer', content}, signal)`; `list`; `updateQueue` | **вход в сессию как у Web, будит холодную сессию** |
| `ctx.workspaceRegistry` | список/выбор рабочих пространств | `/workspace` |
| `ctx.commands` | `register({name,description,handler})`, `execute(agent, '/line')`, `list(agent)` | /команды: общие для GUI и MAX |
| `ctx.schedule` (Host-сервис web-профиля) | одноразовые/ежедневные/cron-напоминания в сессию | **дайджесты и отчёты по расписанию** |
| `ctx.jobs.events` | поток событий фоновых задач | «job завершён: …» |
| `ctx.tokenMeter` | измерения токенов | /status и дайджест с расходом |
| `session/event 'todo/write'` | `{todos: TodoItem[]}` — полный снапшот плана | **TODO-прогресс в MAX** |
| `ctx.get('sessionTitle')` | заголовок сессии | списки сессий, заголовки |
| `dsh-session-query` | поиск/история по сессиям | /find, цитаты в MAX |
| MCP-клиент | подключить MCP-сервер как инструменты | внешние сервисы (календарь, GitHub) |
| client-UI плагин | страница настроек в Web GUI | настройка токена/режимов из интерфейса |

Ограничения DSH, важные для мессенджера:
- `approval/request`/`user-questions/request` — waterfall: если не ответить и
  не вызвать `next()`, запрос «висит»; обязателен таймаут и делегирование.
- `ctx.on(name, fn, {prepend:true})` — можно встать раньше GUI-ответчика,
  чтобы решения принимались в MAX, а GUI оставался фолбэком.
- Состояние «ожидающих» подтверждений живёт в памяти процесса: при
  HMR-перезагрузке плагина нужно восстанавливать из лога сессии
  (`approval/asked` без `approval/decided`) или из persistence-файла.
- `agent.followup` требует объект user-сообщения (`id`, `role`, `content`,
  `source`); id можно сгенерировать UUID. Требуется проверка на живой сессии.

---

## 3. Что даёт MAX: API интерактивного бота

| Возможность | API | Ключевые ограничения |
|---|---|---|
| Приём сообщений/нажатий | `GET /updates` (long polling) или `POST /subscriptions` (webhook) | long polling — один поллер на токен, «dev/test», хранение ограничено; webhook — публичный HTTPS + доверенный сертификат (Минцифры), секрет `X-Max-Bot-Api-Secret` |
| Обновления | типы `message_created`, `message_callback`, `bot_started`, `user_added`, … | `message_callback.callback.callback_id` — ключ для ответа |
| Отправка | `POST /messages?chat_id=` | 4000 симв., ≤2/сек на чат |
| Редактирование | `PUT /messages?message_id=` | бот правит только свои; в диалогах — до 7 суток (кроме сообщений с кнопками); ≤2 правок/сек |
| Удаление | `DELETE /messages?message_id=` | только свои |
| Кнопки | attachment `inline_keyboard` | до 210 кнопок/30 рядов; типы `callback`, `link`, `message`, `clipboard`, `request_contact`, `request_geo_location`, `open_app` |
| Ответ на нажатие | `POST /answers?callback_id=` | можно заменить сообщение и/или показать уведомление; ≤2/сек |
| Команды бота | `PATCH /me/commands` | ≤32 команд, name ≤64, description ≤128; подсказки при «/» |
| Файлы/медиа | `POST /uploads?type=image|video|audio|file` → загрузить по `url` → `attachments.payload.token` | image ≤50 МБ/7680px, video ≤250 МБ, audio ≤256 МБ/60 мин, file ≤4 ГБ; после загрузки возможна ошибка `attachment.not.ready` — повторять с паузой |
| «печатает» | `POST /chats/{chatId}/actions` | — |
| Инфо о чате | `GET /chats/{chatId}` | `dialog_with_user.user_id` — проверка владельца |

Рекомендация: **остаться на long polling** (личный бот, один пользователь).
Webhook имеет смысл только при наличии домена и HTTPS; на текущем хосте это
отдельная инфраструктурная задача (reverse proxy + сертификат, доверенный
Минцифры).

---

## 4. Каталог идей для плагина

Сложность: S ≈ часы, M ≈ 1–3 дня, L ≈ неделя+. Приоритет — по ощущаемой
пользе для одного пользователя.

### Блок A. Пульт управления (главное)

**1. Двусторонний чат: писать агенту из MAX → ответ приходит обратно. (S/M)**
- Что: текст из MAX (после allowlist-проверки) уходит в выбранную сессию
  через `ctx.sessionController.prompt({requestId: uuid, sessionId,
  mode:'queue', content:[{type:'text',text}]}, signal)` — тот же вход, что
  у Web; финальный ответ приходит штатной пересылкой `turn/end`.
  Альтернатива без sessionController — `ctx.agents.get(sessionId).followup(...)`.
- Зачем: управлять агентом с телефона, не открывая GUI.
- Нужно: long-polling цикл в плагине (или отдельный процесс), выбор сессии
  (последняя активная / `/use`), защита от самоповторов (не пересылать
  исходящие бота обратно), idempotency по `mid`.
- Риск: HMR-перезагрузка плагина сбрасывает поллер; нужно хранить `marker`.

**2. Слэш-команды бота. (S/M)**
- `/status` — статус агента, модель, cwd, заголовок, токены;
  `/stop` — `agent.cancel({kind:'user'})`; `/sessions` + `/use N` — выбор
  сессии; `/new` — новая сессия; `/compact`; `/model`; `/help`.
- Плюс `PATCH /me/commands`, чтобы MAX показывал подсказки при «/».
- Зачем: дешёвый и понятный интерфейс без кнопок.
- Нужно: `ctx.agents`, `ctx.tokenMeter`, `sessionTitle`, генерация списка.

**3. Кнопки быстрых действий под финальным сообщением. (S)**
- «Продолжить» (followup «продолжай»), «Стоп», «Открыть GUI» (`link` на
  `http://127.0.0.1:3480`), «Ещё вариант», «Свернуть».
- Зачем: не печатать команды руками.

**4. Голосовое управление: голосовое → текст → агенту. (M, внешний STT)**
- MAX присылает `audio`; скачать → STT (Whisper API/локальный) → промпт.
- Зачем: с телефона на ходу. Требует ключ стороннего сервиса.

### Блок B. Интерактивные решения (сильная фича)

**5. Подтверждения инструментов в MAX. (M)**
- `ctx.on('approval/request', handler, {prepend:true})`: отправить в MAX
  сообщение с `reason`/`toolName` и кнопками «Разрешить/Отклонить»;
  дождаться `message_callback` (или текста «да/нет»); вернуть
  `'allowed-once'`/`'rejected'`; по таймауту — `next()` (пусть решит GUI);
  по `req.signal` — `'cancelled'`.
- Зачем: агент может работать, пока вы не у компьютера; согласование
  опасных действий с телефона.
- Нужно: одноразовые callback-токены (не угадываемые), кэш ожиданий,
  восстановление после перезагрузки, fail-closed.

**6. Вопросы агента (ask_user_question) в MAX. (M)**
- `ctx.on('user-questions/request', handler)`: вопросы + варианты → кнопки;
  свободный текст → `custom`; вернуть `{answers:[{id,selected,custom?}]}`.
- Зачем: агент спрашивает — вы отвечаете из мессенджера, ход не блокирует
  GUI.

**7. Согласование плана (plan mode). (M)**
- Если в сессии включён plan mode, ловить его события/вопросы и присылать
  план в MAX с кнопками «Принять/Правки».

**8. Управление политикой approvals из MAX. (S)**
- `/approve ask`, `/approve never` → `ctx.approval.setPolicy(agent, ...)`;
  `/approve` показывает текущую политику.

### Блок C. Прогресс и события

**9. Live-карточка прогресса. (M)**
- Создать одно сообщение в MAX и править его (`PUT /messages?message_id=`)
  по `agent/assistant-stream` и `tools/pre-execute`: «🔧 bash: pnpm test»,
  «пишу ответ…», таймер; в конце — финальный текст (тем же сообщением или
  новым). Плюс `POST /chats/{chatId}/actions` (typing).
- Зачем: видно, что агент жив и что делает, без спама.
- Ограничения MAX: ≤2 правки/сек; троттлинг обязателен.

**10. Уведомления о событиях. (S)**
- subagent завершён (с `lastAssistantMessage`); job завершён
  (`ctx.jobs.events`); goal достигнут (`goal/changed`); ошибка агента
  (`agent/error`); «нужно разрешение» (`approval/asked`).
- Зачем: не пропускать важное; можно отключать по типам.

**11. Дайджест (ежедневно/по cron). (M)**
- Через `ctx.schedule` (в web-профиле есть Host-сервис) или таймер плагина:
  «за сутки: N сессий, X токенов ≈ Y ₽, выполнено Z задач, активные goals».
- Зачем: сводка без чтения чата.

**12. Режимы уведомлений. (S)**
- `quietHours` (не будить ночью), `onlyErrors`, `skipIntermediate`,
  `muteUntil`; настройка командой `/mode`.

**13. Health-check и алерты. (S)**
- Периодический `GET /me`; при 401/сетевой ошибке — запись в лог/сессию;
  индикатор «бот на связи» в `/status`.

### Блок D. Файлы и медиа

**14. Deliverables в MAX. (M)**
- `session/event 'deliverables/presented'` → для каждого файла:
  `POST /uploads?type=file|image` → загрузить → `POST /messages` с
  `attachments`. Учитывать `attachment.not.ready` (retry).
- Зачем: отчёты/архивы/скриншоты сразу в мессенджер.

**15. Изображения из результатов инструментов. (M)**
- Если tool-результат содержит изображение (или скриншот), загрузить
  `type=image` и приложить к сообщению.

**16. Приём файлов из MAX в workspace. (M/L)**
- Входящее вложение: скачать по `url` из `attachments` → сохранить в
  `workspace/inbox/` → `agent.followup` «вот файл: путь». Нужны лимиты
  размера и антивирус/проверка типа.

**17. Озвучка ответа (TTS). (M/L)**
- Финальный текст → TTS → `POST /uploads?type=audio` → голосовое.
  Внешний сервис; для длинных ответов — только краткое резюме.

### Блок E. Несколько получателей и сессий

**18. Групповой чат команды. (M)**
- Несколько `targets` (чат/пользователь/группа), маршрутизация по сессиям
  или темам; упоминания `[Имя](max://user/<id>)`.
- Зачем: агент как «ещё один участник» команды.

**19. Ветки по сессиям. (M)**
- Каждая сессия = отдельное сообщение-«нить»: ответы агента реплаем
  (`link:{type:'reply', mid}`), команды в ответ на нужное сообщение.
- Обходит отсутствие топиков в MAX.

**20. Роли: владелец/наблюдатель. (S/M)**
- `ownerUserIds` (управление) и `viewerUserIds` (только чтение); действия
  управления доступны только владельцу.

### Блок F. Взять готовое

**26. Форк `dsh-notify-plugin` + канал MAX. (S/M)**
- Что: у плагина уже есть вся механика (approvals/вопросы/сессии/настройки/
  TODO-прогресс/белый список). Добавить MAX как ещё один канал: наш
  транспорт + `GET /updates`/webhook + inline-кнопки + edit.
- Зачем: быстрее всего получить полноценный двусторонний мост.
- Минус: чужой код (MIT), меньше контроля над MAX-спецификой, нужно
  синхронизироваться с апстримом.

**27. TODO-прогресс в MAX. (S)**
- `session/event 'todo/write'` → «📋 2/5: …» по изменению прогресса
  (дебаунс), с чек-иконками. Готовый паттерн в dsh-notify-plugin.

**28. `/sessions` и `/workspace` с выбором. (S/M)**
- `ctx.sessionController.list` и `ctx.workspaceRegistry`; inline-кнопки
  «переключить сессию/воркспейс», `sessionController.prompt` будит холодную.

**29. Страница настроек в Web GUI. (L)**
- client-bundle + собственный RPC-маршрут через `webServer` (не
  `ctx.connection.rpc.handle()` — падает без inject); форма токен/чат/
  allowlist/режимы. Готовый образец — dsh-notify-plugin.

### Блок G. Экосистема и удобство

**21. Входящие события извне (GitHub/GitLab webhook) → промпт агенту. (M)**
- DSH уже умеет webhook-оверлеи; можно связать: PR/issue событие →
  followup «посмотри PR #N».

**22. Установить официальный MAX Messenger Agent Skill в DSH. (S)**
- Навык `max-agents-skill` (SKILL.md + references) даёт агенту актуальные
  знания MAX API; DSH читает skills из каталога. Полезно для дальнейшей
  разработки плагина.
- `curl -fsSLO .../install.sh && bash install.sh`, затем указать путь в
  конфиге skills.

**23. Публикация плагина (npm + индекс маркета). (S/M)**
- `dsh.bundle` уже есть; нужны `name/version/engines.dsh`, README, лицензия,
  релиз и index-файл маркета (формат `dsh-plugin-market-index`).

**24. Страница настроек в GUI DSH (client-UI плагин). (L)**
- Форма: токен, chat, allowlist, режимы, кнопка «отправить тест»;
  потребует client-часть и сборку/публикацию.

**25. MAX Mini App (панель агента внутри MAX). (L)**
- Web-панель (MAX UI/Bridge) со статусом, сессиями, кнопками; отдельный
  фронтенд, initData-проверка.

---

## 5. Рекомендуемые пакеты

**Вариант «форк готового» (самый быстрый):** 26 → получаем 1, 2, 5, 6,
10, 27, 28 почти бесплатно, дальше добавляем MAX-специфику (3, 9, 14).

**Пакет «Пульт» (если продолжаем свой плагин):** 1, 2, 3, 5, 6, 9, 14.
Закрывает 80% сценариев: писать/останавливать/смотреть прогресс/решать
подтверждения/получать файлы. Срок ~3–4 дня, риск средний.

**Пакет «Наблюдатель+»:** 10, 11, 12, 13, 14, 15.
Если управление не нужно — только умные уведомления и файлы. ~1–2 дня.

**Пакет «Команда»:** 18, 19, 20 + 1, 2, 5.
Для работы нескольких людей/чатов. ~3–5 дней.

**Быстрые победы (за вечер):** 2 (/status,/stop), 3 (кнопки), 8
(/approve), 10 (уведомления о subagent/ошибках), 27 (TODO-прогресс),
22 (MAX skill), 26-разведка репозитория dsh-notify.

---

## 6. Риски и ограничения

1. **Long polling**: один поллер на токен; при запуске второго (например,
   `tools/pair.mjs`) события «съедаются» конкурентно. Нужен единый
   координатор (файл-lock/marker в workspace).
2. **Webhook**: требует публичного HTTPS с сертификатом, которому доверяет
   MAX; на текущем хосте без домена — нетривиально. Webhook отключает long
   polling.
3. **HMR-перезагрузка плагина** (любая правка профиля) сбрасывает
   in-memory состояние: ожидания подтверждений, текущий `marker`, live-карточки.
   Нужна персистентность (файл в workspace/DSH home).
4. **Безопасность**: входящие сообщения исполняются как промпты. Разрешать
   только allowlist-пользователю; опасные команды (`/stop`, approvals) —
   только владельцу; не доверять тексту из чужих чатов; подписывать
   callback-payload случайным токеном.
5. **Таймауты approvals**: без таймаута агент «зависнет»; при таймауте —
   `next()` (GUI) или `'unavailable'` (fail closed).
6. **Лимиты MAX**: 4000 симв., 2 отправки/правки/сек, 7 суток на правку в
   диалогах (кроме кнопок), `attachment.not.ready` после upload.
7. **UI-GUI конфликт**: если плагин перехватывает approvals раньше GUI,
   пользователь может не увидеть карточку в Web; нужен явный режим
   `approvalChannel: max|gui|both` (both = MAX с таймаутом → GUI).
8. **Проверка `agent.followup`**: тип требует `id`/`source`; нужен
   короткий спайк на живой сессии, чтобы подтвердить корректный вызов
   (unit/harness).

---

## 7. Следующий шаг

Если выбираете пункты — сделать по одному PR-циклу: спайк → тесты
(`node --test`) → HMR-применение в живом профиле → проверка в MAX.
Первый спайк рекомендую «1. двусторонний чат» + «2. /status,/stop»: они
дают каркас (long-polling, реестр сессий, команды), на который потом
навешиваются кнопки/approvals/live-прогресс.
