# MAX messenger Bot API — transport notes for the DSH → MAX relay

Status: **verified live on 2026-10-27** against bot `My Bot` (`@your_bot`, `user_id 100000001`)
in dialog `chat_id 123456789` using `scratch/max-poc/send.mjs`.
Sources: `dev.max.ru/docs-api` (fetched 2026-10-27), official OpenAPI schema
[`max-messenger/api-schema`](https://github.com/max-messenger/api-schema) (`schema.yaml`), official
[`max-messenger/max-agents-skill`](https://github.com/max-messenger/max-agents-skill) references,
and live API/TLS probes (evidence in §11). Anything marked **(secondary)** comes from the official
MAX Agent Skill, not from the method pages we fetched.

Scope: one-way delivery of DSH agent messages to a MAX user dialog, plus one-time pairing
(discovering `chat_id`/`user_id`). Media uploads, keyboards, mini-apps and comments are out of
scope except where noted.

---

## 0. TL;DR

| Item | Value |
|---|---|
| Base URL | `https://platform-api2.max.ru` — mandatory since **2026-07-19**; old `platform-api.max.ru` is deprecated |
| Auth | `Authorization: <bot token>` — raw token, **no** `Bearer`; query-param token no longer supported |
| TLS | Leaf `*.max.ru` → **Russian Trusted Sub CA** → **Russian Trusted Root CA** (Минцифры). Root is absent from public stores; pin the **root** (files + embedded PEM provided) |
| Send | `POST /messages?chat_id=<id>` (or `?user_id=<id>`), JSON body `{text, format, notify, attachments, link}` |
| Response | `{message:{recipient,timestamp,body:{mid,seq,text,markup},sender}}`; `mid` is the message id |
| Text limit | **4000 characters** of raw `text` (markup chars count) |
| Rate | **2 messages/second per dialog/chat/channel** (docs); global ~30 rps **(secondary)** |
| Formatting | `format: "markdown"` or `"html"`; Markdown is CommonMark-0.29-ish subset, **no lists/tables/hr** |
| Gotcha | `disable_link_preview` is a **query parameter**, not a body field (see §3.2 — the brief's body claim is wrong) |
| Pairing | `GET /updates` long polling with `marker`; `bot_started` gives `chat_id`+`user`; updates are **consumed once**, webhook disables polling, production requires webhook |
| Module | `scratch/max-poc/send.mjs` — dependency-free Node ≥20/24 ESM (`createMaxClient`, `sendMessage`, `getMe`, `getUpdates`, `splitText`) |

---

## 1. Host and authentication

- **Host:** `https://platform-api2.max.ru` for every Bot API method.
  - The old host `https://platform-api.max.ru` is deprecated; the mandatory cutover was
    **2026-07-19** ([changelog](https://dev.max.ru/docs-api/changelog-api/)). The old host chained
    to HARICA (globally trusted), which is why pre-cutover code "just worked" without extra CA setup.
  - No shutdown date is published for the old host; new integrations must use `platform-api2.max.ru`.
- **Auth:** header `Authorization: <access_token>`; the token is the raw bot token with **no**
  `Bearer` prefix. Passing the token as a query parameter is **unsupported** (docs: "Передача
  токена через query-параметры больше не поддерживается").
  Verified error shape for a bad token: HTTP `401` `{"code":"verify.token","message":"Invalid access_token"}`.
- Tokens are issued per bot on the MAX business/partner platform after bot moderation. Treat as a
  secret: never put it into logs, URLs, error objects or deliverables. `send.mjs` exports
  `maskToken()` for safe logging.

---

## 2. TLS: the Russian Trusted Root CA (Минцифры)

### 2.1 Chain and why it breaks

```
leaf  CN=*.max.ru, O=MAX LLC, C=RU            (TLS server auth, SAN DNS:*.max.ru)
  └─ Russian Trusted Sub CA                    (O=The Ministry of Digital Development and Communications, C=RU)
       └─ Russian Trusted Root CA              (same O, self-signed)
```

The root is **not** in Mozilla/Go/Node/Debian/Docker default trust stores. Any unpatched client
fails verification:

- Node: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `unable to get local issuer certificate`
- curl: exit 60 `SSL certificate problem: unable to get local issuer certificate`
- Go: `x509: certificate signed by unknown authority`

The MAX API server sends the **leaf + Sub CA** in the handshake, so a trusting client only needs the
**root** in its store. Pin the **root**, never the intermediate: the intermediate rotates (see 2.4).

### 2.2 Where the official root PEM comes from

Primary source: **Authority Information Access → CA Issuers** embedded in the Sub CA certificate:

```
$ openssl x509 -in sub.pem -text -noout | grep -A2 'CA Issuers'
  CA Issuers - URI:http://nuc-cdp.voskhod.ru/cdp/rootca_ssl_rsa2022.crt
  CA Issuers - URI:http://nuc-cdp.digital.gov.ru/cdp/rootca_ssl_rsa2022.crt
```

Both URLs return `application/x-x509-ca-cert`, 2088 bytes, **identical** SHA-256
`936a43fe…c6504`; re-encoded PEM is saved here as `certs/root.pem`.

Official distribution mirrors (cross-checked byte-for-byte identical root):

- `https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt` ← recommended by the official
  [MAX Agent Skill `references/tls-trust.md`](https://github.com/max-messenger/max-agents-skill/blob/main/references/tls-trust.md)
- `https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer`
- Landing / manual download: `https://www.gosuslugi.ru/crt` (may be geo-restricted)

### 2.3 Root certificate facts (verified with openssl)

```
subject/issuer : C=RU, O=The Ministry of Digital Development and Communications, CN=Russian Trusted Root CA
serial         : 0x1000
validity       : 2022-03-01 21:04:15 UTC → 2032-02-27 21:04:15 UTC
basicConstraints: critical CA:TRUE, pathlen:4
keyUsage       : critical (keyCertSign, cRLSign …)
SHA-256        : D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
```

Leaf (for reference, rotates):
```
CN=*.max.ru, O=MAX LLC, C=RU, ST=77 Moscow, L=Moscow
serial 400BAD43B806469098374E9708F16578, valid 2026-06-06 → 2027-06-06
SAN DNS:*.max.ru · KU Digital Signature, Key Encipherment · EKU TLS Web Server Authentication
SHA-256 78:C8:54:E2:B4:F2:24:80:B1:CA:8E:2E:0C:2A:2A:27:7C:23:79:21:98:AD:8B:34:D1:95:90:59:9D:FD:29:25
```

### 2.4 Intermediate rotation — why only the root may be pinned

The live Sub CA already differs from the one currently published on `gu-st.ru`:

| | serial | validity | SHA-256 (subject hash) |
|---|---|---|---|
| live Sub CA (served by MAX today) | `0x1005` | 2024-07-15 → **2029-07-19** | `21:55:78:50:…:A3:F2` |
| `gu-st.ru` published Sub CA | `0x1002` | 2022-03-02 → **2027-03-06** | `BB:BD:E2:10:…:FD:9B` |

They share the same subject and both chain to the same root, but the published intermediate does
**not** verify our current leaf (`openssl verify -untrusted <gu-st sub>` → "unable to get local
issuer certificate"). Conclusion: trust only the root; accept the server-sent intermediate. The
official skill also says "Sub CA expires 2027-03-06 — do not pin it" (that date refers to the
published one; MAX has already rotated it).

### 2.5 Files in this repo (`scratch/max-poc/certs/`)

| File | Contents | SHA-256 of PEM file |
|---|---|---|
| `leaf.pem` | `*.max.ru` leaf (captured 2026-10-27) | `dad486912b9a69cdf7bb48d329ea0aa54c5ee49881d664e6c5c4e025b6430e19` |
| `sub.pem` | live Russian Trusted Sub CA | `6f9d829c8e6712444fce3624658d8788672849c5d5b7b53fd9cf7e83eac4193e` |
| `root.pem` | official Russian Trusted Root CA | `aa800ef345422d6158c6fafe1c06c429dbda21c3df4bb1ccb45a920ec1111399` |
| `ca-chain.pem` | `sub.pem + root.pem` (2 certs) | `bd525da28a2af7c8140cadf5ba588060cc5a546d0075e067c704ad1e92a7ade1` |

Regenerate anytime:

```bash
openssl s_client -connect platform-api2.max.ru:443 -servername platform-api2.max.ru -showcerts </dev/null
# or simply:
curl -fsSL -o root.pem https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
curl -fsSL -o sub.pem  https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt  # may be stale; prefer s_client
```

### 2.6 Cryptographic verification (exact outputs)

```
$ openssl verify -CAfile certs/root.pem -untrusted certs/sub.pem certs/leaf.pem
certs/leaf.pem: OK

$ openssl verify -CAfile certs/ca-chain.pem certs/leaf.pem
certs/leaf.pem: OK

$ openssl x509 -in certs/leaf.pem -noout -checkhost platform-api2.max.ru
Hostname platform-api2.max.ru does match certificate

$ openssl x509 -in certs/root.pem -noout -fingerprint -sha256
sha256 Fingerprint=D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
```

Also proven end-to-end: `curl --cacert root.pem` against `https://platform-api2.max.ru/...`
returns `ssl_verify_result 0`; Node `https.request({ca: root.pem, servername: 'platform-api2.max.ru'})`
handshakes TLSv1.3 with `socket.authorized === true`; the same request with the system store fails
with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (see §11).

### 2.7 Wiring the CA into Node clients

- **This module:** the root PEM is embedded as `RUSSIAN_TRUSTED_ROOT_CA_PEM` and passed as
  `https.request({ ca, servername })`. Nothing else is required. Override via
  `createMaxClient({ ca })`; pass `ca: null` to use the system store.
- **Built-in `fetch`/undici:** `NODE_EXTRA_CA_CERTS=/path/root.pem node bot.js` (process-wide), or
  an `undici.Agent({ connect: { ca } })` as a custom `fetch` (useful when env vars are not
  controllable).
- **System store (Docker/Linux):** copy root as `/usr/local/share/ca-certificates/*.crt` and run
  `update-ca-certificates`; Node's built-in TLS still needs `NODE_EXTRA_CA_CERTS`, Go picks up the
  OS store automatically.
- **curl:** `curl --cacert root.pem ...`.
- **Never** use `curl -k`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`,
  `InsecureSkipVerify`, `verify=False` in production — it disables verification for every host in
  the process. Fix trust instead; it is one PEM file.

Only `platform-api2.max.ru` needs the extra root. Upload hosts (`iu.oneme.ru`, `fu.oneme.ru`,
`omub.okcdn.ru`, `st.max.ru`, …) chain to globally trusted CAs and are not used by this text relay.

---

## 3. `POST /messages` — send a text message

### 3.1 Request

```
POST https://platform-api2.max.ru/messages?chat_id=<chatId>
Authorization: <token>
Content-Type: application/json

{"text":"**bold** and `code`","format":"markdown","notify":true}
```

**Query parameters** (recipient selection):

| Param | Type | Notes |
|---|---|---|
| `chat_id` | int64 | Send to chat/channel/dialog. Exactly one of `chat_id`/`user_id`. |
| `user_id` | int64 | Send to a user dialog. |
| `disable_link_preview` | bool | **QUERY param**; `true` suppresses link previews. Default `false` (server generates previews). |

**JSON body** = `NewMessageBody`:

| Field | Type | Notes |
|---|---|---|
| `text` | string \| null | up to **4000 characters** (markup symbols count) |
| `format` | `"markdown"` \| `"html"` \| null | omit for plain text |
| `notify` | bool, default `true` | `false` = no push notification; channels require `true`/absent |
| `attachments` | array \| null | max 12 media; not needed for the text relay |
| `link` | object \| null | `{type:"reply"\|"forward", mid:"<mid>"}` to reply/forward |

Notes:
- The recipient (`chat_id`/`user_id`) is **never** a body field. Unknown body fields are silently
  ignored (live-probed, §11.5) — putting `disable_link_preview` in the body silently does nothing.
- There is **no idempotency key**. A generic network failure or 5xx after the request reached the
  server may still have delivered the message: retry only `429` (not delivered) and idempotent GETs,
  never blindly retry a failed POST.
- Do not send to `chat_id` that you have not paired; `chat_id=999999999999999` → `404 chat.not.found`.

### 3.2 Gotcha: `disable_link_preview` lives in the query string

The method page lists it under "Параметры" (query), and the OpenAPI schema says
`in: query` for `POST /messages`, `POST /messages/{id}/comments` and `POST /answers`. Live probes
confirm it (§11.5):

- `POST /messages?chat_id=…&disable_link_preview=notabool` → `400 {"code":"proto.payload","message":"Failed to convert value: 'notabool'"}` → the query param is parsed/validated.
- `POST /messages?chat_id=…` with body `{"text":"x","disable_link_preview":"notabool"}` → `404 chat.not.found` → body field ignored.
- Our module therefore sends it in the query and never in the body.

### 3.3 Response (HTTP 200)

```json
{
  "message": {
    "recipient": { "chat_id": 123456789, "chat_type": "dialog", "user_id": 987654321 },
    "timestamp": 1793121323793,
    "body": {
      "mid": "mid.sample",
      "seq": 117513999076118510,
      "text": "MAX transport check\n\nDSH → MAX relay proof\n…",
      "markup": [
        { "from": 0,  "length": 19, "type": "strong" },
        { "from": 43, "length": 6,  "type": "emphasized" },
        { "from": 51, "length": 11, "type": "monospaced" },
        { "from": 64, "length": 11, "type": "link", "url": "https://max.ru" }
      ]
    },
    "sender": { "user_id": 100000001, "name": "My Bot", "username": "your_bot", "is_bot": true }
  }
}
```

- `chat_type`: `dialog` | `chat` | `channel`.
- `body.text` is always the **plain** text — server-side markup is parsed out into `body.markup`
  (`MarkupElement {type, from, length, url?}`, types: `strong`, `emphasized`, `monospaced`,
  `strikethrough`, `underline`, `highlighted`, `quote`, `link`, `user_mention`, `heading`).
  The live send above proves `**bold**`, `*italic*`, `` `code` `` and `[text](url)` parse correctly.
- For a dialog, `recipient.user_id` reveals the peer's numeric user id (useful if you only have the
  dialog `chat_id`).

### 3.4 Error shape

Errors are JSON `{code, message}` with an HTTP 4xx/5xx status. Observed live:

| HTTP | code | message | Cause |
|---|---|---|---|
| 401 | `verify.token` | `Invalid access_token` | bad/rotated token |
| 404 | `chat.not.found` | `Chat not found` | unknown `chat_id` |
| 400 | `proto.payload` | `Unknown recipient` | neither `chat_id` nor `user_id` |
| 400 | `proto.payload` | `Can't deserialize body` | invalid `format` / body shape |
| 400 | `proto.payload` | `Failed to convert value: '…'` | invalid query param value |
| 404 | `method.not.found` | `method not found` | removed method (e.g. `GET /chats` list) |
| 429 | (varies) | rate limited, `Retry-After` header | >2 msg/sec per chat |

The docs list only 200/401/500 for this method, but 400/404/429 are returned in practice
(observed). Treat any non-2xx as failure and surface `status` + `code` + `message`.

### 3.5 `notify`

Default `true`. `notify: false` = message is delivered but chat participants get no push
notification (useful for high-volume relay output). Channels must not send with `notify=false`.

---

## 4. Text formatting

Set `format: "markdown"` or `"html"` in the body. Omit `format` → text is literal (no parsing).
Source: [text-formatting docs](https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting/).

### 4.1 Markdown subset (MAX-flavored, based on CommonMark 0.29)

| Effect | Markdown |
|---|---|
| italic | `*emphasized*` or `_emphasized_` |
| bold | `**strong**` or `__strong__` |
| strikethrough | `~~strikethrough~~` |
| underline | `++underline++` |
| monospace (inline) | `` `code` `` — newlines inside are collapsed to spaces |
| monospace (block) | ```` ```code``` ```` — newlines inside are collapsed to spaces (degraded, not preserved) |
| highlight | `^^highlighted^^` |
| quote | `> quote` |
| heading | `# heading` … `###### heading` (all levels render the same) |
| inline link | `[text](https://example.com)` |
| user mention | `[Full Name](max://user/<user_id>)` — link text must be the user's real profile name |

### 4.2 HTML subset (same page)

| Effect | HTML |
|---|---|
| italic | `<i>`, `<em>` |
| bold | `<b>`, `<strong>` |
| strikethrough | `<del>`, `<s>` |
| underline | `<ins>`, `<u>` |
| monospace | `<pre>`, `<code>` |
| link | `<a href="…">text</a>` |
| highlight | `<mark>` |
| quote | `<blockquote>` |
| heading | `<h1>`…`<h6>` (all render identically) |
| user mention | `<a href="max://user/<id>">Full Name</a>` |

### 4.3 Not supported / caveats

- **Lists (ordered/unordered), horizontal rules and tables are not supported** in either format —
  not in the docs' syntax tables, and the official Agent Skill states the same (inferred from
  absence, not an explicit "unsupported" line). A `- item` line renders as literal text.
  For DSH output, render bullets as `• item` literal lines inside a `markdown` message (they show
  as plain text but look fine), or drop `format`.
- No escaping syntax is documented. If you interpolate untrusted content into a formatted message,
  characters like `*`, `_`, `~`, `+`, `^`, backtick, `<`, `>`, `[`, `]` can be parsed as markup —
  strip/escape them or send that
  content as a separate plain-text message.
- Fenced code blocks lose line breaks (collapsed to spaces). For agent code output prefer **plain
  text without `format`** (newlines preserved in the text field) or split code into its own
  message; do not rely on Markdown fences.
- Comments (`POST /messages/{id}/comments`) do not support links or mentions; messages do.
- Pick exactly one format per message; markdown syntax inside an `html` message (and vice versa) is
  not parsed.
- Formatting requires MAX clients iOS ≥3.1 / Android ≥2.20; deep links (mentions) iOS ≥2.7 /
  Android ≥2.9 **(secondary)**. Older clients show raw markup.
- Formatting markup characters count toward the 4000-character limit.

### 4.4 Formatting a DSH plugin should use

`markdown` with a conservative converter: `**bold**`, `*italic*`, `` `code` ``, `[links](…)`,
`>` quotes; convert lists to `• ` lines; **drop fenced-code markers and send code as plain text**;
strip stray markup characters from untrusted text. Keep messages ≤4000 chars and chunk.

---

## 5. Limits and chunking

| Limit | Value | Source |
|---|---|---|
| `text` length | **4000 characters** (raw string; every char incl. newlines and markup symbols; chars not bytes) | docs + schema `maxLength: 4000` |
| Send rate | **≤2 messages/second per dialog/chat/channel** | docs `POST /messages` |
| Global API rate | ~30 requests/second on `platform-api2.max.ru` | skill **(secondary, not verified)** |
| Long-poll interval | ≥300 ms between `GET /updates` calls | skill **(secondary)** |
| `attachments` | ≤12 image+video per message; `file` combinable only with 1 keyboard | schema/docs |
| Buttons | ≤7 per row, ≤30 rows, ≤210 total | docs |

- JS `String.length` counts UTF-16 code units, so an astral emoji counts as 2 while MAX counts
  characters (code points). Using JS length is **conservative** — you may chunk slightly early,
  never overshoot.
- The server rejects >4000 chars; it does not auto-split. `send.mjs` refuses to send and tells you
  to chunk (`MaxApiError.code === 'text.too_long'`), or chunks automatically with `chunk: true`.
- `splitText(text, limit = 4000)` (exported):
  - prefers the **last** `\n\n` that fits, then `\n`, then ` `, keeping the separator at the end of
    the chunk, so each message ends on a boundary and the next starts with content;
  - falls back to a hard cut for unbroken text;
  - never splits a UTF-16 surrogate pair (emoji intact; `limit` must be ≥2);
  - lossless: `chunks.join('') === text`;
  - Markdown constructs can still be split across chunks — if exact formatting matters, pre-split
    rich text yourself; chunks are independent messages.
- Rate limiting: the module serialises sends per target (`minIntervalMs`, default 500 ms →
  2/sec). `chunk: true` sends several messages and the built-in spacing keeps it under 2/sec.
- `429` handling: honour `Retry-After` (seconds or HTTP-date), cap the wait (`maxRetryDelayMs`,
  default 30 s), retry up to `maxRetries` (default 3). `Retry-After` is exposed on the thrown
  `MaxApiError.retryAfterMs` when retries are exhausted.
- Long messages alternative: there is no documented "text as file" fallback; split client-side.

---

## 6. Pairing: discovering `chat_id` / `user_id`

`chat_id` is the identifier the bot needs for `POST /messages`. There is **no** way to enumerate
chats: `GET /chats` (list) was removed in June 2026; the docs say to use `POST /subscriptions` /
`GET /updates` events instead ([getting chat id](https://dev.max.ru/docs-api/use-cases/getting-chat-id/)).
`GET /chats/{chatId}` (single chat) still exists (live-verified, §11.6) and returns
`dialog_with_user` for dialogs — useful for recovering `user_id` once you have `chat_id`.

### 6.1 Long polling: `GET /updates`

| Param | Type | Notes |
|---|---|---|
| `timeout` | int 0–90, default 30 | server-side long-poll wait in seconds |
| `limit` | int 1–1000, default 100 | max updates per response |
| `marker` | int64 \| null | position: omit/null → only the **latest** update; otherwise return updates after `marker` |
| `types` | string[] | comma-separated list of `update_type`s to receive (`explode: false` in schema) |

Response: `{ "updates": [Update, …], "marker": <int64> }`.

**Marker semantics** (docs, translated):
- Every update has a sequence number; the response `marker` points to the **next expected** update.
- Passing a `marker` marks all updates before it as **read**.
- If `marker` is omitted/null you get **only the latest update** — not the backlog.
- Updates are **consumed once**: polling with marker advances the cursor; another client polling
  the same bot token competes for the same queue and can consume events your pairing helper wanted.
  Run exactly one poller per bot token.
- Long polling is **dev/test only**: rate- and retention-limited, not for production. An active
  webhook subscription disables long polling for that bot (docs: "При активной подписке Long
  Polling не работает"). Keep ≥300 ms between polls **(secondary)**.

### 6.2 Relevant update types

`update_type` values: `bot_added`, `bot_started`, `bot_stopped`, `bot_removed`, `chat_title_changed`,
`dialog_cleared`, `dialog_muted`, `dialog_unmuted`, `dialog_removed`, `message_callback`,
`message_created`, `message_edited`, `message_removed`, `comment_created`, `comment_edited`,
`comment_removed`, `user_added`, `user_removed`, `bot_admin_permissions_changed` (Oct 2026,
webhook-only). Fields for pairing:

| update_type | Key fields |
|---|---|
| `bot_started` | `chat_id` (dialog id), `user` (full `User`: `user_id`, `first_name`, `last_name`, `username`, `is_bot`), `payload` (deeplink `start=` data, nullable, ≤512), `user_locale`, `timestamp` |
| `message_created` | base `chat_id`/`timestamp` + `message` (full `Message`: `sender`, `recipient`, `body{mid,seq,text,markup}`), `user_locale` (dialogs only) |
| `user_added` | `chat_id`, `user` (the user who was added), `inviter_id`, `is_channel`, `timestamp` (bot must be admin with `read_all_messages`) |
| `bot_added` | `chat_id`, `user` (who added the bot), `is_channel` |
| `bot_removed` / `dialog_removed` | `chat_id` — delete the stored chat id |

`bot_started` is emitted when the user presses **Start** in the bot dialog; it is the standard way
to learn both `chat_id` (the dialog) and `user_id` (the human) without any prior state.

### 6.3 Pairing helper recipe for the DSH plugin

```js
// Only works while no webhook subscription is active for this bot token.
// Ask the user to press Start AFTER the first poll starts, then wait.
import { createMaxClient, maskToken } from './send.mjs';

const max = createMaxClient({ token: process.env.MAX_BOT_TOKEN });
let marker; // persist per bot if you want to avoid re-reading

export async function pairOnce({ timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // First poll deliberately without marker = latest update only; keep looping with the marker
  // to receive new events as they arrive (do not rely on a backlog).
  while (Date.now() < deadline) {
    const res = await max.getUpdates({ timeout: 30, limit: 100, marker });
    marker = res.marker ?? marker;
    for (const update of res.updates ?? []) {
      if (update.update_type === 'bot_started') {
        return { chatId: update.chat_id, userId: update.user?.user_id, user: update.user };
      }
      // Fallback: any message from the user also reveals chat_id + sender user_id
      if (update.update_type === 'message_created') {
        return {
          chatId: update.chat_id,
          userId: update.message?.sender?.user_id,
          user: update.message?.sender,
        };
      }
    }
  }
  return null;
}
```

Operational rules:
1. **Poll first, then ask the user to open the bot and press Start** (or send any message). The
   user-facing instruction: open `https://max.ru/<bot-username>` (here `https://max.ru/your_bot`),
   press **Start**.
2. There is no `bot_started` backlog: an event that was consumed earlier cannot be replayed.
   If the first poll returns nothing, ask the user to press Start again **while the helper polls**.
3. Since a `message_created` update also carries `chat_id` + `sender.user_id`, "send any message to
   the bot" is a reliable fallback if Start was missed.
4. Persist the discovered `chatId` (and optionally `userId`) in plugin config; fall back to
   `MAX_CHAT_ID` env var. The DSH deployment already has a known dialog (`123456789`), so pairing is
   a one-time bootstrap, not a per-run step.
5. Do not pair and run a webhook at the same time; an active subscription stops long polling.
6. For recovery when only `chat_id` is known: `GET /chats/{chatId}` returns
   `dialog_with_user.user_id` for dialogs (live sample in §11.6), and a successful
   `POST /messages?chat_id=…` response contains `message.recipient.user_id`.

---

## 7. Webhook alternative (production)

Docs: `POST /subscriptions`, `GET /subscriptions`, `DELETE /subscriptions?url=…`.
Body: `{ "url": "https://your-domain.com/webhook", "update_types": ["message_created","bot_started"], "secret": "…" }`.

Requirements (docs):

- HTTPS **only**, port **443** (do not put a port in the URL).
- Certificate from a trusted CA **or** a Минцифры-issued certificate; domain must match CN/SAN;
  server must present the full chain. **Since 2026-05-25 plain HTTP delivery and self-signed
  certificates are rejected outright** (hard requirement).
- Endpoint must answer `HTTP 200` within **30 s**; anything else is a failed delivery.
- Failed deliveries retry up to **10** times, exponential ×2.5 (60 s, 150 s, 375 s, …); if no
  success within **8 h** the bot is auto-unsubscribed from that URL (silent).
- If `secret` is set (5–256 chars, `[A-Za-z0-9_-]`), every request carries
  `X-Max-Bot-Api-Secret`; compare in constant time.
- Webhook and long polling are **mutually exclusive** per bot token; production must use webhook.

Implication for the DSH plugin: outbound-only text delivery only needs `POST /messages` (no webhook).
Webhook is required only if the plugin must **receive** messages (e.g. user replies to steer the
agent), and that needs a public HTTPS endpoint on 443 with a valid cert.

---

## 8. Dated changes and deprecations

| Date | Change |
|---|---|
| 2026-05-25 | Webhook over plain HTTP and self-signed TLS certs rejected (HTTPS + trusted CA / Минцифры required) |
| 2026-06 | `GET /chats` (list all chats) removed — no replacement enumeration API; use subscriptions/updates |
| 2026-07-19 | **`platform-api2.max.ru` mandatory**; old `platform-api.max.ru` deprecated (needs Минцифры root added to trust) |
| 2026-08 | Comments API added (posts in channels); `comment_*` update types |
| 2026-09-09 | `POST /chats/{chatId}/members` (add members) restricted |
| 2026-10 | `bot_admin_permissions_changed` update added (webhook only, not long polling); OpenAPI spec published; MAX Agent Skill released |
| — | Query-param token auth no longer supported; `User.name` field is obsolete (use `first_name`/`last_name`); `GET /chats` 404s with `method.not.found` |

Treat any date-bound fact here as expiring: re-check the
[changelog](https://dev.max.ru/docs-api/changelog-api/) before release.

---

## 9. Recommendations for the DSH MAX plugin

1. **Vendor `send.mjs` into the plugin package.** It is single-file, dependency-free Node ESM and
   embeds the official root CA. The POC copy lives at `scratch/max-poc/send.mjs` + `certs/`; copy it
   into the plugin repo (don't import from `scratch/`, which is a scratch area).
2. **Config** (plugin settings, env fallback):
   ```json
   {
     "tokenEnv": "MAX_BOT_TOKEN",
     "chatId": 123456789,
     "format": "markdown",
     "notify": true,
     "disableLinkPreview": true,
     "chunk": true,
     "timeoutMs": 15000
   }
   ```
   Resolve token as `config.token ?? process.env.MAX_BOT_TOKEN`; chatId as
   `config.chatId ?? Number(process.env.MAX_CHAT_ID)`; never log either (use `maskToken`).
3. **Send path:** `createMaxClient({ token })` once (reuse the client), then
   `sendMessage({ chatId, text, format, notify, disableLinkPreview, chunk: true })`.
   Check `res.message.body.mid` as the delivery id; treat absence as failure.
4. **Chunking:** agent output is often >4000 chars — always `chunk: true` (or `splitText` yourself).
   Avoid splitting inside fenced code: convert code fences to plain-text messages first, or send
   the long message without `format`.
5. **Formatting:** convert DSH markdown to the MAX subset (§4). Drop unsupported constructs
   (lists → `• ` lines, tables → plain lines, hr → blank line); escape stray markup chars from
   untrusted content; never mix html/markdown.
6. **Errors:** map `MaxApiError.status/code` and `MaxNetworkError.code` to plugin-facing errors;
   include the TLS hint for `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`; surface `retryAfterMs`.
   Retry only 429 (built in); do not auto-retry other POST failures (risk of duplicates).
7. **Rate:** one send per target per 500 ms is enforced inside the client; don't add parallel
   unbounded sends. For long relays, queue messages.
8. **Pairing UX:** settings page with a "Pair with MAX" action → asks the user to press Start while
   the plugin polls (`/updates`, 30 s timeout, marker loop) → stores `chatId`/`userId`. Provide
   manual `chatId` entry + `MAX_CHAT_ID` fallback for headless deployments.
9. **TLS:** rely on the embedded root; for CI/Docker add `NODE_EXTRA_CA_CERTS`; never disable
   verification. If MAX rotates the root before 2032, update `RUSSIAN_TRUSTED_ROOT_CA_PEM` and
   `certs/root.pem`.
10. **Production receive path:** if the plugin must read user messages, deploy a webhook on a public
    HTTPS:443 endpoint with a Минцифры-trusted cert (§7); keep long polling for local dev only.
11. **Health check:** `getMe()` is cheap and returns bot identity; use it to validate the token.

---

## 10. Module API reference (`scratch/max-poc/send.mjs`)

```js
import {
  createMaxClient, splitText, maskToken,
  MaxApiError, MaxNetworkError,
  MAX_API_BASE, MAX_TEXT_LIMIT, MAX_MESSAGES_PER_SECOND,
  RUSSIAN_TRUSTED_ROOT_CA_PEM, RUSSIAN_TRUSTED_ROOT_CA_SHA256,
} from './send.mjs';
```

`createMaxClient({ token, baseUrl = 'https://platform-api2.max.ru', ca, timeoutMs = 15000,
maxRetries = 3, maxRetryDelayMs = 30000, minIntervalMs = 500, logger })` returns:

| Member | Description |
|---|---|
| `sendMessage({ chatId?, userId?, text, format = 'markdown'\|'html', notify?, disableLinkPreview?, attachments?, chunk = false })` | Single send → raw `{message:{…}}` (plus non-enumerable `httpStatus`). With `chunk:true` and text >4000 → `{chunked:true, count, messages[], mids[]}`. Throws `MaxApiError`/`MaxNetworkError`. |
| `getMe()` | `GET /me` → `{user_id, first_name, username, is_bot, description?, avatar_url?}` |
| `getUpdates({ timeout = 30, limit = 100, marker?, types? })` | `GET /updates` → `{updates, marker}`; transport timeout automatically extends beyond the poll timeout |
| `splitText(text, limit = 4000)` | standalone exported chunker (§5) |
| `maskToken(token)` | `abcd…wxyz (84 chars)` for logs |
| `token`, `baseUrl`, `hostname`, `ca` | diagnostics (`token` is already masked) |

`MaxApiError` fields: `status`, `code`, `message`, `method`, `path`, `details`, `retryAfterMs`
(`toJSON()` ready for logs). `MaxNetworkError`: `code`, `message`, `method`, `path`, `cause`.
No error object contains the token.

---

## 11. Evidence (2026-10-27, live + offline)

1. **Cert chain:**
   - `openssl verify -CAfile certs/root.pem -untrusted certs/sub.pem certs/leaf.pem` → `certs/leaf.pem: OK`
   - `openssl verify -CAfile certs/ca-chain.pem certs/leaf.pem` → `OK`
   - `openssl x509 -in certs/leaf.pem -noout -checkhost platform-api2.max.ru` → `does match certificate`
   - `curl --cacert certs/root.pem https://platform-api2.max.ru/…` → `ssl_verify_result 0`
   - Node `https.request({ca, servername})` → `authorized true`, TLSv1.3.
2. **Bot identity:** `GET /me` → HTTP 200 `{"user_id":100000001,"first_name":"My Bot","username":"your_bot","is_bot":true}`.
3. **Real sends** through `send.mjs` to `chat_id=123456789` (token masked `f9LH…lYpJ`, 84 chars):
   - HTTP **200**, `mid.sample` (2026-10-27T17:13:14Z), recipient
     `{chat_type:"dialog", chat_id:123456789, user_id:987654321}`, round-trip 50 ms;
   - HTTP **200**, `mid.sample` (2026-10-27T17:15:23Z), sent with
     `disable_link_preview=true` as a **query param** (accepted by the server; HTTP 200).
4. **Markdown parse proof** (`GET /messages?chat_id=123456789&count=2`): `body.markup` =
   `strong[0,19]`, `emphasized[43,6]`, `monospaced[51,11]`, `link[64,11]{url:"https://max.ru"}`;
   `body.text` is the plain text. Constructs accepted as documented.
5. **`disable_link_preview` probes:**
   - query `…&disable_link_preview=notabool` → `400 proto.payload "Failed to convert value: 'notabool'"` (parsed/validated as query);
   - body `{"text":"x","disable_link_preview":"notabool"}` → `404 chat.not.found` (body field ignored);
   - no recipient → `400 proto.payload "Unknown recipient"`; bad `format` → `400 "Can't deserialize body"`.
6. **`GET /chats/123456789`** → 200 `{"chat_id":123456789,"type":"dialog","status":"active","participants_count":2,"dialog_with_user":{"user_id":987654321,"first_name":"My Bot","is_bot":false,…}}`
   (list form `GET /chats` is removed, single-chat form works).
7. **Pairing observation:** `GET /updates?timeout=0&limit=10` → `{"updates":[],"marker":55148}`;
   repeating with `marker=55148` → `{"updates":[],"marker":55148}`. No pending `bot_started` event
   existed during this session (the dialog was already established), so the `bot_started` payload
   is documented from the docs/schema rather than captured live.
8. **Error paths:** wrong token → `401 verify.token`; unknown chat id → `404 chat.not.found`;
   system CA store → `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` with the Russian-root hint.
9. **Offline test suite** `node tests.mjs`: **32 passed, 0 failed** — splitText invariants (length,
   lossless join, surrogate safety, boundaries, small limit), 429 `Retry-After` retry (two 429s
   then 200; exhausted 429 → `retryAfterMs=7000`), GET 5xx retry, API error mapping, token never in
   errors, TLS hint, chunked send (one POST per chunk, spacing), over-limit guard.

---

## 12. Sources

- API docs: [POST /messages](https://dev.max.ru/docs-api/methods/POST/messages/) ·
  [GET /updates](https://dev.max.ru/docs-api/methods/GET/updates/) ·
  [GET /me](https://dev.max.ru/docs-api/methods/GET/me/) ·
  [POST /subscriptions](https://dev.max.ru/docs-api/methods/POST/subscriptions/) ·
  [text formatting](https://dev.max.ru/docs-api/use-cases/sending-messages/text-formatting/) ·
  [getting chat_id](https://dev.max.ru/docs-api/use-cases/getting-chat-id/) ·
  [changelog](https://dev.max.ru/docs-api/changelog-api/) ·
  [Update object](https://dev.max.ru/docs-api/objects/Update/)
- OpenAPI schema: [max-messenger/api-schema](https://github.com/max-messenger/api-schema)
  (`schema.yaml`: `platform-api2.max.ru`, `disable_link_preview in: query`, `text maxLength 4000`,
  `GET /updates types style=form explode=false`, `NewMessageBody`, `BotStartedUpdate`).
- Official MAX Agent Skill: [max-messenger/max-agents-skill](https://github.com/max-messenger/max-agents-skill) —
  `references/tls-trust.md` (cert URLs/fingerprint, never disable verification),
  `references/formatting.md` (markdown/HTML subset, unsupported lists/tables),
  `references/bot-api.md` (endpoint table, query-vs-body params, limits), `references/webhooks-and-security.md`,
  `references/objects-and-updates.md`.
- Certificates: AIA `http://nuc-cdp.voskhod.ru/cdp/rootca_ssl_rsa2022.crt`,
  `http://nuc-cdp.digital.gov.ru/cdp/rootca_ssl_rsa2022.crt`;
  `https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt` (+ `.cer`);
  `https://www.gosuslugi.ru/crt`.

---

## 13. Risks / open items

- **No live `bot_started` capture** in this session (dialog pre-existed). The pairing helper code
  is docs/schema-based; validate once by pressing Start while `pairOnce()` runs.
- Global 30 rps and 300 ms polling interval are from the official skill, not restated in the method
  pages fetched — treat as guidance, keep well below them.
- Sending by `user_id` (instead of dialog `chat_id`) was not exercised live; documented as an
  option with `recipient.chat_id` in the response as the likely way to learn the dialog id.
- Long-poll retention window is not published; do not rely on backlogs.
- Root CA is valid until 2032-02-27, leaf until 2027-06-06, live Sub CA until 2029-07-19; any of
  these can rotate earlier — re-run §2.5/2.6 periodically.
- The POC lives under `scratch/`; vendor `send.mjs` + `certs/root.pem` into the plugin package
  before shipping.
