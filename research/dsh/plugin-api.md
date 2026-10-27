# Out-of-tree DSH cordis plugins — verified API & install guide

Target: **DeepSeek Harness `0.2.1-rc.4`** (`dsh` on PATH), Node **v24.19.0**, pnpm **12.15.0**,
`@deepseek-ai/cordis` **4.0.5**, `@deepseek-ai/cordis-plugin-loader` **1.0.6**, plain ESM, no build step.

Every claim below is tagged **[PROVEN]** (executed in this workspace, see
`scratch/dsh-poc/`) or **[INFERRED]** (read from the shipped source/dist, not executed).
The last section is an evidence index of every `file:line` cited.

Path aliases used in citations:

```
$DSH   = /usr/local/lib/nodejs/node-v24.19.0-linux-x64/lib/node_modules/@deepseek-ai/dsh
$PKGS  = $DSH/node_modules/@deepseek-ai
$HOME  = $DSH_HOME                 (live web profile: $HOME/profiles/web)
$WS    = /path/to/MaxBot               (this workspace)
```

---

## 0. TL;DR — the shape that works

A local plugin that observes sessions and reports the last assistant text is a **zero-dependency,
zero-import ESM package** whose module namespace *is* the cordis plugin object:

```
$WS/dsh-max-notify/
├─ package.json        # type:module, main:index.js, exports, dsh.bundle.patch
├─ cordis.patch.yml    # ONE insert row: id + name + config
├─ index.js            # export const name; export function apply(ctx, config)
├─ lib/*.mjs           # optional relative modules (transport, formatting)
└─ certs/              # optional data files, read via new URL('../certs/…', import.meta.url)
```

Verified sequence (what the Lead should do once the profile is writable):

```bash
# 1) install as a profile bundle (auto-enables it as a patch layer)
dsh plugin --profile web add /path/to/MaxBot/dsh-max-notify
#    or, equivalently, the explicit link spec used in the plugin's own comment:
dsh plugin --profile web add link:/path/to/MaxBot/dsh-max-notify

# 2) verify composition WITHOUT booting or model calls
dsh --profile web --dump-config | grep -A12 'max-notify'

# 3) restart the web server (package changes are not hot-applied by a running process)
#    then, after boot, the plugin's apply() runs once per process

# 4) optional cleanup if the local plugin is later removed
dsh plugin --profile web remove dsh-max-notify
```

For a **zero-dependency** plugin, default `link:` installation (pnpm symlink) is correct and needs
no network. Do **not** import `@deepseek-ai/*` packages from a `link:`-installed plugin: Node resolves
from the plugin's real path and that path has no `node_modules` — [PROVEN] failure
(`ERR_MODULE_NOT_FOUND`); see §2.5.

---

## 1. Proof summary

| Question | Answer | Status |
|---|---|---|
| Minimum package shape | ESM package, `type:"module"`, `main`/`exports`, no `dsh` fields required | [PROVEN] installed/booted |
| Bundle auto-install | `dsh` = `{"bundle":{"patch":"./cordis.patch.yml"}}` makes `dsh plugin add` append the package to `dsh.profile.bundles` | [PROVEN] |
| Entry convention | named `export const name`, `export function apply(ctx, config)`; `inject` / `Config` optional | [PROVEN] both PoC and Lead plugin |
| Is `@deepseek-ai/schemastery` Config required? | No. Without `Config`, raw row config reaches `apply`. A dependency-free `StandardSchemaV1` is enforced by cordis at runtime | [PROVEN] |
| Native (schemastery) Config | Works only if the plugin can resolve schemastery (`file:` install or own `node_modules`), not with `link:` | [PROVEN] both ways |
| Need `inject` to listen? | No. `session/event` is a cordis event; a plugin with no `inject` receives it | [PROVEN] |
| Dispatch semantics | post-commit, synchronous `emit`, fire-and-forget; listener errors contained/logged; scope-filtered by agent scope | [PROVEN] harness + source |
| Last assistant text per turn | Listen `assistant/message`, keep last non-empty `TextBlock`s, send once on matching `turn/end` | [PROVEN] harness |
| Subagent filtering | `session.header.origin === 'subagent'` or `delegationDepth > 0` | [PROVEN] harness |
| Session title | `ctx.get('sessionTitle')?.get(session)?.title` (`SessionTitleSnapshot`) | [PROVEN] harness with real title service |
| Install into `$HOME/profiles/web` | `dsh plugin --profile web add <abs path>` → dep `link:<abs>` + bundle entry; restart required | [PROVEN] on isolated profiles; live profile command is identical [INFERRED] |
| `--patch` arbitrary workspace path | Patch row `name: file:///abs/path/index.js` imports and applies without any install | [PROVEN] |
| Incompatible `engines.dsh` | `dsh plugin add` refuses before pnpm runs; `allow-version` grant then retry | [PROVEN] |
| Plugin load/config failure at boot | Warning `N entries did not activate` + boot continues (unless id ∈ fixed required list) | [PROVEN] |

---

## 2. Package shape and entry convention

### 2.1 Minimal `package.json`

