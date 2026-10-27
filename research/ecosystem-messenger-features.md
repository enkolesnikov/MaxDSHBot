# Кодинг-агент ↔ мессенджер: что уже есть в экосистеме и что добавить в `dsh-max-notify`

> Исследование под задачу: самописный DSH-плагин `dsh-max-notify` умеет только «последнее сообщение агента → MAX».
> Нужно понять, какие фичи интеграций «агент ↔ мессенджер» реально работают у других, и что из этого стоит перенести.
>
> Дата: 2026-10-27. DSH: `0.2.1-rc.4`, Node v24.19.0, профиль `web`.
> Все утверждения о сторонних проектах — из их README/доков (ссылки в конце и по тексту); всё, что о DSH — проверено по установленным пакетам (`$DSH = /usr/local/lib/nodejs/node-v24.19.0-linux-x64/lib/node_modules/@deepseek-ai/dsh`).

---

## 0. TL;DR — 7 выводов

1. **Готового MAX-плагина нет**, но в npm-экосистеме DSH уже есть **полноценный двусторонний Telegram-мост** — `dsh-notify-plugin` (btboys/dsh-notify). Он делает ровно то, что мы обсуждаем: инлайн-кнопки approve/deny, ответы на `ask_user_question`, продолжение сессии из чата, `/sessions`, `/workspace`, `/current`. Это наш референс №1, и его архитектурные решения (approval-waterfall `prepend` + `Promise.race` с браузером) надо копировать, а не изобретать.
2. **В DSH уже есть все нужные швы** для двусторонности: `session/event`, waterfall `approval/request`, `user-questions/request`, `ctx.sessionController.prompt` / `.list`, `ctx.workspaceRegistry`. То есть «писать агенту из MAX» — не хак, а штатная точка расширения.
3. **Самый дешёвый прирост** для нас: события (subagent/job/goal/error/todo), `/status`-команды, и «одно живое сообщение» вместо потока сообщений. Всё это S/M и не требует двустороннего моста.
4. **Двусторонность (approve/deny + ответы + продолжение сессии) — это M/L, но именно она даёт 80% ценности**: снимает необходимость сидеть в веб-GUI. У Telegram это лучший канал (Bot API: inline keyboard, `callback_query`, `setMyCommands`), у MAX — кнопки тоже есть (см. `research/max-api.md`), но нет `setMyCommands`-меню, поэтому команды надо описывать в `/help` и кнопками.
5. **Классика жанра — «чат как пульт»**: Claude-Code-Remote (email/Telegram/LINE + tmux/PTY-инъекция), ccbot (Telegram + tmux), Happy (E2E-мобильный клиент). Все три упираются в одно: инъекция в живую сессию/процесс. У DSH это НЕ нужно — есть `sessionController.prompt`, что делает нашу реализацию чище и безопаснее.
6. **Никто не делает «просто уведомления»** — все добавляют хотя бы одно действие из чата (approve/deny, reply, stop). Чистый one-way notifier — это MVP, а не продукт.
7. **Безопасность — обязательный дифференциатор**: allowlist по chat_id/user_id (у нас уже есть), fail-closed при неизвестном чате, никаких секретов в тексте уведомлений (как `protect_content` у maestro-notifier), DND-окно и «не будить, если я в GUI» (как `onlyWhenAway` у dsh-plugin-notify).

---

## 1. Существующие плагины DSH

### 1.1. Официальное ядро: какие швы уже отданы плагинам

Это не «плагины», но именно те API, на которые садятся все сторонние интеграции (проверено по `$DSH/node_modules/@deepseek-ai/`):

