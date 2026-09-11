# @openchamber/sdk — developer API reference

What third-party guest authors import and call. Source of truth: `[packages/sdk/src](https://github.com/openchamber/openchamber/tree/sdk/packages/sdk/src)`. Longer guides live in the [product docs](https://github.com/openchamber/openchamber/tree/sdk/packages/docs/content/docs) (`sdk.mdx`, `sdk/host.mdx`, `sdk/ui.mdx`) and in `[GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_SERVICES.md)` for local services.

**Package:** `@openchamber/sdk`  
**API version:** manifest `apiVersion: 1`, wire envelope `v: 1`  
**Runtimes that load guests:** web and desktop. VS Code and mobile mark the catalog `unsupported`.

Two entrypoints:


| Import                | Role                                                           |
| --------------------- | -------------------------------------------------------------- |
| `@openchamber/sdk`    | Manifest parse, iframe protocol, `connectHost`                 |
| `@openchamber/sdk/ui` | Optional DOM drawing kit (buttons, fields, lists, popups) |


---

## Ship checklist (install fails without these)

`inspectGuestPackage` (Settings → Extensions install) checks the folder or zip **on disk**. Parse alone is not enough. Packaged OpenChamber and `openchamber serve` run on Node and will **not** compile TypeScript. `oc-dev` on Bun may compile `panel/main.ts` when serving; install still wants the built `.js` files present.


| Must exist                                                                       | When                                            | Failure code       |
| -------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------ |
| Semver `version` on `package.json` (`1.0.0`)                                     | Always on install                               | `invalid-manifest` |
| `panel.entry` HTML file                                                          | Always                                          | `invalid-manifest` |
| Every relative `<script src="…">` `.js` from that HTML (usually `panel/main.js`) | Always                                          | `missing-build`    |
| File named by `panel.icon`                                                       | Only when icon ends in `.svg` (e.g. `icon.svg`) | `invalid-manifest` |
| File named by `service.entry` (e.g. `service/main.js`)                               | When `contributes.service` is set                 | `missing-build`    |


**Icon.** Remixicon kebab name (`window`) needs no file. A package SVG path (`icon.svg`) must sit inside the package. URLs and absolute paths fail parse as `invalid-panel-icon`. Missing SVG on disk fails install as `invalid-manifest`.

**Panel JS.** Classic IIFE. The iframe cannot load ESM. Point `panel/index.html` at `./main.js` and ship that file.

**Service JS.** Same rule as the panel: `service.entry` must be compiled JS already in the package. `.ts` alone fails as `missing-build`.

Bundle with the SDK helper from the guest folder (`--node` targets Node for the service):

```bash
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
```

Zip or folder for install should include at least: `package.json`, `panel/index.html`, `panel/main.js`, and any declared `icon.svg` / `service/main.js`. Skip `node_modules` and TypeScript sources. Zip and git installs land in `{dataDir}/extensions/{id}`. See also `[GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_SERVICES.md)`.

---

## 1. `connectHost` — iframe client

```ts
import { connectHost, HostRequestError } from '@openchamber/sdk';

const host = connectHost();
```

Throws `HOST_UNAVAILABLE` when there is no `window`. Outside an iframe (`parent === self`) it still returns a client, but every call rejects with `HOST_UNAVAILABLE`. Call `dispose()` on teardown; in-flight RPCs then reject as `HOST_UNAVAILABLE`. Silent host for 20s → `HOST_TIMEOUT`.

### 1.1 Subscriptions (host pushes)

Each returns an unsubscribe function. Late subscribers get the last known value (replay from `ready` or the last dedicated push).


| Method                         | Payload                 | Notes                                                        |
| ------------------------------ | ----------------------- | ------------------------------------------------------------ |
| `onReady(listener)`            | `HostReadyContext`      | First snapshot and later full refreshes                      |
| `onDirectory(listener)`        | `string                 | null`                                                        |
| `onSession(listener)`          | `SessionSnapshot        | null`                                                        |
| `onSessionLifecycle(listener)` | `SessionLifecycleEvent` | `{ sessionId, phase }` — `started` / `completed` / `failure` |
| `onConnection(listener)`       | `GuestConnection`       | `{ connected, account }`                                     |
| `onSettings(listener)`         | `GuestSettings`         | Declared integration fields only (`Record<string, string>`)  |
| `onItem(listener)`             | `GuestItem              | null`                                                        | The item this surface was opened for: the chip (`AttachIssueRequest`), a message (`GuestMessageItem`), or a session (`GuestSessionItem`); `null` from the rail icon or + menu |
| `onResolve(handler)`           | `{ command, args }` → `Promise<AttachIssueRequest \| null>` | Answers a `contributes.commands` slash command. Return the chip to attach, `null` for nothing (the user sees a short notice), or throw (the message reaches the user). One handler at a time |


`HostReadyContext`


| Field          | Type                     | Meaning                                                                                  |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `theme.mode`   | `'light'                 | 'dark'`                                                                                  |
| `theme.tokens` | surfaces, text, interaction states, `primary`, status colors, `font`, `mono`, `radius` | Pass to `applyHostReady` before mounting UI |
| `locale`       | `string`                 | Host language tag                                                                        |
| `directory`    | `string                  | null`                                                                                    |
| `session`      | snapshot or `null`       | Title falls back to `id`. `busy` is live status. `model` is `providerID/id` when present |
| `surface`      | `'panel'                 | 'dialog'`                                                                                |
| `connection`   | `{ connected, account }` | Integration link state                                                                   |
| `settings`     | `Record<string, string>` | Declared keys only                                                                       |
| `item`         | `GuestItem               | null`                                                                                    | Set when the user clicked this guest's chip on the composer, or ran one of this guest's `contributes.actions`. Narrow with `isGuestMessageItem` / `isGuestSessionItem` / `isGuestAttachItem` |


`GuestItem` is `AttachIssueRequest | GuestMessageItem | GuestSessionItem`:

```ts
type GuestMessageItem = {
  kind: 'message';
  action: string;          // the action id from the manifest
  sessionId: string;
  sessionTitle: string;
  directory: string;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;            // what the Markdown export renders for that message, at most 200 000 chars
};

type GuestSessionItem = {
  kind: 'session';
  action: string;
  sessionId: string;
  sessionTitle: string;
  directory: string;
  messages?: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: number }>; // oldest first; only with payload ["messages"] and the conversation grant
  truncated?: boolean;     // the oldest messages were dropped so the item stays under 2 000 000 serialized chars
};
```


Access tokens never appear in `ready` or in request results.

**Session lifecycle phases:** live `busy` / `retry` → `started`; `idle` → `completed`; unknown status → `failure` (not abort/crash).

### 1.2 Actions (RPC)


| Method            | Arguments                         | Returns                        | Behavior                                                                              |
| ----------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `toast`           | `{ kind: 'info'                   | 'success'                      | 'error', message }`                                                                   |
| `openUrl`         | `url: string`                     | `Promise<void>`                | Open URL in the host                                                                  |
| `openSurface`     | `surfaceId: string`               | `Promise<void>`                | Switch host chrome to that surface                                                    |
| `writeClipboard`  | `text: string`                    | `Promise<void>`                | Copy in the host (1–32000 chars)                                                      |
| `compose`         | `{ text, mode?: 'append'          | 'replace' }`                   | `Promise<void>`                                                                       |
| `attach`          | `AttachIssueRequest`              | `Promise<void>`                | Composer chip (exclusive with GitHub/Linear)                                          |
| `startSession`    | `StartSessionRequest`             | `Promise<{ sessionId, sent }>` | Create session (+ optional worktree), write snapshot. `text` can become first message |
| `prompt`          | `{ text, send?: boolean }`        | `Promise<{ sent }>`            | Current session: omit/`false` = replace-compose; `send: true` = send                  |
| `sessionLink`     | `AttachIssueRequest`              | `Promise<void>`                | Write snapshot on **current** session. Does not create one                            |
| `close`           | —                                 | `Promise<void>`                | Dismiss attach dialog. No-op on the rail                                              |
| `oauthStart`      | —                                 | `Promise<void>`                | Open provider authorize URL (or first-party Linear)                                   |
| `oauthDisconnect` | —                                 | `Promise<void>`                | Drop guest tokens / Linear connection                                                 |
| `request`         | `{ method, path, query?, body? }` | `Promise<{ status, body }>`    | HTTPS call on declared `apiOrigin`. Host attaches auth                                |
| `serviceRequest`    | same shape as `request`           | `Promise<{ status, body }>`    | Proxy to this guest's local service on loopback                                         |
| `serviceStatus`     | —                                 | `Promise<{ status }>`          | `stopped`                                                                             |
| `readFile`        | `path: string`                    | `Promise<{ content }>`         | UTF-8 text. Relative = inside the open project (`files`); `/…` or `~/…` = declared `filesystem` pattern |
| `writeFile`       | `path: string, content: string`   | `Promise<{ written: true }>`   | Atomic (temp + rename), creates parent folders. Same path rules                        |
| `listDir`         | `path: string`                    | `Promise<{ entries }>`         | `{ name, kind: 'file' \| 'directory' \| 'other' }[]`, sorted, capped at 2 000. Same path rules |
| `stat`            | `path: string`                    | `Promise<{ kind, size, mtime }>` | `kind` adds `'missing'`; a missing path is not an error. Same path rules              |
| `setBadge`        | `count: number \| null`          | `Promise<void>`                | Number on this guest's rail icon, 0–999 (clamped); `null` clears. Opening the panel clears it too. In memory only |
| `dispose`         | —                                 | `void`                         | Remove listener, reject pending RPCs                                                  |


`AttachIssueRequest`

```ts
{
  providerId: string;  // usually panel id
  id: string;          // guest identifier, not a GitHub number
  title: string;
  url: string;
  text?: string;       // optional model context
  kind?: 'issue' | 'pull';  // default issue
  author?: string;
  branches?: { head: string; base: string };  // for pull
  data?: JsonValue;    // opaque, comes back as ready.item.data; not sent to the model
}
```

`data` is plain JSON (`string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }`). It is stored with the chip and the session snapshot and returned unchanged when the user clicks the chip. `JSON.stringify(data).length` must stay within `GUEST_ATTACH_DATA_MAX` (16 000): `clampAttachRequest` silently drops a larger `data`, and the host schema refuses the whole message if it arrives over the limit.

`StartSessionRequest` = attach fields + optional `worktree?: boolean`.

`sent` **values** (`startSession` / `prompt`): `sent` | `no-model` | `skipped` | `failed`. After `no-model` / `failed` on `startSession`, the session still exists.

**File path rules** (`readFile` / `writeFile` / `listDir` / `stat`): a relative path (`README.md`, `src/x.ts`, `.`) is joined to the project that is open when the call runs and needs the `files` capability; no open project is `NO_DIRECTORY`. A path starting with `/` or `~/` is outside the project, must match one of the package's `contributes.filesystem` globs, and needs the `filesystem` capability. Any `..` segment, a backslash, or a symlink that leads out of the allowed tree is `BAD_PATH`. The host compares canonical (realpath) paths, so `/tmp/x` on macOS is checked as `/private/tmp/x` and a pattern's literal prefix is canonicalized the same way. Content over 2 000 000 characters is `FILE_TOO_LARGE` in both directions; an OS permission refusal is `DENIED`.

`request` **/** `serviceRequest` **rules:** `method` is `GET` | `POST` | `PUT` | `PATCH` | `DELETE`. `path` must start with `/`, no scheme, stay on the declared origin (cloud API or service loopback). Guest parses `body` as JSON when needed.

### 1.3 Error codes (`HostRequestError.code`)


| Code               | When                                          |
| ------------------ | --------------------------------------------- |
| `HOST_UNAVAILABLE` | No window, not in iframe, or disposed         |
| `HOST_TIMEOUT`     | No answer for 20s                             |
| `HOST_REJECTED`    | Host refusal, or unknown wire code            |
| `DISCONNECTED`     | No token / Linear connection                  |
| `DISABLED`         | Extension paused in Settings                  |
| `BAD_PATH`         | Path left origin or malformed                 |
| `NO_INTEGRATION`   | Manifest has no `integration`                 |
| `NO_SESSION`       | `prompt` / `sessionLink` with no open session |
| `SESSION_BUSY`     | `prompt({ send: true })` while busy           |
| `NO_SERVICE`         | No service, not approved, or not running        |
| `NOT_GRANTED`      | The user has not approved this capability     |
| `NO_DIRECTORY`     | Relative file path with no open project       |
| `NOT_FOUND`        | `readFile` / `listDir` on a path that does not exist |
| `FILE_TOO_LARGE`   | File or content over 2 000 000 characters     |
| `DENIED`           | The operating system refused the file access  |
| `SERVICE_FAILED`     | Service crashed or never became ready           |


### 1.4 Field limits (client clamps before send)


| Field                            | Max       |
| -------------------------------- | --------- |
| Clipboard text                   | 32 000    |
| Compose / prompt / attach `text` | 16 000    |
| Attach `data` (serialized)       | 16 000    |
| Attach `id`                      | 128       |
| Attach `title`                   | 200       |
| Attach `url`                     | 2 000     |
| Attach `author`                  | 80        |
| Branch name                      | 200       |
| Request path                     | 2 000     |
| Request body                     | 64 000    |
| Request response                 | 256 000   |
| Request timeout                  | 20 000 ms |
| `resolve` answer (host waits)    | 20 000 ms |
| Badge count                      | 999       |
| Message item `text`              | 200 000   |
| Session item (serialized)        | 2 000 000 |
| File path                        | 1 024     |
| File content (read and write)    | 2 000 000 |
| `listDir` entries                | 2 000     |


---

## 2. `@openchamber/sdk/ui` — drawing kit

DOM building blocks that use host tokens. They do **not** call the provider or `connectHost`. You compose the screen and wire callbacks yourself.

Always call theme first:

```ts
import { applyHostReady, mountList } from '@openchamber/sdk/ui';

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  // then mount…
});
```

Every mount returns `{ update(partial), dispose() }`. `update` merges the fields you pass and repaints; `dispose` removes the node and its listeners.

### 2.1 Theme


| Function                      | Role                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `applyHostReady(ctx, root)`   | Writes theme tokens + `data-oc-surface` / `data-oc-theme` |
| `applyHostTheme(theme, root)` | Tokens only                                               |


### 2.2 Mount functions


| Function                          | Use for                    | Main props                                                                                                  |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `mountButton(root, props)`        | Button                     | `label`, `onClick`, `variant?` (`default` / `secondary` / `outline` / `ghost` / `destructive`), `size?` (`default` / `sm` / `xs`), `disabled?`, `loading?` |
| `mountTextField(root, props)`     | Input or textarea          | `value`, `onChange`, `label?`, `placeholder?`, `password?`, `multiline?`, `rows?`, `disabled?`, `error?`, `helper?`, `mono?` |
| `mountSearchField(root, props)`   | Search box                 | `value`, `onChange`, `placeholder?`, `label?`, `autofocus?`                                                  |
| `mountSelect(root, props)`        | Dropdown                   | `value`, `options: { id, label, hint? }[]`, `onChange`, `label?`, `placeholder?`, `searchable?`, `searchPlaceholder?`, `disabled?` |
| `mountCheckbox` / `mountSwitch`   | Checkbox / toggle          | `label`, `checked`, `onChange`, `disabled?`, `description?`                                                  |
| `mountTabs(root, props)`          | Pill tabs                  | `items: { id, label, count? }[]`, `activeId`, `onChange`, `trackBackground?`                                 |
| `mountBadge(root, props)`         | Pill                       | `label`, `tone?` (`neutral` / `primary` / `success` / `warning` / `error` / `info`)                          |
| `mountList(root, props)`          | Keyboard list              | `items: { id, title, subtitle?, leading?, meta?, badge?, disabled? }[]`, `onSelect`, `selectedId?`, `emptyText?`, `ariaLabel?` |
| `mountEmpty(root, props)`         | Empty / disconnected state | `title`, `body?`, `action?: { label, onClick }`                                                              |
| `mountSpinner(root, props?)`      | Loading ring               | `size?` (`sm` / `default`), `label?`                                                                         |
| `mountBanner(root, props)`        | Notice                     | `tone` (`info` / `success` / `warning` / `error`), `title`, `body?`, `action?`                               |
| `mountSeparator(root, props?)`    | Divider                    | `label?`                                                                                                     |
| `mountProgress(root, props)`      | Progress bar               | `value` (0..100), `tone?`, `label?`                                                                          |
| `mountMenu(root, props)`          | Action dropdown            | `label`, `items: ({ id, label, destructive?, disabled? } \| { separator: true })[]`, `onSelect`, `variant?`, `size?` |
| `mountText(root, props)`          | Provider text              | `text`, `onOpenUrl?`                                                                                         |


### 2.3 Helpers


| Function                                   | Role                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `filterSelectOptions(options, query)`      | Same case-insensitive label / id match `mountSelect` uses                    |
| `moveListSelection(items, currentId, key)` | Keyboard step (`next` / `previous` / `first` / `last`) that skips disabled items |
| `navigationKey(event, axis?)`              | Maps arrows, Home, End, Ctrl+N / Ctrl+P to a step                            |
| `splitTextMedia(text)`                     | Splits text into runs, `![alt](https://…)` images, and `[label](https://…)` links |


`mountText` keeps everything as text except `http(s)` markdown images and links. A sandboxed iframe cannot open a link itself, so pass `onOpenUrl` and forward the URL to `host.openUrl`.

---

## 3. Manifest and host-side parse (`@openchamber/sdk`)

Used by the OpenChamber host and by tools that validate packages. Guests rarely call these from the iframe.

### 3.1 Manifest block (inside `package.json`)

```json
{
  "name": "@acme/hello-panel",
  "version": "1.0.0",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=1.22.0" },
    "contributes": {
      "panel": {
        "id": "acme-hello",
        "name": "Hello",
        "icon": "window",
        "entry": "panel/index.html"
      },
      "attach": "dialog",
      "capabilities": ["prompt", "sessions", "files"],
      "filesystem": ["~/.config/opencode/opencode.json", "/tmp/acme/**"],
      "actions": [
        { "id": "create-task", "label": "Create task from message", "icon": "add-circle", "where": "message", "roles": ["assistant"] },
        { "id": "summarize", "label": "Summarize session", "where": "session", "payload": ["messages"] }
      ],
      "commands": [{ "name": "task", "description": "Attach a task by id" }],
      "integration": { /* oauth | token | host */ },
      "service": { /* optional local process */ }
    }
  }
}
```


| Key                   | Rules                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`             | Semver required on install (`1.0.0`)                                                                                                                                                 |
| `apiVersion`          | Must be `1`                                                                                                                                                                          |
| `engines.openchamber` | Optional. Only `1.22.0` or `>=1.22.0`. Older host → `host-too-old`                                                                                                                   |
| `panel.id`            | kebab-case                                                                                                                                                                           |
| `panel.icon`          | Remixicon kebab name (`window`) **or** package `.svg` path. Remixicon needs no file. An `.svg` path must exist on disk or install fails (`invalid-manifest`). No URLs/absolute paths |
| `panel.entry`         | Path inside package. No `..`, absolute, or URL. HTML must exist; its relative `.js` scripts must exist (`missing-build` if not)                                                      |
| `attach`              | `true` / `"panel"` → + menu opens rail; `"dialog"` → host window; omit/`false` → off menus. Object form `{ "mode": "panel" \| "dialog", "entry"?: "panel/attach.html" }`: `entry` (dialog only, same path rules as `panel.entry`, must exist with built scripts) is the page the dialog loads instead of `panel.entry` |
| `capabilities`        | Optional list of `prompt`, `sessions`, `files`. `files` is read **and** write inside the open project. Approved once at install                                                     |
| `actions`             | Optional, 1–8 entries, unique kebab-case `id`, `label` 1–40 chars, optional `icon` (same rules as `panel.icon`, falls back to it), `where: "message" \| "session"`. Message actions may narrow `roles` to `["user"]` / `["assistant"]` (default both); session actions may ask for `payload: ["messages"]`, which adds the `conversation` capability. Bad shape is `invalid-actions`. The entry shows in that message's or session's menu and opens the guest with the item as `ready.item` (the attach window for `attach: "dialog"`, otherwise the rail) |
| `commands`            | Optional, 1–8 entries, unique `name` matching `/^[a-z][a-z0-9-]{0,23}$/`, optional `description` 1–80 chars (`invalid-commands`). `/name args` in the chat box calls `onResolve` instead of the model and attaches what it returns. A name the composer already has (built-in, OpenCode command, skill) is ignored with a console warning |
| `filesystem`          | Optional, 1–16 globs, each 1–256 chars, starting with `/` or `~/`; `**` spans folders, `*` / `?` stay in one segment; no `..`, empty segment, or backslash (`invalid-filesystem`). Declaring it adds the `filesystem` capability and the dialog lists the globs |
| `integration`         | Optional. Exactly one of `oauth`, `token`, or `host` (`provider: "linear"` only)                                                                                                     |
| `service`               | Optional. `entry` must be a built `.js` file on disk. See [GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_SERVICES.md)                        |