```json
{
  "name": "dsh-max-notify",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

* `type: "module"` + `main`/`exports` are ordinary Node ESM conventions; the loader imports the
  package specifier and evaluates the namespace (`$PKGS/cordis-plugin-loader/lib/index.js:213-228`).
  Real dist packages use exactly this shape, e.g. `$PKGS/dsh-session-log-export/package.json:2-30`
  (`type/main/exports` + `files`).
* **`dsh` metadata is only for being a *profile bundle*.** The bundle contract is
  `"dsh": { "bundle": { "patch": <file> | [<files>] } }` — read by
  `$PKGS/dsh-app-boot/lib/index.js:517-531` (`bundlePatchFiles`) and validated at profile load
  (`:1023-1028`); patch files are loaded relative to the bundle package directory.
  It is **not** needed to *load* a plugin; it is needed for `dsh plugin add` to auto-enable it as a
  layer (§7).
* No `engines` or DSH `peerDependencies` are required. If present, they are checked — see §2.4.
* `files`/`description`/`license` are packaging niceties only. Locale/icon metadata
  (`$PKGS/dsh-app-boot/lib/index.js:2216-2249` `readPluginMeta`) is optional UI decoration.
* A **plain plugin package** (no `dsh.bundle`) installs as an ordinary dependency and is *not*
  auto-mounted; you then add a row to the profile's `cordis.patch.yml` (§7.5). `dsh plugin add`
  prints `… declares no dsh.bundle — installed as a plain dependency, not a profile layer`
  (`$PKGS/dsh-plugin-manager/lib/types/operations.js:108-113`) [PROVEN].

### 2.2 Entry shapes accepted by cordis

`$PKGS/cordis/src/registry.ts:92-137` defines the accepted plugin shapes:

```ts
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string
    Config?: StandardSchemaV1<any, T>       // optional config validator
    inject?: Inject                          // optional required services
    provide?: string | string[]
    intercept?: Dict<boolean>
  }
  export interface Function<T> extends Base<T> { (ctx: Context, config: T): any }
  export interface Object<T>   extends Base<T> { apply(ctx: Context, config: T): any }
  export interface Constructor<T> extends Base<T> { new (ctx: Context, config: T): any }
}
```

An **ESM namespace with named `apply`/`name` exports is itself a valid `Plugin.Object`** because
`isApplicable` only checks `typeof object.apply === 'function'`
(`$PKGS/cordis/src/registry.ts:8-10`). The loader normalizes default exports first
(`$PKGS/cordis-plugin-loader/lib/index.js:200-208` `unwrapExports`: `exports.default ?? exports`,
then the plugin value is handed to `ctx.plugin` at `:460`).

So all of these load:

```js
// file plugin.js — what every real DSH dist package does (e.g. dsh-session-log-deepseek)
export const name = 'max-notify'
export const inject = []                       // optional
export function apply(ctx, config) { /* … */ }
```

```js
// or a default-exported function plugin
export default function apply(ctx, config) { /* … */ }
```

Real dist example: `$PKGS/dsh-session-log-deepseek/lib/index.js:13-20` declares
`name`, `inject = ["deepseekLlmApiExtensions","sessions"]`,
`Config = z.object({...})`, `apply(ctx, config)` at `:137`, exported together at `:195`.
`$PKGS/dsh-session-log-export/lib/index.js:494-506,565` is the same function-plugin pattern with
`Config = Schema.object(...)` and `apply(ctx, config = {})`.

> **No `.d.ts`, build step, or `"types"` field is needed** for a JS plugin. The dist packages are
> prebuilt TS output, but the runtime contract above is plain JS.

### 2.3 `inject` and loading order

* `inject` (array or `{service: config}` map, `$PKGS/cordis/src/registry.ts:19-38`) lists services the
  body needs. A fiber with unmet `inject` stays pending (`$PKGS/dsh-app-boot/lib/index.js:4383-4391`
  reports `pending (waiting for services: …)`).
* **Listening to events does not require `inject`.** `ctx.on` registers a listener on the plugin's own
  fiber (`$PKGS/cordis/src/events.ts:97`); dispatch resolves listeners from all contexts whose filters
  admit the dispatch receiver — no service involvement. Both PoC plugins have no `inject` and receive
  `session/event` [PROVEN]. Real DSH plugins also omit `inject` for pure event consumers; e.g.
  `$PKGS/dsh-session-log-deepseek` injects only because it calls `ctx.sessions.get(...)` and a
  request-extension registry.
* `inject = []` is valid and loads immediately (Lead's `$WS/dsh-max-notify/index.js:33`; mounted via
  `ctx.plugin` [PROVEN], fiber active).
* Service reads can be done *without* `inject` if guarded: `ctx.get('sessionTitle')?.get?.(session)`
  [PROVEN]. This is deliberately more robust than injecting: if `sessionTitle` is absent from a given
  profile, an injected plugin would stay pending, while a guarded read simply returns `undefined`.
* Listener lifetime = plugin fiber lifetime: unloading the plugin (disable row / profile recompose)
  removes its listeners automatically (`on()` returns a disposer owned by the fiber).

### 2.4 Version-compatibility gates (`engines.dsh` / DSH peers)

Evaluated without importing the plugin, by `evaluatePluginCompatibility`
(`$PKGS/dsh-app-boot/lib/index.js:252-336`):

1. If the manifest has **`engines.dsh`**, that range alone decides; `peerDependencies` are ignored
   (`:279-285`).
2. Otherwise every `peerDependencies` key equal to `@deepseek-ai/dsh` or starting with
   `@deepseek-ai/dsh-` must satisfy the running version; other peers are ignored (`:286-298`).
3. Ranges are matched with `semver.satisfies(runtime, range, { includePrerelease: true })`
   (`:276-278`). `workspace:^/~/*` are rewritten to the current runtime for peers only (`:292-296`).
4. A mismatch is reported as `{name, version, runtimeVersion, requirements}` and can be exempted by
   **exact** `name@version` → list of exact runtime versions in
   `$HOME/profiles/<profile>/compatibility.json` (`:311-326`, `:338-350`).

Consequences for an out-of-tree plugin:

* **Safest: declare neither `engines.dsh` nor DSH peers.** Then there are no requirements, always
  compatible. (`engines.node` is ignored by this check — the Lead plugin's `engines: {"node":">=20"}`
  is fine; verified by reading `:279-298` and by installing it [PROVEN].)
* If you do want a guard, prefer `"engines": {"dsh": ">=0.2.1-rc.4 <0.3.0"}`; do **not** copy dist
  packages' `"peerDependencies": {"@deepseek-ai/dsh-session": "0.2.1-rc.4"}` unless you accept an
  exact-version coupling that breaks on the next DSH bump.
* `dsh plugin add` checks the new direct dependencies **before pnpm runs** and rejects the whole
  command if incompatible (`$PKGS/dsh-plugin-manager/lib/types/operations.js:349-374`,
  `$DSH/lib/plugin-BiveYA7h.js:95`); a grant then retry succeeds [PROVEN, §7.6].
* At **startup**, a bundle whose own `dsh` requirements are unmet is **skipped with a stderr warning**
  and the rest of the profile still boots (`$PKGS/dsh-app-boot/lib/index.js:1007-1040`, warning text
  “skipping profile bundle …”) [PROVEN]. Non-bundle dependencies are not mounted at startup anyway.
* Exemptions are exact pairs; they do not survive upgrades (`README` of plugin-manager, and
  `setProfileVersionExemption` writing `compatibility.json`).

### 2.5 What a plugin module may import

Module resolution is a *two-anchor* scheme: profile `node_modules` first, then packages carried by
the dsh installation, applied through a Node resolver interception
(`$PKGS/dsh-app-boot/lib/index.js:483-503` docs, `:766-798` `createRuntimeResolution`,
`:1846-1917` `installRuntimeInterception`). It is installed before the config tree mounts
(`$DSH/lib/profile-boot-C14i-8IN.js:302-312` `PluginPackages`).

Practical rules [PROVEN by experiment]:

| Plugin install mode | `import './x.mjs'`, `node:` builtins | `import '@deepseek-ai/anything'` |
|---|---|---|
| default `link:` (pnpm symlink to `$WS/dsh-max-notify`) | ✅ resolves on disk | ❌ `ERR_MODULE_NOT_FOUND` — Node resolves from the plugin's real path, which has no `node_modules`; the interception does not cover that real path |
| explicit `file:` (`dsh plugin add file:/abs/path`) | ✅ copied into profile `node_modules` | ✅ resolves (package lives under the profile, inside the interception layer) — schemastery import + native schema status verified |
| no install, patch row `name: file:///abs/plugin/index.js` | ✅ | ❌ same reason as `link:` |

Recommendation for the MAX notifier: **stay zero-dependency**. Use relative modules inside the
package (`./lib/transport.mjs` — as the Lead plugin already does) and `node:` builtins only.
If a native schemastery `Config` is ever wanted, either install with `file:` or add a `node_modules`
to the plugin directory (e.g. `pnpm install` there); document that trade-off before doing it.

---

## 3. Config

### 3.1 `Config` is optional

Cordis applies a plugin's config validator only when the plugin exports `Config`:
`resolveConfig(runtime, config)` returns the raw config unchanged when `runtime.Config` is absent
(`$PKGS/cordis/src/fiber.ts:42-62`). Otherwise it calls
`runtime.Config['~standard'].validate(config)` and throws `ValidationError` on `issues` (`:50-61`).

Both paths were exercised [PROVEN]:

* **No `Config`** (`scratch/dsh-poc/hello-plugin/index.js`): the YAML row config arrived in `apply()`
  unchanged, manual validation normalized it, and the profile booted. `--dump-config-schema` reports
  the row as `"status": "absent"` (no schema, no error).
* **Dependency-free StandardSchemaV1** (`scratch/dsh-poc/config-plugin/index.js`): valid config is
  normalized by `validate()` and passed to `apply()`; invalid config throws `ValidationError` with
  the exact issue lines. In a real boot an invalid override row produced
  `ValidationError: invalid config: - tag must be …` in the startup warning and the plugin did not
  activate.

A plain object is enough for the StandardSchemaV1 contract:

```js
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-max-notify',
    validate(value) {
      // return { value: normalized } or { issues: [{ message, path }] }
    },
  },
}
```

Note the *tooling* trade-off [PROVEN]: `dsh --profile web --dump-config-schema` imports each row's
module and projects its schema, but only a **native Schemastery** schema is supported
(`$PKGS/dsh-app-boot/lib/index.js` config-schema collection). A plain `~standard` validator is
reported as `Config is not a native Schemastery schema` with `"status": "unsupported"` and makes that
command exit non-zero (it already exits non-zero on the stock web profile for four unrelated
“unrecognized Loader tree carrier” diagnostics). Runtime is unaffected.

### 3.2 Native Schemastery pattern (real dist)

```js
// $PKGS/dsh-session-log-deepseek/lib/index.js:13-20
import z from '@deepseek-ai/schemastery'
const name = 'session-log-deepseek'
const inject = ['deepseekLlmApiExtensions', 'sessions']
const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
})
export function apply(ctx, config) { /* … */ }
export { Config, apply, inject, name }   // :195
```

Same pattern in `$PKGS/dsh-session-log-export/lib/index.js:494-506` (`Schema.object`) and as a
service (`$PKGS/dsh-session-title/lib/index.js:201-206`: `static inject = ['sessions',
'sessionProjections']`, `static Config = z.object({...})`, service name `sessionTitle` at `:214`).
Schemastery implements StandardSchemaV1, so `~standard.validate` is the shared mechanism.

To make `import '@deepseek-ai/schemastery'` resolvable from a local plugin, see §2.5: use `file:`
install or give the plugin its own `node_modules`. `link:` + schemastery fails at boot with
`failed to import: ERR_MODULE_NOT_FOUND` [PROVEN].

### 3.3 Row config semantics

* A patch row's `config` **replaces** the whole config object of the targeted row, it does not merge
  (stated in `$PKGS/dsh-base/cordis.patch.yml:6-10` and `$DSH` config-schema `$comment` at
  `$PKGS/dsh-app-boot/lib/index.js:3207`). Put complete objects in overrides, or rely on defaults.
* Order: bundle layers in `dsh.profile.bundles` order → profile `cordis.patch.yml` → home
  `$DSH_HOME/cordis.patch.yml` → `--patch` overlays (`$DSH/lib/profile-boot-C14i-8IN.js:223-247`;
  home layer helper `:115`). Last write wins per row id.
* Rows are addressed by `id`; `--dump-config` labels each layer with a
  `# == <package-or-file>` comment, which is how you verify a plugin's row and config.