| Пакет | Что даёт для мессенджер-интеграции |
|---|---|
| `@deepseek-ai/dsh-user-approval` | `ctx.approval`, waterfall `approval/request`: плагин может **вставить свой ответчик** (approve/deny из чата), fail-closed по умолчанию |
| `@deepseek-ai/dsh-user-questions` | `user-questions/request`: ответы на `ask_user_question` из чата |
| `@deepseek-ai/dsh-session` + `dsh-session-controller` (в `dsh-api-session-controller`) | `session/event` (в т.ч. `assistant/message`, `turn/end`, `tool/*`), `sessionController.prompt/list` — «написать агенту» и «переключить сессию» |
| `@deepseek-ai/dsh-workspace` | `workspaceRegistry` — список/выбор workspace из чата |
| `@deepseek-ai/dsh-jobs` / `dsh-goal` / `dsh-subagent` / `dsh-todo` | источники событий: job done, goal done, subagent done, todo-прогресс |
| `@deepseek-ai/dsh-commands` | регистрация слэш-команд (`/compact`, `/goal`, …) — можно переиспользовать для `/status` |
| `@deepseek-ai/dsh-notify`? | **нет такого пакета**; уведомления — только сторонние плагины |
| `@deepseek-ai/dsh-webhook` (npm, `0.1.2-alpha.2`) | **Входящий** webhook-рантайм: правило → создаёт Session в workspace. В установленном `0.2.1-rc.4` **отсутствует** (есть только в npm). Идея важна: «событие снаружи → новая сессия агента» |
| `@deepseek-ai/dsh-webhook-github` (npm, alpha) | Подписанный GitHub-webhook адаптер к предыдущему (PR review, issue → сессия) |
| `@deepseek-ai/dsh-acp*` / `dsh-sdk-jsonrpc-server` | альтернативные «пульты» (Zed/ACP, JSON-RPC SDK) — не мессенджеры, но тот же класс задач: внешний клиент управляет сессией |

**Вывод:** DSH архитектурно готов к «чату как пульту». Нам не нужен ни tmux, ни PTY (в отличие от Claude Code).

### 1.2. Плагины-нотификаторы и мессенджер-мосты в экосистеме DSH

Найдено через npm registry search (`dsh-plugin`, `dsh notify webhook`, `deepseek-harness telegram`). Все — сторонние, MIT, ставятся `dsh plugin --profile web add <pkg>`.

