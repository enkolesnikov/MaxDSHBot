# dsh-max-notify

DSH (DeepSeek Harness) plugin: forward **the last assistant message of every
agent turn** to **MAX messenger** (max.ru) through a bot — and drive the agent
from MAX ("Пульт"): chat, commands, approvals, questions, live progress and
file deliverables.

- Zero runtime dependencies (relative imports + `node:` builtins only — required
  for `link:`-installed DSH plugins, which cannot import `@deepseek-ai/*`).
- Reads DSH `session/event` (`assistant/message` + `turn/end`), so exactly one
  MAX message per user-visible turn, not per tool step.
- Ships the Russian Trusted Root CA chain: `platform-api2.max.ru` is not trusted
  by the system store (Node/curl fail verification by default).
- Handles MAX limits: 4000 chars (paragraph-aware chunking), 2 messages/second
  per chat, 429 `Retry-After`, 5xx/network retries.
- Skips subagent child sessions by default; skips `interrupted`/`forked` turn
  endings (restore-time stale closers) by default.
- Never breaks the profile: a bad/missing config only logs a warning and leaves
  the plugin inert.
- Remote control: long-polls `GET /updates` and injects your messages into the
  active session via `sessionController.prompt`; commands `/status`, `/stop`,
  `/sessions`, `/use N`, `/current`, `/help`; inline buttons under answers.
- Approvals and agent questions (`ask_user_question`) are answered from MAX
  buttons or free text: the plugin prepends to the host waterfalls, delegates to
  the Web GUI immediately and races both channels (`Promise.race`).
- Live progress card (edited in place, `typing_on`) and `present` deliverables
  uploaded as MAX attachments.
- Images from the final answer and from tool results: assistant/tool image
  blocks plus images referenced in the visible markdown (local paths relative
  to the session cwd, or http(s) URLs) are uploaded and attached to the MAX
  message; code samples are ignored and files already sent by `present` are not
  duplicated.
- Incoming files: an attachment sent by the allowlisted owner in MAX is
  downloaded into `<session cwd>/max-inbox/` (safe names, per-file and count
  limits) and handed to the agent as a prompt listing the local paths.
- Observability: subagent/job/goal/error notifications, TODO progress, daily
  digest, notification modes (`/mode`, `/mute`, `/unmute`) and quiet hours.

## Package layout

| File | Role |
|---|---|
| `index.js` | cordis plugin: `name`, `inject`, `apply(ctx, config)` |
| `lib/transport.mjs` | MAX Bot API client over `node:https` with bundled CA |
| `lib/extract.mjs` | visible assistant text / reason helpers |
| `lib/format.mjs` | MAX message header + body |
| `certs/ca-chain.pem` | Russian Trusted Sub CA + Root CA (PEM) |
| `cordis.patch.yml` | bundle patch: inserts the `max-notify` row + config |
| `install.sh` | `dsh plugin --profile <name> add link:<this dir>` |
| `tools/pair.mjs` | long-poll `GET /updates` to discover `chat_id` |
| `tools/send-test.mjs` | manual send test |
| `test/*.test.mjs` | `node --test test/*.test.mjs` (32 unit tests) |

## Config

Set in `cordis.patch.yml` (or override the row by id from the profile's own
`cordis.patch.yml`; an override replaces the whole config object):