* Invalid config for a row whose id is not in the fixed required list does **not** abort the app:
  startup prints `dsh: warning: N entries did not activate` with the `ValidationError` and continues
  (`$PKGS/dsh-app-boot/lib/index.js:4464-4475`, required ids `:4270-4279`) [PROVEN]. Treat the
  warning as an error when validating a new plugin.

---

## 4. Subscribing to `session/event`

### 4.1 Exact signature

`$PKGS/dsh-session/lib/types/index.d.ts:26-70` augments the cordis Context:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { sessions: SessionStore }
  interface Events {
    'session/created'(this: Scoped<Session>, session: Session): void
    'session/disposed'(this: Scoped<Session>, session: Session): void
    /** Post-commit, fire-and-forget append feed. … @mode emit */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /** Awaited parallel durability checkpoint … @mode parallel */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
  }
}
```

Registration in JS:

```js
ctx.on('session/event', (session, event) => { /* session: live Session, event: SessionEvent */ })
ctx.on('session/disposed', (session) => { /* cleanup per-session state */ })
```

### 4.2 Dispatch semantics

* **Post-commit, synchronous, fire-and-forget.** `Session.commit()` resolves listeners *before* the
  log push (`collectSessionCallbacks` → `$PKGS/dsh-session/lib/index.js:1227-1229`), pushes the event
  (`:1590`), then invokes each listener synchronously with **per-listener containment**
  (`invokeContainedSessionObservers`, `:1231-1240`, called at `:1592`). A throwing or rejecting
  listener is logged (`session "<id>": session/event listener threw/rejected: …`) and never affects
  the append or other listeners.
* Therefore the listener runs **after** the event is committed but **before** `append()` returns to
  the producer; any I/O you do must be queued, not awaited by the producer (the event dispatch does
  not await returned promises).
* `session/event` fires for **every** appended event, including events appended by other plugins
  (proven in the harness, which appends directly) and for the agent loop's own appends.
* Seed/replay events never publish on `session/event` (`$PKGS/dsh-session/lib/types/index.d.ts:157`),
  so a restored session does not replay old turns into the listener.
* `--dump-config`/`--dump-config-schema` do not boot ⇒ no listeners run there.

### 4.3 Scope filtering (`this: Scoped<Session>`)

Dispatch passes a scope carrier as the event's `this`; cordis filters listeners by the carrier's
filter (`$PKGS/cordis/src/events.ts:169-173`: `hook.global || !filter || filter.call(thisArg, hook.ctx)`).
The scope filter admits untagged (root-level) listeners globally and tagged listeners only for
matching/ancestor scopes (`$PKGS/dsh-scope/lib/index.js:316-338` `scopeTarget`; docs
`$PKGS/dsh-scope/README.md:17-25`).

Implication: a plugin mounted at profile root (our case) has **no scope tag and receives every
session's events, including subagent child sessions**, hence the explicit
`origin`/`delegationDepth` filtering in §6. An agent-scoped plugin (mounted inside an agent context)
would only see sessions entered through that agent. Both PoC and Lead plugin are root-level and
received top-level and subagent sessions in the harness [PROVEN].

### 4.4 Async sends

Do not `await` network I/O in the listener. Pattern [PROVEN in skeleton]:

```js
ctx.on('session/event', (session, event) => {
  try { onEvent(session, event) } catch (error) { logger.warn('handler failed: %s', error) }
})
// and inside onEvent, when the turn finishes:
void sendQueue.then(() => client.sendMessage(...)).catch((error) => logger.warn(...))
```

The listener's own rejections are contained by the session store, but you lose context-specific
error reporting; keeping a serial chain also satisfies MAX's 2 msg/s limit (Lead plugin's
`createSendQueue`).

---

## 5. Event payloads and "last assistant text of a turn"

### 5.1 Envelope and relevant events

`SessionEvent` is a discriminated union over `type` with `{seq, time, data}` +
surface metadata (`$PKGS/dsh-session/lib/types/types.d.ts:490-513`). Relevant members
(`:256-339`):

```ts
'turn/start': { turn: number }
'turn/end':   { turn: number; reason: TurnEndReason }
'step/start': { turn: number; step: number }
'step/end':   { turn: number; step: number }
'assistant/message': {
  turn: number
  step: number
  message: AssistantMessage
  stream: AssistantStreamRecord[]
  usage?: TokenUsage
  interrupted?: true          // cancelled mid-stream: delivered text prefix
}
'tool/call': { turn, step, callId, name, arguments }     // arguments: raw JSON string
'tool/result': { turn, step, message, error?, meta? }
'user/message': UserMessage
```

`TurnEndReason` is a merge-extensible sum (`:163-211`): `completed`, `aborted`
(`{kind:'aborted', reason: {kind:'user'|'parent'|'hook'|'disposed'|'legacy'}}`), `blocked`,
`error` (`{kind:'error', error: LlmFailure}`), `max-tokens`, `interrupted` (crash-orphaned turn
closed during resume/first read; the loop never emits it live), `forked` (fork-seed closer only).

`AssistantMessage.content` is `ContentBlock[]`; visible text is `{type:'text', text:string}`
(`$PKGS/dsh-llm/lib/types/types.d.ts:46-49`). Other blocks (`reasoning`, `image`, `file`,
`tool-call`, `tool-addition`, `tool-removal`) are not visible assistant text. Assistant messages
carry `role:'assistant'` and `source:{kind:'model', provider, model}` (`message.d.ts:148-151`,
`createMessage` at `:196-198`).

#### 5.1.1 Envelope gotchas (`{type, seq, time, data}`)

Every dispatched event is one frozen `SessionEvent` object (`$PKGS/dsh-session/lib/types/types.d.ts:490-513`):

```ts
{
  type: SessionEventType        // discriminant; switch on this
  seq:  SessionSeq              // BrandedNumber — a real number at runtime
  time: number                  // epoch ms
  data: SessionEventMap[type]   // the per-type payload (no `turn`/`step` at top level!)
  surfaceOp?: 'append' | {op:'replace',startSeq,endSeq}   // ONLY on surface-producing events
  sourceEventSeqs?: SessionSeq[]                          // ONLY on surface events (never assistant/message)
  ignorable?: true              // unknown plugin records only; core events are required
}
```

Gotchas that bite listeners:

* **`data` is the payload, not the event.** `event.type === 'turn/end'` ⇒ `event.data.turn`,
  `event.data.reason.kind`; `assistant/message` ⇒ `event.data.turn/step/message`. There is no
  `event.turn`.
* `surfaceOp` is `'append' | {op:'replace',…}` on message events; it is absent on `turn/*`,
  `step/*`, `assistant/attempt`, `request/*` and similar log-only events. Do not assume it exists.
* `seq`/`sourceEventSeqs` carry branded types in TS only — plain numbers at runtime.
* Events are deeply frozen; never mutate `event` or `event.data`.
* Seed/replay events never publish on `session/event`
  (`$PKGS/dsh-session/lib/types/index.d.ts:151-158`), so history is not re-delivered after a restart.
* Unknown future event types appear only when marked `ignorable`: keep a `default:` branch and never
  throw for unrecognized `event.type` (session store contains listener errors, but the warning is noise).
* `assistant/message.stream` is mandatory and may be `[]` (trimmed logs/aborts); do not rely on it.

### 5.2 Reference collection algorithm (proven)

Per session id, keep a frame `{turn, text, interrupted}`:

1. `turn/start` → reset frame to that turn, empty text (also clears stale state after missed events).
2. `assistant/message` → if `data.turn > frame.turn`, reset; extract `content` `text` blocks, join;
   if non-empty, **replace** frame text (last non-empty step wins) and remember
   `data.interrupted === true`.
3. `turn/end` → take frame for `data.turn`, delete it, then:
   * skip subagent sessions unless configured otherwise (§6.2);
   * skip reasons configured as `skipReasons` (default `aborted`,`error`,`interrupted`,`forked`);
   * skip if no collected text (covers tool-only/aborted-before-text turns);
   * deliver **exactly once**, then clear state.
4. `session/disposed` → delete the session frame.

Full working code: `$WS/scratch/dsh-poc/hello-plugin/index.js` (PoC) and
`$WS/scratch/dsh-poc/skeleton/index.js` (reference skeleton); the Lead plugin already implements the
same policy at `$WS/dsh-max-notify/index.js:229-266` [PROVEN end-to-end with a fake transport].

### 5.3 Edge cases

| Case | Observed/documented behaviour | Handling |
|---|---|---|
| Multiple steps in one turn | one `assistant/message` per step with same `turn`, increasing `step` | keep the **last non-empty** text; harness yielded `"step two final text"` [PROVEN] |
| Tool-only step | `assistant/message` exists but text extraction returns `''` | ignore empty text; do not overwrite the last real text [PROVEN] |
| Turn with no assistant message (aborted before streaming) | no `assistant/message` | frame text empty → nothing sent [PROVEN] |
| Interrupted turn (cancel mid-stream) | `assistant/message` with `interrupted:true` carrying the delivered prefix; `turn/end` reason `aborted` | configurable: deliver with `interrupted` flag (harness: `{"reason":"aborted","interrupted":true,"text":"partial prefix"}` [PROVEN]) or skip via `skipReasons` |
| Subagent child turn | same events, header `origin:'subagent'`, `delegationDepth>0` | filtered by plugin (default skip), or include explicitly [PROVEN] |
| Resume of crash-orphaned turn | `turn/end` with reason `interrupted` may be appended during restore, not live cancellation | include `interrupted` in `skipReasons` to avoid notifying stale history; seed events themselves never publish |
| Forked session | new session, `parentSession` set, `origin` absent | treat as top-level (notify) unless product policy says otherwise |
| Session title unavailable at first turn | title service fills a deterministic fallback on the first user message (deferred) | guard `ctx.get('sessionTitle')`; fall back to `header.cwd` [PROVEN title present at turn/end] |
| Multiple turns / long session | frame keyed per session and reset per turn | memory bounded by live sessions; delete on `session/disposed` |
| Plugin reload/mid-turn install | in-memory frames lost | acceptable: next `turn/start` re-initializes |

---

## 6. Session identity, filtering, title, cwd

### 6.1 `Session.header` — `$PKGS/dsh-session/lib/types/types.d.ts:59-96`

```ts
interface SessionHeader {
  version: 4
  id: SessionId              // branded string; also session.id getter
  createdAt: number          // epoch ms
  cwd?: string               // absolute working directory at creation (if any)
  parentSession?: SessionId  // fork lineage
  isSeeded: boolean          // fork-inherited prefix present
  origin?: 'subagent'        // coarse classification of a subagent child
  delegationDepth?: number   // absent/0 = top level; parent depth + 1 for children
  agentPreset?: string
}
```

`Session.id` is a getter over the header (`index.d.ts:150-154`); `String(session.id)` (or
`session.header.id`) is the stable map key. `Session.header` is detached and deep-frozen
(`index.d.ts:142-150`).

### 6.2 Filtering subagent child sessions

```js
const header = session.header
const isSubagent = header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
if (isSubagent && !config.includeSubagents) return
```

`origin` is presentation metadata, `delegationDepth` the durable recursion depth; checking both
covers children created by different producers [PROVEN in harness: child text suppressed by default,
delivered when `includeSubagents:true`].

Do **not** use `parentSession` for this: forked sessions also carry it but are user-visible top-level
sessions.

### 6.3 Session title

Registered by the `@deepseek-ai/dsh-session-title` plugin (always present in `dsh-base`):

* Service name `sessionTitle` (`$PKGS/dsh-session-title/lib/index.js:214`), type
  `SessionTitleService` (`$PKGS/dsh-session-title/lib/types/index.d.ts:114-129`).
* `get(session): SessionTitleSnapshot | undefined` — latest `session/title` fold
  (`lib/index.js:281-283`).
* Snapshot: `{title, messageSeqs, source, eventSeq, updatedAt}`
  (`lib/types/types.d.ts:38-52`); source is `fallback` | `provider` | `user`.
* Host projection alternative: `ctx.get('sessionProjections')?.stateOf(session, 'title')` → `string |
  null` (projection `title` registered by the title plugin, `lib/index.js:235`);
  `stateOf` at `$PKGS/dsh-session-projection/lib/index.js:126`.

Recommended guarded read (no `inject`, works when the title plugin is present, harmless when not):

```js
const title = ctx.get('sessionTitle')?.get?.(session)?.title ?? null
```

[PROVEN] harness with the real `SessionStore` + `SessionProjectionRegistry` + `SessionTitleService`:
at `turn/end` the payload contained `"title":"deploy the staging cluster please"`. Fallback title
generation is deferred work (`lib/index.js:377-400`), so for the very first turn query the title at
`turn/end` time; if it is still absent fall back to `header.cwd`.

### 6.4 Workspace / cwd and other facts

`header.cwd` is the absolute creation cwd. For the notification header that is usually enough; the
Web workspace selection is a UI concern and not part of the session header. `createdAt` gives the
turn timestamp; `String(header.parentSession)` identifies fork lineage.

---

## 7. Installing a local plugin into the live web profile

Live profile: `$DSH_HOME/profiles/web` (read-only in this workspace; the commands below were proven
against byte-identical copies under `$WS/scratch/dsh-poc/home*/profiles/*`).

### 7.1 Recommended: install as a bundle

```bash
dsh plugin --profile web add /path/to/MaxBot/dsh-max-notify
# equivalent explicit form (pnpm link protocol; this is what the plugin's own comment suggests):
dsh plugin --profile web add link:/path/to/MaxBot/dsh-max-notify
```

What `dsh plugin` does (`$DSH/lib/bin.js:115-127`; `$DSH/lib/plugin-BiveYA7h.js:63-99`;
`$PKGS/dsh-plugin-manager/lib/types/operations.js:591-601,96-121`):

1. Opens `$DSH_HOME/profiles/web` (initializes it from the shipped `web` template if absent).
2. Anchors `./relative` specs against the invoking cwd; absolute paths and `link:`/`file:` specs pass
   through (`anchorPathSpec`, `operations.js:71-77`).
3. Runs `pnpm add` **with cwd = profile dir** (`operations.js:296-...` execa at `:382-390`).
4. On success reads the profile manifest and, for every **new** dependency that declares
   `dsh.bundle.patch`, appends the package name to `dsh.profile.bundles` and pre-validates the patch
   files; a dependency without `dsh.bundle` only warns (`operations.js:96-121`).
5. Writes `.plugin-manager/logs/operation-*/pnpm.log` diagnostics.

[PROVEN] resulting profile state for the Lead plugin (isolated home, exact copy of the operation):

```json
// $DSH_HOME/profiles/web/package.json  (after)
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-max-notify": "link:/path/to/MaxBot/dsh-max-notify"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-inspector-profile",
        "dsh-max-notify"          // ← appended
      ]
    }
  }
}
```

```
$DSH_HOME/profiles/web/node_modules/dsh-max-notify -> /path/to/MaxBot/dsh-max-notify   (symlink)
$DSH_HOME/profiles/web/pnpm-lock.yaml             (importer dependency added)
$DSH_HOME/profiles/web/cordis.patch.yml           (UNCHANGED: bundles package their own rows)
```

The **`name` in the patch row** (`dsh-max-notify`) is the module specifier the Loader imports. Bare
names resolve through the profile runtime resolution, which maps the profile's `node_modules`
first. The row's module is the same package that carries the bundle: one package can be both the
layer and the plugin.

No edit of `cordis.patch.yml` is required for a bundle. Use it only for overrides:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml (optional)
- id: max-notify
  config:
    includeSubagents: false
    maxChars: 3800
    # config REPLACES the row's whole config object; repeat every key you need.
```