Extra keys are dropped, not forwarded.

### 3.2 Parse / version helpers


| Export                                             | Role                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `parseManifest(document)` (`@openchamber/sdk/schemas`) | Typed document → success/failure (does not throw on junk) |
| `parseManifestJson(json)` (`@openchamber/sdk/schemas`) | String → same result                                      |
| `resolveAttachMode(attach)`                        | Normalize to `'panel'                                     |
| `resolveAttachEntry(contributes)`                  | Dialog page from the object form, or `null` when the dialog reuses `panel.entry` |
| `resolveIntegrationAuth` / `resolveIntegrationApi` | Auth kind and API origin                                  |
| `toPublicIntegration` / `toPublicService`            | Catalog-safe public slices                                |
| `isGuestPackageSvgIcon`                            | Whether icon is a package SVG path                        |
| `compareOpenChamberVersions`                       | Semver compare                                            |
| `hostMeetsOpenChamberEngine`                       | Host vs `engines.openchamber` floor                       |
| `openChamberEngineMinimum`                         | Normalize `>=1.22.0` → floor string                       |
| `parseOpenChamberVersion`                          | Parse `x.y.z`                                             |


### 3.3 Protocol helpers (host + guest tooling)


| Export                                                                                                            | Role                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `readHostMessage` (`@openchamber/sdk`)                                                                            | Guest-side read of a host push; no schema library |
| `parseHostMessage` / `parseGuestMessage` (`@openchamber/sdk/schemas`)                                             | Host-side typed parse              |
| `hostMessageSchema` / `guestMessageSchema` (`@openchamber/sdk/schemas`)                                           | Zod schemas for `postMessage` data |
| `clampAttachRequest` / `clampStartSessionRequest` / `clampPromptRequest`                                          | Enforce field max lengths          |
| `isGuestRequestPath` / `isGuestRequestResult` / `isStartSessionResult` / `isPromptResult` / `isServiceStatusResult` | Narrow result payloads             |
| `isGuestAttachItem` / `isGuestMessageItem` / `isGuestSessionItem`                                                 | Narrow `ready.item`                |
| `clampBadgeCount` / `guestActionsNeedConversation`                                                                | Badge range; whether declared actions need `conversation` |
| `isHostRequestErrorCode` / `resolveHostRequestErrorCode`                                                          | Error code validation              |


Constants: `OPENCHAMBER_SDK_CHANNEL`, `OPENCHAMBER_SDK_API_VERSION`, `HOST_LINEAR_API_ORIGIN`, `GUEST_*_MAX`, `GUEST_REQUEST_TIMEOUT_MS`, `GUEST_ACTIONS_MAX`, `GUEST_COMMANDS_MAX`, `GUEST_COMMAND_NAME`, `HOST_REQUEST_ERROR_CODES`, `SERVICE_STATUS_VALUES`, `SESSION_LIFECYCLE_PHASES`, `START_SESSION_SENT`.

Wire messages added for these: host → guest `resolve` (`{ id, payload: { command, args } }`), guest → host `resolve-result` (`{ id, payload: { item } | { error } }`, no `result` comes back) and `badge` (`{ count }`).

---

## 4. Local services (`contributes.service`)

For Docker sockets, CLI binaries, kubectl, and similar. The sandboxed iframe cannot dial Unix sockets; the host spawns a package entry and proxies HTTP.

Panel → `serviceRequest` → host → `127.0.0.1:port` → service process → socket/CLI.


| Panel call                                      | Role                             |
| ----------------------------------------------- | -------------------------------- |
| `serviceRequest({ method, path, query?, body? })` | Proxy to this guest's service only |
| `serviceStatus()`                                 | Lifecycle state                  |


Manifest sketch: `service.entry` (path to **built** JS, e.g. `service/main.js`), `runtime: "host"`, `permissions.sockets` and/or `permissions.exec`. Install refuses with `missing-build` when that file is absent. Declaring a service adds `service` to the capabilities the user approves at install; until then `serviceRequest` is `NO_SERVICE`.

Bundle the service with the Node target:

```bash
bunx openchamber-guest-bundle --node service/main.ts service/main.js
```

Full contract (env vars, `/health`, grants, socket overrides): `[GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_SERVICES.md)`.

---

## 5. What this package does not provide

Frozen on `apiVersion` 1 — named in docs, no host hole yet:

- Host-side `issues.search` / `issues.get` (guest draws the list; chip is `attach`)
- Public OAuth broker
- Commands, shortcuts, raw git remotes, magic prompts
- Second `host.provider` beyond Linear
- Arbitrary filesystem access (only the open project with `files`, or declared `contributes.filesystem` globs), terminal, pairing, or host React components from the guest

Do not go around the guest contract through `RuntimeAPIs`.

---

## 6. Minimal panel sketch

```ts
import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady, mountList, mountEmpty } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root')!;

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);

  if (!ctx.connection.connected) {
    mountEmpty(root, {
      title: 'Connect Acme',
      action: { label: 'Sign in', onClick: () => { void host.oauthStart(); } },
    });
    return;
  }

  mountList(root, {
    items: [], // fill from host.request
    onSelect: (id) => {
      void host.attach({
        providerId: 'acme-hello',
        id,
        title: id,
        url: '',
      });
    },
  });
});