| Key | Default | Meaning |
|---|---|---|
| `botToken` / `botTokenFile` | env `MAX_BOT_TOKEN` | Bot token, or a file containing it / `MAX_BOT_TOKEN=...` |
| `chatId` / `userId` | env `MAX_CHAT_ID` | Target chat or user id (one of them) |
| `format` | `markdown` | `markdown` \| `html` \| plain |
| `notify` | `true` | Push notifications |
| `disableLinkPreview` | `true` | sent as a **query** param (MAX requirement) |
| `includeHeader` | `true` | `**DSH** · 22:15 · <title>` line |
| `includeTitle` | `true` | Session title via `ctx.get('sessionTitle')`, fallback cwd |
| `includeSessionId` | `false` | Append short session tag |
| `includeSubagents` | `false` | Also forward child agent sessions |
| `allowedUserIds` | env `MAX_ALLOWED_USER_IDS` | **Recipient allowlist**: only send to these MAX user ids; a dialog must belong to one of them |
| `allowedChatIds` | env `MAX_ALLOWED_CHAT_IDS` | Explicit chat allowlist (skips the dialog check) |
| `skipReasons` | `['interrupted','forked']` | Turn endings never forwarded |
| `maxChars` | `3800` | Sanity clamp (API hard limit 4000) |
| `enabled` | `true` | Master switch |
| `dryRun` | `false` | Log instead of sending |
| `requestTimeoutMs` / `maxRetries` / `minIntervalMs` | `15000` / `3` / `600` | Transport tuning |
| `notifyOnStart` | `false` | One-shot "plugin connected" message |
| `polling` / `pollTimeoutSec` | `true` / `25` | Long polling `GET /updates` (one poller per token) |
| `interactive` | `true` | Accept chats/callbacks and commands |
| `approvalChannel` / `questionChannel` | `both` | `both` (MAX+GUI race), `max`, `gui` |
| `buttons` / `webUrl` | `true` / `DSH_WEB_URL` | Quick-action buttons + GUI link |
| `progress` / `progressDelayMs` / `progressThrottleMs` / `typing` | `true` / `2500` / `2000` / `true` | Live progress card |
| `deliverables` | `true` | Send `present` files as attachments |
| `forwardImages` / `forwardToolImages` / `maxImages` | `true` / `true` / `4` | Attach images from the final answer and tool results |
| `receiveFiles` / `inboxDir` / `maxIncomingFiles` / `maxIncomingBytes` | `true` / `<cwd>/max-inbox` / `4` / `25 MiB` | Incoming MAX attachments |
| `registerCommands` / `greetOnStart` | `true` / `true` | MAX command menu and Start greeting |
| `stateFile` | `$DSH_HOME/max-notify/state.json` | Polling marker, active session, mode, digest date |
| `notifySubagents` / `notifyJobs` / `notifyGoals` / `notifyErrors` | `true` | Event notifications |
| `notifyAwaitedJobs` | `false` | Also notify jobs the agent already waited for |
| `todoProgress` | `true` | TODO progress notifications |
| `quietHours` | — | `{start, end}`: non-critical delivered without push |
| `mode` / `digestEnabled` / `digestTime` | `all` / `false` / `21:00` | Notification mode and daily digest |

## Remote control ("Пульт")

Write to the bot in MAX — the text becomes the next prompt of the active
session (default: most recent session; `/use N` to switch). Commands:

| Command | Action |
|---|---|
| `/status` | Active session, state, model, folder, last update |
| `/stop` | Cancel the active turn |
| `/sessions` | List sessions (numbered); archived sessions are hidden |
| `/use N` | Switch the active session |
| `/current` | Show the active session |
| `/help` | Command help |
| `/mode [all\|errors\|mute]` | Notification mode |
| `/mute [30m\|2h]`, `/unmute` | Mute/unmute non-critical notifications |
| `/digest` | Send the digest now |

Approvals and `ask_user_question` cards carry inline buttons; free text answers
questions too (option number, option label or custom text; multiple questions —
numbers separated by spaces). The plugin solves on the first channel to answer
(MAX or Web GUI) and marks the other card accordingly.

## Recipient allowlist ("only me")

Set `allowedUserIds: [987654321]` (numbers from YAML are accepted; and/or
`allowedChatIds`) to pin the recipient.
Before the first send the plugin resolves `GET /chats/{chatId}`; the chat must be
a personal `dialog` whose `dialog_with_user.user_id` is allowlisted, otherwise
nothing is sent and a warning is logged (**fail closed**). If `userId` is the
target, it must be in `allowedUserIds` directly. With both lists empty the
plugin behaves as before (sends to the configured target only).

## Install (into a DSH profile)

```bash
./install.sh                 # profile web
./install.sh tui             # another profile
```

This runs `dsh plugin --profile <p> add link:<this dir>`, which records the
`link:` dependency and appends the package to `dsh.profile.bundles`; the
bundle's `cordis.patch.yml` then inserts the row. Verify with:

```bash
dsh --profile web --dump-config | grep -A12 'id: max-notify'
```

A CLI package add usually reconciles the running profile through HMR; if not,
restart the profile's app (`systemctl restart dsh-web`). Remove with
`dsh plugin --profile web remove dsh-max-notify`.

## Notes / limits

- MAX markdown has no lists/tables: `- item` renders literally.
- 4000 chars per message; the plugin chunks long replies (up to 8 chunks).
- Receiving uses long polling: one poller per bot token (do not run
  `tools/pair.mjs` while the plugin is polling). For production MAX recommends a
  webhook (public HTTPS :443 + trusted cert) — then set `polling: false`.
- The live progress card is deleted at turn end; if deletion fails it is edited
  to "✅ Готово".
- The allowlist check is cached per process; changing the recipient requires a
  plugin reload/restart of the profile.
- `interrupted`/`forked` are skipped because they are restore-time synthetic
  closers that can carry stale text from a crashed run.