(or the machine-wide `$DSH_HOME/cordis.patch.yml`, which applies to every profile —
`$DSH/lib/profile-boot-C14i-8IN.js:227-229`, home layer at `:115`).

### 7.1.1 Bundle patch vs profile patch row, and what actually reloads

Two different YAML layers, both composed by the Loader; do not confuse them:

| Mechanism | File | When used | Reload behaviour |
|---|---|---|---|
| **Bundle patch** (what `dsh-max-notify` uses) | `<package>/cordis.patch.yml`, declared by `"dsh":{"bundle":{"patch":…}}` | The package is listed in `dsh.profile.bundles`; `dsh plugin add` appends it automatically | Applied on every boot as a layer in bundle order (after `@deepseek-ai/dsh-base`/`dsh-web-app`). Package install/update of a **running** process needs a restart [INFERRED: plugin-manager README — the CLI is a separate process and cannot publish into the live resolver]. |
| **Profile patch row** | `$DSH_HOME/profiles/web/cordis.patch.yml` (user layer, applied after all bundle layers; `--dump-config` labels it by path) | (a) mount a **plain (non-bundle) dependency** with `- insert: [{id,name,config}]`; (b) override a bundle row by id — `- id: max-notify` + `config:` (replaces the whole config), `disabled: true`, or `- insert:` new rows | Edited while the app runs, the profile's HMR picks up patch-file changes and recomposes; a CLI/package change still needs a restart [INFERRED from HMR docs in the plugin-manager README; not measured here]. |