| Пакет | Каналы | Двусторонность | Что ценного |
|---|---|---|---|
| **`dsh-notify-plugin`** ([btboys/dsh-notify](https://github.com/btboys/dsh-notify)) | Telegram, WeCom, WeChat ClawBot, generic webhook, desktop | **Да, полная** | Референс №1. Инлайн-кнопки approve/deny, ответы на вопросы, продолжение сессии, `/sessions` `/workspace` `/current` `/help`, todo-прогресс, дебаунс, `parseMode`, `disableNotification`, настройки в Settings → «Уведомления» |
| **`@goodandready/dsh-plugin-notify`** ([GooDAnDReaDY](https://github.com/GooDAnDReaDY/dsh-plugin-notify)) | Feishu, WeCom, DingTalk, Slack, Discord, custom + Web Push (PWA) + OS-toast + звук | Нет (one-way) | Лучшая модель **событий и доставки**: `events: [task_done, error, approval_requested]`, DND-окно, `notifySubagents`, `onlyWhenAway`, credential-ссылки вместо URL в конфиге, ретраи/таймауты, «сбой доставки никогда не блокирует агент» |
| **`dsh-notify-me`** ([chromoany](https://github.com/chromoany/dsh-notify-me)) | браузерные нотификации + Discord/Bark/Gotify/Feishu/Server酱/WxPusher/webhook | Частично (approve/deny прямо из нотификации через Service Worker) | Лучший UX **«нужно твоё действие»**: `decide(id, 'allowed-once'|'rejected')`, политики «когда напоминать» (`background`/`smart`/`always`), idle-детект, «не будить, если смотрю», заголовок вкладки `🔔/✅`, HMAC-подпись webhook |
| **`@alotop/dsh-notify-hub`** ([alotop](https://github.com/alotop/dsh-notify-hub)) | Bark, Feishu (keyword+sign), WeCom, DingTalk, Slack, Discord, custom, «5G-сообщения» | Нет | Много каналов + маскирование секретов в UI (ключи не возвращаются в браузер) |
| **`@ddtcorex/dsh-maestro-notifier`** ([ddtcorex](https://github.com/ddtcorex/dsh-maestro-notifier)) | Telegram (первый провайдер) | Нет | Правильный **форменный** дизайн: сервис `maestroNotifier` + реестр провайдеров, `send()` **never-throw** → `{sent:false, reason}`, `protect_content`, токен write-only (`hasBotToken` вместо значения). Идеально как модель для «MAX как один из провайдеров» |
| `dsh-notification` ([nishit130](https://github.com/nishit130/dsh-notification)) | webhook + desktop | Нет | Простой минималистичный пример |
| `dsh-notify` ([Pasumao](https://github.com/Pasumao/dsh-plugin-notify)), `dsh-notify-windows` ([SeverusZh](https://github.com/SeverusZh/dsh-notify-windows)) | Windows toast + tray | Нет | Трей-иконка, «агент перестал работать» |
| `@telosmaylx/dsh-session-notify` ([TelosmaYLX](https://github.com/TelosmaYLX/dsh-session-notify)) | браузер | Нет | Свои иконки/звуки на каждый `reason` |

**Чего в экосистеме НЕТ:** MAX (max.ru), Matrix, Discord-бота с полной двусторонностью, Slack-бота с кнопками, голосовых (STT/TTS) в мостах — есть только `@deepseek-ai/dsh-experimental-speech-to-text` + `-client-ui-voice-input` **внутри GUI** (sherpa-onnx, локально), что можно переиспользовать для голосовых из MAX.

### 1.3. Анатомия лучшего образца: `dsh-notify-plugin`

Самое ценное — как именно он встраивается (это ответ на «как вообще делать approve/deny из чата»):

- Вешается на **waterfall** `approval/request` и `user-questions/request` через `prepend`, **сразу пропускает запрос дальше** (не блокирует GUI) и делает `Promise.race([chatAnswer, downstreamAnswer])` → **кто первый ответил, тот и прав**, проигравший получает «уже обработано в другом месте».
- Продолжение диалога — `ctx.sessionController.prompt` (тот же вход, что у веб-GUI; умеет будить «холодную» сессию).
- `/sessions` и `/workspace` — `ctx.sessionController.list` + `ctx.workspaceRegistry`, с фильтрацией пустых сессий и сабагентов.
- Безопасность: **только настроенный `chatId` может управлять** (иначе игнор) — «allowlist by construction».
- Грабли, которые он документирует (и мы наступим, если не учтём):
  - Telegram: если у бота был webhook, long-poll `getUpdates` даёт **409** → нужен `deleteWebhook`.
  - `ctx.connection.rpc.handle()` из стороннего плагина падает (`cannot get property "webServer" without inject`) → нужен свой route на `webServer` с `connection.requestRejection`.
  - `SET`-конфиг страницы — «полная перезапись», а не patch.
  - WeChat iLink: `context_token` временный → после рестарта нужен «пинг» от пользователя. У MAX, судя по нашему research, такой проблемы нет — chat_id достаточно.

### 1.4. Инфраструктура вокруг плагинов

- **Плагин-маркет DSH:** `@deepseek-ai/dsh-plugin-market` + `dsh-plugin-market-index` + `dsh-plugin-manager`. Важно: **индексы не настроены по умолчанию** (`indexes: []`, «no index source is configured by default»), Discover/Settings добавляют URL'ы; формат — JSON с `plugins[]`, `versions[].install` (`name@version`/`git+…#commit`), `engines.dsh`. Он же даёт агенту read-only инструмент `plugin_market`.
- **`config/examples/`** в репозитории `deepseek-ai/deepseek-harness` — по README: оверлеи для GitHub review webhooks, memory MCP и runtime Cordis tools; в npm-пакет не входят. Для нас полезен именно **GitHub-webhook пример** как образец «входящее событие → сессия».
- **Каталоги/поиск:** [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com), [dsh-plugin.org](https://dsh-plugin.org), [dshmk.com](https://dshmk.com/), плагины `dsh-find-plugin` (поиск по GitHub-топику `dsh-plugin`), `dsh-plugin-guide` (официальные доки + матрица совместимости), `create-dsh-plugin-cli`.
- **Вывод по маркету:** чтобы наш MAX-плагин был находимым, его нужно оформить как bundle (`dsh.bundle.patch` + `cordis.patch.yml`) и добавить топик `dsh-plugin` на GitHub — ровно то, что уже сделано в `dsh-max-notify/package.json`.

---

## 2. Практики других агентов (со ссылками)

### 2.1. Claude Code

| Проект | Что делает | Чему учит |
|---|---|---|
| **Claude Code Remote** — [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | Хуки `Stop`/`SubagentStop` → уведомление в **Email / Telegram / LINE / desktop**; ответ в чат = новая команда агенту; инъекция в **tmux или PTY**; группы; трейс выполнения в письме | «Ответ на уведомление = следующий промпт». **Токен-сессии** (8 символов, TTL 24 ч) на каждую tmux-сессию; whitelist отправителей; `TELEGRAM_FORCE_IPV4` как костыль сети; кнопки-подсказки формата команды |
| **ccbot** — [six-ddc/ccbot](https://github.com/six-ddc/ccbot), [dimkk/ccbot](https://github.com/dimkk/ccbot) | Telegram-бот поверх `tmux`-сессии Claude Code: watch, отправка промптов, «выбор варианта» из терминала | Минимальный жизнеспособный мост: один бот ↔ один tmux-сеанс; парсинг TUI для показа «что происходит» |
| **Happy Coder** — [happy.engineering/docs/how-it-works](http://happy.engineering/docs/how-it-works/) | Мобильный клиент (iOS/Android/web) к Claude Code с **E2E-шифрованием**, push-уведомления, «продолжить с телефона» | Правильная модель доверия: сервер не видит содержимое; push — только «сигнал», контент тянется клиентом |
| **Claude Code Channels** (официально) — [code.claude.com/docs/en/channels-reference](https://code.claude.com/docs/en/channels-reference) | Официальный механизм «**пушить события в живую сессию**» из внешних каналов (Discord/Telegram-плагины сообщества), плюс `Hooks` | Это фактически официальный аналог нашего `sessionController.prompt`; направление, в которое идёт Anthropic: канал = транспорт, сессия = единица работы |
| `claude-telegram-notifications` — [mikhailrojo](https://github.com/mikhailrojo/claude-telegram-notifications) | Только уведомления «агент ждёт ввода» | Подтверждает: «waiting for input» — отдельное, самое нужное событие (не только «done») |

**Паттерны, которые стоит забрать:** (а) уведомление содержит ровно тот контекст, чтобы ответить одним сообщением; (б) ответ в чат = следующий ход агента; (в) сессия ≠ процесс: у нас это дешевле, чем tmux; (г) whitelist + TTL токены; (д) «выбор варианта» кнопками вместо набора текста.

### 2.2. Облачные/фоновые агенты: OpenHands, Devin, Copilot, Codex, Cursor

| Продукт | Как устроены уведомления/approvals | Источник |
|---|---|---|
| **OpenHands / Agent Canvas** | Автоматизация «Slack Channel Monitor»: агент слушает канал, реагирует на сообщения/треды; отдельные автоматизации «issue → PR», «PR review» | [docs.openhands.dev — Slack Channel Monitor](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt/slack-channel-monitor) |
| **Devin (Cognition)** | `@Devin` в Slack + естественный язык + **закрытый набор in-thread команд** (verbs); сессии/отчёты приходят в тред; approvals — в своём UI/треде | [docs.devin.ai/release-notes](https://docs.devin.ai/release-notes/2024), обзор паттерна в [заметке про Slack control-plane](https://github.com/anthony-chaudhary/fak/commit/18a7a8a6c69786cb69cb3cbae17191f00d2e5b5c) |
| **GitHub Copilot cloud agent** | Задача назначается на issue/PR; интеграция **Copilot ↔ Slack** для запуска и уведомлений о ходе/результате; финальный артефакт — PR + summary | [GitHub Docs: integrate Copilot cloud agent with Slack](https://raw.githubusercontent.com/github/docs/refs/heads/main/content/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack.md) |
| **OpenAI Codex (cloud) / ChatGPT** | Запуск задач из Slack, ответы в тред, линк на результат | [learn.chatgpt.com/docs/third-party/slack](https://learn.chatgpt.com/docs/third-party/slack), [use-case «coding tasks from Slack»](https://learn.chatgpt.com/fr-FR/use-cases/slack-coding-tasks) |
| **Cursor background agents / automations** | Фоновые агенты + automations по триггерам (Slack/webhook), уведомления о завершении | [cursor.com/blog/automations](https://cursor.com/blog/automations) |

**Общий паттерн «облачного» класса:** чат — это **тонкий control plane**: постановка задачи (mention/команда) → «принял, работаю» (одно сообщение, которое потом редактируется) → **артефакт** (PR/файл/скриншот) → финальный отчёт в тред. Approvals — там, где есть риск (запись в репо), и они **явные, с кнопками**. Никто не льёт в чат поток Tool-call'ов — только вехи.

### 2.3. «Agent in messenger»: OpenClaw (ex-Clawdbot/Moltbot)

- [OpenClaw — Channels & Plugins](https://docs.molt.id/getting-started/openclaw-service/channels-and-plugins), [гайд по установке](https://www.sitepoint.com/how-to-set-up-openclaw-on-a-mac-mini/).
- Модель: **агент живёт в мессенджере как контакт** (Telegram/WhatsApp/Discord/Slack), у него есть «сессии» по чатам, память, инструменты, и он сам пишет тебе, когда что-то случилось. Каналы — плагины с единым интерфейсом (входящие сообщения + исходящие + вложения).
- Чему учит: (а) **канал = плагин с единым контрактом** — у нас MAX должен быть одним из провайдеров, а не хардкодом; (б) у каждого чата своя сессия/контекст; (в) вложения — first-class (иначе «пришли скриншот» ломается); (г) голосовые сообщения — обычный вход, а не экзотика.

### 2.4. Сводные паттерны (что делают все)

1. **Одно «живое» сообщение на ход** (edit вместо новых сообщений) — иначе чат превращается в лог.
2. **События важнее текста:** done / error / waiting-for-input / approval-needed / subagent-done.
3. **Кнопки для решений**, текст — для свободных ответов. Кнопки всегда с «кто уже ответил».
4. **Продолжение разговора из чата** — главная ценность; без неё это пейджер.
5. **Явный allowlist** и «fail closed».
6. **Не блокировать агент** при сбое транспорта (never-throw, таймауты, ретраи).
7. **Артефакты, а не простыни:** файл/скриншот/дифф + короткое резюме.
8. **Тишина — фича:** DND, «я в GUI», дебаунс, «не спамить сабагентами».

---

## 3. Каталог фич для MAX-плагина (сложность S/M/L)

Оценка: **S** ≈ до дня, **M** ≈ 1–3 дня, **L** ≈ 3+ дней / требует нового сервиса или аккуратной конкурентности. «Сейчас» — состояние `dsh-max-notify` v0.1.0 (только one-way last message + allowlist + chunking + retries).

### Уровень 1 — «дешёвые победы» (S)

| # | Фича | Что делает / зачем | Как у других | Слож. |
|---|---|---|---|---|
| 1 | **Событийные уведомления вместо «каждого сообщения»** | Notify на `turn/end` по `reason`: done / error / interrupted / blocked; заголовок с эмодзи и названием сессии | `@goodandready/dsh-plugin-notify`: `events: [task_done, error, approval_requested]`; `dsh-notify-plugin`: `conversationCompleted/Paused/Failed` | S |
| 2 | **`approval_requested` (только уведомление, без кнопок)** | Сообщение «нужно разрешение: `bash`, причина …» — уже снимает 80% боли «агент ждёт, а я не знаю» | `dsh-plugin-notify`, `dsh-notify-me` («需要你操作») | S |
| 3 | **`ask_user_question` → уведомление с текстом вопроса и вариантами** | Показать нумерованные опции, чтобы можно было ответить цифрой (пока — вручную в GUI) | `dsh-notify-plugin`: `confirmationRequired` + нумерованные опции | S |
| 4 | **Дедуп/дебаунс и «одно сообщение на ход»** | Не спамить: правки одного сообщения (edit) или агрегация 2–3 событий в окно 2–3 с | `dsh-notify-plugin`: todo «по сессии с дебаунсом, только при изменении прогресса» | S |
| 5 | **`includeSubagents`/`notifySubagents` + `excludeSessionPrefixes` + DND-окно** | Уже частично есть (`includeSubagents`, `skipReasons`). Добавить `dnd: {start,end}` и «не будить, если открыт GUI» | `@goodandready`, `dsh-notify-me` (`idleMinutes`, `donePolicy`) | S |
| 6 | **`/status`, `/stop`, `/help`, `/id`** | `/status` — что за сессия, running?, сколько токенов/времени; `/stop` — прервать текущий ход; `/help` — список команд (у MAX нет нативного меню команд) | `dsh-notify-plugin`: `/sessions` `/workspace` `/current` `/help`; Claude-Code-Remote: slash-команды | S–M |
| 7 | **Кнопки-ссылки на сессию** | «Открыть в GUI» → URL `http://127.0.0.1:3480/#/session/<id>` (inline URL-кнопка) | `dsh-plugin-notify` web push deep-link `?dshNotifySession=<id>` | S |
| 8 | **Форматирование под MAX + разбиение + «свернуть длинное»** | Уже есть chunking; добавить «первые N строк + ‹продолжение в GUI›» | `dsh-notify-plugin`: ответ ≤500 символов в уведомлении, полный — в GUI | S |

### Уровень 2 — «пульт» (M)

| # | Фича | Что делает / зачем | Как у других | Слож. |
|---|---|---|---|---|
| 9 | **Двусторонний чат: текст из MAX = следующий промпт** | Любое сообщение (не команда) уходит в «текущую» сессию через `sessionController.prompt`; умеет будить холодную сессию. Это killer-feature | `dsh-notify-plugin`: «续接对话» через `ctx.sessionController.prompt`; Claude-Code-Remote: reply → команда | M |
| 10 | **Inline-кнопки approve/deny для разрешений** | `approval/request` waterfall: `prepend` → отправить карточку с кнопками → `Promise.race` с GUI → «кто первый». Клик по кнопке должен **сразу убирать клавиатуру** (анти-дубль) | `dsh-notify-plugin` (Telegram: «✅批准 / ❌拒绝», Y/N тоже работают); `dsh-notify-me`: `decide('allowed-once'|'rejected')` | M–L |
| 11 | **Ответы на `ask_user_question` кнопками** | Для одного вопроса с опциями — кнопки; для multi-select/свободного текста — «ответь цифрой/текстом» | `dsh-notify-plugin`: single-question → option buttons; multi → числа/текст | M |
| 12 | **`/sessions`, `/use <n>`, `/current` — переключение цели** | Список последних сессий кнопками/номерами; «куда уйдёт мой следующий текст» всегда видно | `dsh-notify-plugin`: `/sessions` (фильтр пустых и сабагентов), `/sel s N` | M |
| 13 | **`/new` — новая сессия из MAX** | Создать сессию в выбранном workspace и писать в неё | `dsh-notify-plugin`: `/workspace` → «沿用该工作区最新对话, 没有则自动新建»; OpenHands: автоматизация создаёт сессию | M |
| 14 | **Live-прогресс: typing + редактирование одного сообщения** | «Работаю… (шаг 3: bash)» — одно сообщение, обновляется; typing-action как heartbeat | Telegram `sendChatAction`/`editMessageText`; аналог в MAX — `PUT /messages/{id}` (см. `research/max-api.md`) | M |
| 15 | **Кнопка «Стоп»/«Прервать» на каждом running-уведомлении** | Одна кнопка вместо команды; спасает при «агент ушёл не туда» | ccbot/Claude-Code-Remote: stop/interrupt | M |
| 16 | **Файлы из MAX → агенту (вложения)** | Прислал скриншот/лог → он стал attachment сессии (`dsh-attachment`), а не текстом | OpenClaw: вложения first-class; OpenHands/Copilot: скриншоты и файлы в отчётах | M |

### Уровень 3 — «продукт» (L)

| # | Фича | Что делает / зачем | Как у других | Слож. |
|---|---|---|---|---|
| 17 | **Файлы/скриншоты из агента в MAX** | `present`/deliverables → отправить документ/картинку в чат; скриншот результата сборки | Devin/Copilot: артефакт = PR + summary; `@deepseek-ai/dsh-tool-present` уже отдаёт файлы | L (загрузка в MAX Bot API) |
| 18 | **Несколько чатов/групп и маршрутизация по сессиям** | 1 сессия ↔ 1 топик/чат; группа = команда; «ветки по сессиям» как в Slack-тредах | OpenClaw: сессия на чат; Claude-Code-Remote: группы для команды | L |
| 19 | **Голосовые: STT (голос → промпт) и TTS (ответ голосом)** | В MAX голосовые — обычный формат; локальный STT уже есть в DSH (`dsh-experimental-speech-to-text`, sherpa-onnx) | OpenClaw: голос как вход; DSH voice-input в GUI | L |
| 20 | **Дайджесты и отчёты** | «За ночь: 3 сессии, 2 PR, 1 ошибка» — утренний дайджест; недельный отчёт по стоимости | Claude-Code-Remote TODO: cost tracking, scheduled reports | M–L |
| 21 | **Оффлайн-очередь и идемпотентность** | MAX недоступен / 429 → персистентная очередь с ретраями и дедупом по `eventId`; после рестарта ничего не теряется и не дублируется | `dsh-notify-me`: ретраи 2s/6s + журнал «недоставленных»; `@goodandready`: «failed POSTs logged, never retried» (анти-пример) | M |
| 22 | **Настройки из GUI DSH + секреты** | Карточка в Settings → Plugins: токен (write-only), chat_id, события, DND; токен в Credentials, не в YAML | `dsh-notify-plugin` (свой `/dsh-notify` RPC + `settings.section`), `maestro-notifier` (`hasBotToken`), `@goodandready` (Credentials) | M |
| 23 | **Безопасность: allowlist, fail-closed, «опасные» действия под подтверждение** | Уже есть allowlist; добавить: неизвестный chat → игнор+лог; `/stop` и approve требуют «своего» чата; ники/секреты не логировать; подпись исходящих webhook (если появятся) | `dsh-notify-me`: HMAC `X-DSH-Notify-Signature`; `maestro-notifier`: `protect_content` | S–M |
| 24 | **Мультипровайдерность (MAX как один из)** | Абстракция `transport` → `max`/`telegram`/`discord`/`webhook`; ядро не знает про MAX | `maestro-notifier` (реестр провайдеров), OpenClaw (канал = плагин) | M (но окупается) |

### Что НЕ стоит делать (анти-паттерны из чужих README)

- **Стримить каждый tool-call в чат** — все проекты этого избегают; только вехи.
- **Инжектить в процесс/PTY/tmux** — у DSH есть `sessionController.prompt`; инъекция = хрупко и небезопасно.
- **Ретраить бесконечно «потому что важно»** — у `@goodandready` сознательно «failed → log, no retry»; лучше ограниченная очередь с журналом.
- **Хранить токен в `cordis.patch.yml`** — только Credentials/env/file с правами 0600 (у нас уже `botTokenFile`).
- **Отвечать «✅ отправлено», не проверив** — `dsh-notify-me` отдельно различает «доставлено» / «отправлено, но не подтверждено»; для MAX стоит смотреть HTTP-код и тело.

---

## 4. Приоритизация (если делать по волнам)

**Волна 1 (1–2 дня, без двусторонности) — «перестать быть пейджером»**
№1 события+reason, №2 approval-уведомление, №3 вопрос с опциями, №6 `/status` `/help` `/stop`, №7 кнопка «открыть сессию», №4 дедуп/одно сообщение.

**Волна 2 (3–5 дней) — «пульт»**
№9 текст из MAX → промпт, №10 approve/deny кнопками (waterfall + race), №11 ответы на вопросы, №12 `/sessions`+`/use`, №14 live-edit, №22 настройки в GUI, №23 безопасность.

**Волна 3 — «продукт»**
№13 `/new`, №15 кнопка «Стоп», №16/17 файлы в обе стороны, №18 группы/ветки, №19 голос, №20 дайджесты, №21 очередь, №24 мультипровайдерность.

**Метрика успеха:** доля ходов, завершившихся без открытия веб-GUI; и «время от `approval/asked` до ответа» (должно упасть с минут до секунд).

---

## 5. Грабли, зафиксированные в чужих README (сэкономят нам дни)

1. **Telegram webhook vs long-poll 409** — если бот когда-то ставил webhook, `getUpdates` падает; нужен `deleteWebhook`. Для MAX — обратная ситуация: long-poll `GET /updates` штатный, webhook не обязателен.
2. **`ctx.connection.rpc.handle()` из стороннего плагина падает** (`cannot get property "webServer" without inject`) — нужен собственный route на `webServer` + `connection.requestRejection` (см. `dsh-notify-plugin`).
3. **Конфиг-строки в patch-слое заменяются целиком** — при override не забыть обязательные ключи (уже отмечено в нашем `cordis.patch.yml`).
4. **`link:`-плагины не могут импортировать `@deepseek-ai/*`** — отсюда наш zero-dependency стиль; при добавлении кнопок/HTTP-клиента это надо сохранить (или переходить на полноценный пакет с `peerDependencies`).
5. **Approval-гонка**: если «съесть» решение и не пропустить downstream — GUI зависнет; нужен `prepend` + пропуск + `Promise.race` + явное «уже обработано в другом месте».
6. **Секреты в URL/логах** — MAX-токен в query (`access_token=`) легко утекает в логи; маскировать.
7. **Сабагенты** — отдельные сессии в списке, но не отдельные «дела»; по умолчанию молчать (у нас уже `includeSubagents: false`).

---

## 6. Источники

**DSH-экосистема**
- `dsh-notify-plugin` (Telegram/WeCom/WeChat, двусторонний) — https://github.com/btboys/dsh-notify · https://www.npmjs.com/package/dsh-notify-plugin
- `@goodandready/dsh-plugin-notify` (webhooks + web push + события) — https://github.com/GooDAnDReaDY/dsh-plugin-notify
- `dsh-notify-me` (approve/deny из нотификации, политики напоминаний) — https://github.com/chromoany/dsh-notify-me
- `@alotop/dsh-notify-hub` — https://github.com/alotop/dsh-notify-hub
- `@ddtcorex/dsh-maestro-notifier` (реестр провайдеров, never-throw) — https://github.com/ddtcorex/dsh-maestro-notifier
- `dsh-notification` — https://github.com/nishit130/dsh-notification · `dsh-notify` — https://github.com/Pasumao/dsh-plugin-notify · `dsh-notify-windows` — https://github.com/SeverusZh/dsh-notify-windows · `@telosmaylx/dsh-session-notify` — https://github.com/TelosmaYLX/dsh-session-notify
- `@deepseek-ai/dsh-webhook` / `dsh-webhook-github` (входящие webhook → сессия; alpha, в 0.2.1-rc.4 не установлены) — https://www.npmjs.com/package/@deepseek-ai/dsh-webhook
- Каталоги плагинов: https://awesome-dsh-plugin.com · https://dsh-plugin.org · https://dshmk.com/ · `dsh-find-plugin`, `dsh-plugin-guide`, `create-dsh-plugin-cli` (npm)
- Локальные README ядра: `$DSH/node_modules/@deepseek-ai/dsh-plugin-market/README.md` (индексы по умолчанию пусты), `dsh-plugin-manager`, `dsh-user-approval`, `dsh-session`, `dsh-workspace`

**Claude Code / агенты в чате**
- Claude Code Channels (официально) — https://code.claude.com/docs/en/channels-reference
- Claude Code Remote (email/Telegram/LINE, tmux/PTY, токены) — https://github.com/JessyTsui/Claude-Code-Remote
- ccbot — https://github.com/six-ddc/ccbot · https://github.com/dimkk/ccbot
- Happy Coder (E2E мобильный клиент) — http://happy.engineering/docs/how-it-works/
- claude-telegram-notifications — https://github.com/mikhailrojo/claude-telegram-notifications
- OpenClaw (ex-Clawdbot/Moltbot) — https://docs.molt.id/getting-started/openclaw-service/channels-and-plugins · https://www.sitepoint.com/how-to-set-up-openclaw-on-a-mac-mini/

**Облачные агенты**
- OpenHands Slack Channel Monitor — https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt/slack-channel-monitor
- Devin release notes / Slack-паттерн — https://docs.devin.ai/release-notes/2024
- Copilot cloud agent ↔ Slack — https://raw.githubusercontent.com/github/docs/refs/heads/main/content/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack.md
- ChatGPT/Codex в Slack — https://learn.chatgpt.com/docs/third-party/slack
- Cursor automations — https://cursor.com/blog/automations

**Внутренние материалы этого репозитория**
- `research/dsh/plugin-api.md` — проверенный API out-of-tree плагинов
- `research/max/` — MAX Bot API (кнопки, edit, вложения, лимиты)