host.onConnection(async (connection) => {
  if (!connection.connected) return;
  try {
    const res = await host.request({ method: 'GET', path: '/api/v2/tasks' });
    // parse res.body, then remount / update the list
  } catch (error) {
    if (error instanceof HostRequestError && error.code === 'DISCONNECTED') {
      await host.oauthStart();
    }
  }
});
```

---

## Related files


| File                                                                                                                                                                                                                                                                                                                      | Audience                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [README.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/README.md)                                                                                                                                                                                                                                   | Package overview and first hole   |
| [DOCUMENTATION.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/DOCUMENTATION.md)                                                                                                                                                                                                                     | Agent / maintainer invariants     |
| [GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_SERVICES.md)                                                                                                                                                                                                                       | Local service contract              |
| [src/ui/DOCUMENTATION.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/src/ui/DOCUMENTATION.md)                                                                                                                                                                                                       | UI kit invariants                 |
| [sdk.mdx](https://github.com/openchamber/openchamber/blob/sdk/packages/docs/content/docs/sdk.mdx) / [sdk/host.mdx](https://github.com/openchamber/openchamber/blob/sdk/packages/docs/content/docs/sdk/host.mdx) / [sdk/ui.mdx](https://github.com/openchamber/openchamber/blob/sdk/packages/docs/content/docs/sdk/ui.mdx) | Author-facing website pages       |