Insert vs override syntax in any patch layer

```yaml
- insert:                      # add rows at the end of the tree
    - id: max-notify          # stable id; later layers address it by id
      name: dsh-max-notify    # module specifier: bare package, relative to the layer file, or cordis:group
      config: { … }           # validated by the plugin's Config when it exports one
- id: max-notify              # override an existing row (from a bundle or an earlier layer)
  config: { … }               # REPLACES the row's whole config object
- id: max-notify
  disabled: true              # toggle without uninstalling
```

Who writes what:

* **`dsh plugin --profile web add <local path>`** (CLI): runs pnpm in the profile and reconciles
  `dsh.profile.bundles` for new bundles (`operations.js:96-121,591-601`). Disk only → restart.
* **Web Plugin Manager / `plugin_manager` tool** (live service): same disk changes **plus** live
  recomposition/publication of the runtime resolution and bundle selection through HMR; installs
  through it can apply to the running process (`$PKGS/dsh-plugin-manager/README.md:98-104`). It can
  also toggle rows (`disabled`) and select/deselect bundles. [INFERRED — not exercised here.]
* **Raw `pnpm add link:…` in `$DSH_HOME/profiles/web`**: installs the dependency but does *not*
  update `dsh.profile.bundles`, so the bundle patch is never applied. Don't; use `dsh plugin`.
* Removing: `dsh plugin --profile web remove dsh-max-notify` (pnpm remove; also fix
  `dsh.profile.bundles` — the manager does it for selected bundles, a raw pnpm remove does not).

Live state observed for this project (read after the Lead's install) [PROVEN]:

```json
// $DSH_HOME/profiles/web/package.json
{ "dependencies": { "dsh-max-notify": "link:/path/to/MaxBot/dsh-max-notify" },
  "dsh": { "profile": { "bundles": [ … , "dsh-max-notify" ] } } }
// node_modules/dsh-max-notify -> /path/to/MaxBot/dsh-max-notify
// compatibility.json: absent (no dsh requirements declared; none needed)
// cordis.patch.yml: unchanged — the bundle's own cordis.patch.yml supplies the row
```

### 7.2 Restart and verification

Package installation is done by a *separate* `dsh plugin` process; a running web server does not
pick it up. Restart the process that serves `http://127.0.0.1:3480` after installing
[INFERRED from plugin-manager docs: a running profile's package changes need a restart unless done
through the live manager/HMR; HMR covers config files, not new packages].

Verification without model API spend:

```bash
# 1) composition (no boot, no imports)
dsh --profile web --dump-config | grep -A12 'max-notify'

# 2) row/plugin metadata import check (imports modules, does not apply them; stock web profile
#    already exits 1 on four unrelated tree-carrier diagnostics)
dsh --profile web --dump-config-schema >/tmp/schema.json 2>/tmp/schema.err
grep -i 'max-notify' /tmp/schema.err /tmp/schema.json

# 3) after restart, check startup stderr/logs for:
#    "warning: N entries did not activate"  → plugin failed to import/config-validate
#    and for the plugin's own first log line (e.g. "forwarding each agent reply to MAX …")
```

A boot without a task is the cheapest full-load smoke test (it mounts the whole tree, then exits):

```bash
# safe on an isolated DSH_HOME; on the live home prefer --dump-config and the web server's logs
DSH_HOME=/path/to/MaxBot/scratch/dsh-poc/home dsh --profile web --help   # no server binds (web-app patch :13)
DSH_HOME=/path/to/MaxBot/scratch/dsh-poc/home dsh --profile headless     # loads tree, exits "a task is required"
```

### 7.3 Alternatives

1. **`file:` copy install** — same command with `file:/path/to/MaxBot/dsh-max-notify`; pnpm copies the
   package into the profile's `node_modules` instead of symlinking. Use only if the plugin needs to
   import installation-scoped packages (schemastery) or must be immune to workspace edits.
   Observed: profile manifest `"dsh-max-notify": "file:/path/to/MaxBot/…"`, real directory under the
   profile, schema dump `status:"schema"` for a schemastery Config.
2. **Plain dependency + manual row** — install a package without `dsh.bundle` (warning), then add a
   row to `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: max-notify
         name: dsh-max-notify
         config: { … }
   ```

   [PROVEN on a plain package: row composed and module applied on boot.]
3. **`--patch` overlay with a file URL** (no installation at all) — useful for experiments:

   ```yaml
   # /path/to/MaxBot/scratch/dsh-poc/overlay.patch.yml
   - insert:
       - id: max-notify
         name: file:///path/to/MaxBot/dsh-max-notify/index.js
         config: { … }
   ```

   ```bash
   dsh --profile web --patch /path/to/MaxBot/scratch/dsh-poc/overlay.patch.yml
   ```

   [PROVEN] the module imported and `apply()` ran with no profile dependency. Caveats: the row
   persists only for invocations that pass `--patch`; a plain absolute path (not `file://`) is not a
   valid ESM specifier; and the plugin's relative imports still need an on-disk path (they work for
   `file:` URLs pointing at the package).
4. **Raw `pnpm add link:…` in the profile directory** — installs the dependency but does **not**
   reconcile `dsh.profile.bundles`; you must edit that list yourself. Prefer `dsh plugin`.

### 7.4 Compatibility gates / exemptions (CLI)

[PROVEN] incompatible `engines.dsh` refusal and remedy:

```text
$ dsh plugin --profile web add /path/to/MaxBot/scratch/dsh-poc/bad-plugin
dsh: installation rejected: Plugin dsh-max-notify-bad-poc@0.1.0 is incompatible with dsh 0.2.1-rc.4:
requirements {"engines.dsh":"^0.1.0"}. …
dsh: nothing was installed.
dsh: to accept the risk, run: dsh plugin --profile web allow-version dsh-max-notify-bad-poc@0.1.0 \
      --dsh-version 0.2.1-rc.4 --accept-risk

$ dsh plugin --profile web allow-version dsh-max-notify-bad-poc@0.1.0 --dsh-version 0.2.1-rc.4 --accept-risk
dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. …
dsh: allowed dsh-max-notify-bad-poc@0.1.0 for DSH 0.2.1-rc.4
# → compatibility.json: { "dsh-max-notify-bad-poc@0.1.0": ["0.2.1-rc.4"] }
$ dsh plugin --profile web add /path/to/MaxBot/scratch/dsh-poc/bad-plugin   # now succeeds
```

Retrieval/revocation: `dsh plugin --profile web version-exemptions`,
`… revoke-version <name@version> --dsh-version <dsh>` (`$DSH/lib/plugin-BiveYA7h.js:14-61`);
after revocation a boot skips that bundle with the warning shown above [PROVEN].

### 7.5 Update / removal

* **Update a `link:` plugin**: edit files, then restart the server. Re-running `dsh plugin add`
  for a link to the same path is a pnpm no-op (`Already up to date`); a `file:` copy needs a reinstall.
* **Remove**: `dsh plugin --profile web remove dsh-max-notify` (pnpm remove; until removed the
  manager may also deselect the bundle). Manual removal requires editing both `dependencies` and
  `dsh.profile.bundles`.
* Do not hand-edit `cordis.yml` in the profile: it is rewritten to `[]` on every boot/dump — all
  composition lives in the patch layers (`$DSH/lib/profile-boot-C14i-8IN.js:201-221`).

### 7.6 Environment / secrets

The launcher loads `.env` from the **invoking cwd** and then from `$DSH_HOME` before boot
(`$PKGS/dsh-app-boot/lib/index.js:3726-3750` `loadLayeredEnv`, `:3602` `loadEnv`); inherited
environment wins, then project `.env`, then home `.env`. So a plugin can read
`process.env.MAX_BOT_TOKEN` as long as the web server was started from a directory whose `.env`
defines it (or the variable is exported / placed in `$DSH_HOME/.env`). The Lead plugin additionally
supports `botTokenFile: /path/to/MaxBot/.env` in its row config, which is independent of cwd
[PROVEN: the file was read during an isolated headless boot; no network calls were made].

---

## 8. What exactly was proven in `scratch/dsh-poc/`

### 8.1 Artifacts

| Path | Purpose |
|---|---|
| `hello-plugin/` | **no `Config`** variant: manual validation, zero imports; collect last assistant text, filter subagents, `logFile`/stderr sink |
| `config-plugin/` | dependency-free `~standard` **Config** variant (valid/invalid validation) |
| `schema-plugin/` | native **schemastery** `Config` + installation-package import (used to prove `link:` failure vs `file:` success) |
| `plain-plugin/` | package **without** `dsh.bundle`, for plain-dependency + manual-row install |
| `bad-plugin/` | `engines.dsh:"^0.1.0"` for the compatibility/exemption path |
| `skeleton/` | clean reference skeleton of the final plugin (what the Lead can copy/merge) |
| `harness.mjs` | real `@deepseek-ai/cordis` + real `@deepseek-ai/dsh-session` session-event harness (all edge cases + title service) |
| `harness-skeleton.mjs` | same harness against the skeleton |
| `harness-lead-plugin.mjs` | integration check of `$WS/dsh-max-notify` with a fake MAX client (no network) |
| `home*/profiles/*` | isolated `DSH_HOME` profiles where installs/boots were executed |
| `boot-*.out|err`, `schema-dump*.json|err` | captured evidence |

### 8.2 Isolated install → compose → boot (commands and results)

```bash
export DSH_HOME=/path/to/MaxBot/scratch/dsh-poc/home
dsh plugin --profile web add /path/to/MaxBot/scratch/dsh-poc/hello-plugin
dsh --profile web --dump-config
# → "# == dsh-max-notify-poc" layer followed by
#   - id: max-notify-poc
#     name: dsh-max-notify-poc
#     config: {tag: POC, includeSubagents: false, skipReasons: [aborted, error]}

dsh --profile headless add ...     # plugins installed into the headless profile too
dsh --profile headless             # full tree mounts, then exits: "a task is required"
# stderr: "[dsh-max-notify-poc] module imported" + "[dsh-max-notify-poc] apply config={…}" for every plugin
```

Also proven in isolation:

* `--dump-config-schema` imports each row's module; `status:"absent"` for the no-Config plugin,
  `"unsupported"` for a plain `~standard` Config (plus one diagnostic), `"schema"` for a native
  schemastery Config when installed with `file:`.
* Installing the **real Lead plugin** with `link:/path/to/MaxBot/dsh-max-notify` produced the expected
  profile manifest + symlink, and a clean headless boot.
* Invalid config override on an existing row ⇒ `ValidationError` listed in
  `warning: 1/2 entries did not activate`; the tree still boots.
* `--patch` overlay with `name: file:///…/plain-plugin/index.js` ⇒ same module imported and applied
  without installation.

### 8.3 Runtime hooking without booting and without model calls

`node scratch/dsh-poc/harness.mjs` imports the installed `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-session` **by absolute path** (the exact copies DSH boots), mounts the real
`SessionStore` service, mounts the plugin module, then appends real events with
`llm.createMessage(...)`. It exercises the real `Session.commit` publication path, not a hand-made
emitter. Observed:

```
sessions service: true
notifications written: 2
{"turn":1,"reason":"completed","interrupted":false,"origin":null,"text":"first assistant answer"}
{"turn":1,"reason":"completed","interrupted":false,"origin":null,"text":"step two final text"}
second mount notifications: 2
{"turn":1,"reason":"aborted","interrupted":true,"origin":null,"text":"partial prefix"}
{"turn":1,"reason":"completed","interrupted":false,"origin":"subagent","text":"subagent text delivered when included"}
title-service notification: {"…","title":"deploy the staging cluster please","turn":1,"reason":"completed","text":"done"}
config-plugin accepted valid config: true
config-plugin rejected invalid config: ValidationError - invalid config:
```

`node scratch/dsh-poc/harness-lead-plugin.mjs` (fake `createClient` seam, no network):

```
captured MAX sends: 1
{"chatId":"123456789","format":"markdown","text":"**DSH** · 20:15:28 · MaxBot\n\nlead plugin reply one"}
```

⇒ the Lead plugin's hook path, formatting and subagent suppression work against the real session
store; only the HTTP send is stubbed.

### 8.4 Reproduce

```bash
cd /path/to/MaxBot
node scratch/dsh-poc/harness.mjs
node scratch/dsh-poc/harness-skeleton.mjs
node scratch/dsh-poc/harness-lead-plugin.mjs

export DSH_HOME=/path/to/MaxBot/scratch/dsh-poc/home6   # already contains the skeleton plugin
dsh --profile headless --dump-config | grep -A10 max-notify
dsh --profile headless                              # expect: "a task is required" + no plugin warnings
```

---

## 9. Risks & gotchas

1. **Silent-ish failures.** A row that fails to import or fails config validation only produces
   `dsh: warning: N entries did not activate` and the app keeps running; only the fixed id list
   (`$PKGS/dsh-app-boot/lib/index.js:4270-4279`) is fatal. Always check the web server's stderr after
   the first restart.
2. **`link:` + bare `@deepseek-ai/*` imports = boot failure** (`ERR_MODULE_NOT_FOUND`, plugin row
   inactive). Stay zero-dependency or install with `file:`.
3. **Restart required.** `dsh plugin add` is a separate process; nothing is activated in the running
   web server. Restart, then verify.
4. **Config replacement, not merge.** An override row must restate every key it needs.
5. **`session.id` is a branded string**; use it (or `header.id`) directly as a Map key, don't assume
   a numeric id. `session.header` is deeply frozen.
6. **Turn-end may fire for reasons other than "the model answered"**: `aborted`, `error`, `blocked`,
   `max-tokens`, plus restore-only `interrupted`/`forked`. Decide the policy explicitly (the Lead
   plugin currently sends for every reason; consider adding `skipReasons` for `interrupted`/`forked`).
7. **Do not await I/O in the listener**; it runs synchronously inside `Session.append`. Queue sends.
8. **MAX limits**: ≤4000 chars and ≤2 msg/s — chunk and serialize (Lead plugin already does).
9. **Version exemptions are exact pairs**; a DSH or plugin upgrade invalidates them.
10. **`--dump-config-schema` is not a boot test** and stock web already exits 1 on unrelated
    diagnostics; don't treat its exit code as plugin health.
11. **Profile `cordis.yml` is rewritten** (`[]`) on every boot/dump; keep composition in patches.
12. **`.env` is loaded from the launch cwd and `$DSH_HOME`**; a server started elsewhere will not see
    `/path/to/MaxBot/.env` unless the plugin reads an absolute `botTokenFile` (Lead plugin does).
13. **Native schemastery names in `dump-config-schema`** only appear when the module can resolve
    schemastery; otherwise the row is `unsupported`/`error`.
14. **`ctx.plugin(plugin, config, third)`**: the third argument is cordis' `getOuterStack`, not a
    plugin dependency bag. Extra args are `ctx.plugin(plugin, config, …)`-typed but only
    `(ctx, config)` reach the body through the registry; call the plugin body directly from a wrapper
    if you need test seams (as the harness does).

---

## 10. Evidence index

| Topic | File:line |
|---|---|
| Plugin shapes / metadata | `$PKGS/cordis/src/registry.ts:9-11,92-137,19-38,185` |
| Config validation at runtime | `$PKGS/cordis/src/fiber.ts:42-62` |
| `ctx.on` event registration | `$PKGS/cordis/src/events.ts:90-106,112-120` |
| Scope-filtered dispatch | `$PKGS/cordis/src/events.ts:169-173`; `$PKGS/dsh-scope/lib/index.js:316-338`; `$PKGS/dsh-scope/README.md:17-25` |
| Loader import + export unwrap | `$PKGS/cordis-plugin-loader/lib/index.js:200-208,213-228,460`; README `:14-30` |
| Include baseUrl (relative row names) | `$PKGS/cordis-plugin-include/src/index.ts:147,181-188` |
| `session/*` events + Scoped typing | `$PKGS/dsh-session/lib/types/index.d.ts:26-70,150-154,157` |
| Dispatch/containment implementation | `$PKGS/dsh-session/lib/index.js:1227-1240,1579-1599` |
| SessionHeader fields | `$PKGS/dsh-session/lib/types/types.d.ts:59-96` |
| Turn-end reasons | `$PKGS/dsh-session/lib/types/types.d.ts:163-211` |
| Event map (`turn/*`, `assistant/*`, `tool/*`) | `$PKGS/dsh-session/lib/types/types.d.ts:256-339,490-513` |
| Message / TextBlock types | `$PKGS/dsh-llm/lib/types/types.d.ts:46-49`; `$PKGS/dsh-llm/lib/types/message.d.ts:123-151,196-198` |
| Config patterns (dist) | `$PKGS/dsh-session-log-deepseek/lib/index.js:13-20,137,195`; `$PKGS/dsh-session-log-export/lib/index.js:494-506,565`; `$PKGS/dsh-session-title/lib/index.js:201-206,214` |
| Title service + snapshot | `$PKGS/dsh-session-title/lib/types/index.d.ts:114-129`; `$PKGS/dsh-session-title/lib/types/types.d.ts:38-52`; `lib/index.js:235,281-283,377-400` |
| Title projection `stateOf` | `$PKGS/dsh-session-projection/lib/index.js:126` |
| Bundle manifest contract | `$PKGS/dsh-app-boot/lib/index.js:491-497,517-531,1015-1050`; `$PKGS/dsh-base/package.json:31-34` |
| Compatibility rules | `$PKGS/dsh-app-boot/lib/index.js:252-336` |
| Profile compat file / exemptions | `$PKGS/dsh-app-boot/lib/index.js:338-350,372,421` |
| Profile templates / init | `$PKGS/dsh-app-boot/lib/index.js:551-570,611` |
| Layer composition / home patch | `$DSH/lib/profile-boot-C14i-8IN.js:115,201-247,255-327` |
| `dsh` launcher flags / `plugin` command | `$DSH/lib/bin.js:105-127,239-248` |
| CLI plugin operation | `$DSH/lib/plugin-BiveYA7h.js:14-61,63-99` |
| pnpm arg anchoring / reconcile / preflight | `$PKGS/dsh-plugin-manager/lib/types/operations.js:71-77,96-121,349-374,591-601` |
| `dsh.bundle` auto-enable warning | `$PKGS/dsh-plugin-manager/lib/types/operations.js:108-113` |
| Startup audit / required ids | `$PKGS/dsh-app-boot/lib/index.js:4270-4279,4448-4475` |
| Runtime resolution / interception | `$PKGS/dsh-app-boot/lib/index.js:483-503,766-798,1846-1917` |
| `.env` layering | `$PKGS/dsh-app-boot/lib/index.js:3602,3726-3750` |
| `--dump-config` / `--dump-config-schema` | `$DSH/lib/dump-config-CWs_HdOc.js:24-61`; `$DSH/lib/dump-config-schema-D_PxIzpe.js:22-39` |
| web `--help` binds no server | `$PKGS/dsh-web-app/cordis.patch.yml:13` |
| Config replaces whole object | `$PKGS/dsh-base/cordis.patch.yml:6-10`; `$PKGS/dsh-app-boot/lib/index.js:3207` |
| Plugin row schema (id/name/config/group/inject) | `$PKGS/cordis-plugin-loader/README.md:22-30`; bundle patch examples `$PKGS/dsh-experimental-badge-skill-bundle/cordis.patch.yml:1-4` |
| `ctx.logger(name)` callable | `$PKGS/cordis/src/context.ts:27-28` |

### PoC evidence files

* `scratch/dsh-poc/harness.mjs`, `harness-skeleton.mjs`, `harness-lead-plugin.mjs`
* `scratch/dsh-poc/hello-plugin/`, `config-plugin/`, `schema-plugin/`, `plain-plugin/`, `bad-plugin/`, `skeleton/`
* `scratch/dsh-poc/home*/profiles/*/package.json` (post-install manifests)
* `scratch/dsh-poc/schema-dump*.json`, `boot-*.err`, `harness-out*.jsonl`
