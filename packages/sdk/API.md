# @openchamber/sdk — developer API reference

What third-party guest authors import and call. Source of truth: `[packages/sdk/src](https://github.com/openchamber/openchamber/tree/main/packages/sdk/src)`. Longer guides live in the [product docs](https://github.com/openchamber/openchamber/tree/main/packages/docs/content/docs) (`sdk.mdx`, `sdk/host.mdx`, `sdk/ui.mdx`) and in `[GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md)` for local services.

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

`inspectGuestPackage` (Settings → Extensions install) checks the folder or zip **on disk**. Parse alone is not enough. No OpenChamber runtime compiles TypeScript: packaged desktop, `openchamber serve`, and the dev server all serve the built `.js` files as they sit in the package.


| Must exist                                                                       | When                                            | Failure code       |
| -------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------ |
| Semver `version` on `package.json` (`1.0.0`)                                     | Always on install                               | `invalid-manifest` |
| `panel.entry` or `background.entry` HTML file | Every declared entry | `invalid-manifest` |
| Every relative `<script src="…">` `.js` from that HTML | Every declared entry | `missing-build` |
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

Zip or folder for install should include at least: `package.json`, `panel/index.html`, `panel/main.js`, and any declared `icon.svg` / `service/main.js`. Skip `node_modules` and TypeScript sources. Zip and git installs land in `{dataDir}/extensions/{id}`. See also `[GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md)`.

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
| `onAction(handler)` | `GuestActionItem` → `void \| Promise<void>` | Runs a `mode: "background"` message or session action. Register synchronously after `connectHost`. Await every operation; the frame is removed when the handler settles. Throw to report an error. One handler at a time; returns an unsubscribe function |


`HostReadyContext`


| Field          | Type                     | Meaning                                                                                  |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `theme.mode`   | `'light'                 | 'dark'`                                                                                  |
| `theme.tokens` | surfaces, text, interaction states, `primary`, status colors, `font`, `mono`, `radius` | Pass to `applyHostReady` before mounting UI |
| `locale`       | `string`                 | Host language tag                                                                        |
| `directory`    | `string                  | null`                                                                                    |
| `session`      | snapshot or `null`       | Title falls back to `id`. `busy` is live status. `model` is `providerID/id` when present |
| `surface` | `'panel' \| 'dialog' \| 'page' \| 'background'` | Where the host mounted this frame |
| `connection`   | `{ connected, account }` | Integration link state                                                                   |
| `settings`     | `Record<string, string>` | Declared keys only                                                                       |
| `item`         | `GuestItem               | null`                                                                                    | Set when the user clicked this guest's chip on the composer, or ran one of this guest's `contributes.actions`. Narrow with `isGuestMessageItem` / `isGuestSessionItem` / `isGuestAttachItem` |


`theme.tokens` includes `primaryText`, `successText`, `warningText`, `errorText`, and `infoText`. The host computes these for text on neutral surfaces and the UI kit's tinted controls. Keep using the base colors for fills and `primaryForeground` for text on a solid primary fill.

`applyHostReady` exposes the computed colors as `--primary-text`, `--success-text`, `--warning-text`, `--error-text`, and `--info-text`, with matching `--oc-*-text` aliases. These are required theme fields. Apply each `onReady` snapshot to update them when the theme changes.

`GuestItem` is `AttachIssueRequest | GuestMessageItem | GuestSessionItem`:

```ts
type GuestMessageItem = {
  kind: 'message';
  action: string;          // the action id from the manifest
  sessionId: string;
  sessionTitle: string;
  directory: string | null;  // the session's project directory
  messageId: string;
  role: 'user' | 'assistant';
  text: string;            // what the Markdown export renders for that message, at most 200 000 chars
};

type GuestSessionItem = {
  kind: 'session';
  action: string;
  sessionId: string;
  sessionTitle: string;
  directory: string | null;  // the session's project directory
  messages?: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: number }>; // oldest first; only with payload ["messages"] and the conversation grant. Same messages the Markdown export writes: the conversation plus context the user attached (`user`); OpenCode's own plumbing messages are left out
  truncated?: boolean;     // the oldest messages were dropped so the item stays under 2 000 000 serialized chars
};
```


Access tokens never appear in `ready` or in request results.

**Session lifecycle phases:** live `busy` / `retry` → `started`; `idle` → `completed`; unknown status → `failure` (not abort/crash).

### 1.2 Actions (RPC)


| Method            | Arguments                         | Returns                        | Behavior                                                                              |
| ----------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `toast` | `{ kind: 'info' \| 'success' \| 'error', message, copy?, dismiss?, persistent? }` | `Promise<void>` | Show a toast, optionally with host-owned Copy and OK buttons; see Toast buttons below |
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
| `openCommit`      | `sha: string`                     | `Promise<void>`                | Show that commit of the open project in the host's Diff view (commit scope). 7–64 hex characters; the host reads the commit itself. `NO_DIRECTORY` without a project, `NOT_FOUND` for an unknown commit, `UNSUPPORTED` where the host has no Diff view |
| `setHeight`       | `height: number`                  | `Promise<void>`                | Content height in CSS px. The Work Status section sizes its frame to it, clamped to 24–320; taller content scrolls inside. A page docked to a shared surface grows or shrinks its dock to it (a width for a `left`/`right` dock), from 24 px up to half the panel. Other surfaces ignore it |
| `generate`        | `{ prompt, system?, maxOutputTokens? }` | `Promise<{ text }>`      | One-off text from the user's Small Model (capability `model`). No session, no history; the host picks the model. Waits up to 90 s |
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

`StartSessionRequest` adds `projectId?`, `navigation?: 'preserve' | 'open'`, and `worktree?` to the attach fields. Navigation defaults to `preserve`. Without `projectId`, the current directory is used. With one, creation targets that registered project without switching the app first.

`worktree` is `false` or omitted for the target directory, `true` for a generated new worktree, `{ kind: 'existing', directory }` for a known worktree belonging to the project, or `{ kind: 'new', name?, baseBranch? }`. `name` names both the branch and worktree. Omitted name/base use the host's normal defaults. First-message model/agent/variant selection is captured when the call starts.

A created session returns `{ sessionId, directory, sent, linked, worktree? }`. `linked: false` means the session exists but saving the attached item failed. If a worktree was created but bootstrap or session creation failed, the result is `{ sessionId: null, sent: 'skipped', directory, worktree, failure }`, where `failure` is `bootstrap-failed` or `session-create-failed`. The worktree is retained. Inspect the result before offering Retry, which would otherwise create another worktree. The call waits up to 180 seconds; a timeout does not prove the server rolled back.

### Workspace lists and subscriptions

These methods extend the existing `sessions` capability. They expose registered projects on the connected server, session metadata and live state, and known worktrees. They do not grant conversation content or file access.

| Method | Result |
| --- | --- |
| `listProjects()` | `Promise<GuestProjectsSnapshot>` |
| `listWorktrees(projectId)` | `Promise<GuestWorktreesSnapshot>` |
| `listSessions(projectId)` | `Promise<GuestSessionsSnapshot>` including known archived sessions |
| `onProjects(listener)` | `Promise<() => void>` |
| `onWorktrees(projectId, listener)` | `Promise<() => void>` |
| `onSessions(projectId, listener)` | `Promise<() => void>` |
| `openSession(sessionId)` | `Promise<void>`, explicitly opens the chat and closes the page |

Await subscription registration to handle refusal, then retain its returned unsubscribe function. Each subscription sends an initial snapshot, then changes. At most 32 subscriptions per iframe. `dispose()` releases them all. Unmount, disable, uninstall and runtime switch also release host subscriptions.

Snapshots carry `state: 'loading' | 'ready' | 'error'`; session snapshots also carry per-directory `coverage`. Loading/error may retain data. Only `ready` establishes complete empty success. Reads use existing shared stores and hydration, never a git scan per extension request.

Projects contain `id`, `name`, `directory`. Worktrees contain `directory`, `name`, `branch`, and `status: 'ready' | 'pending' | 'invalid' | 'missing'`. Session records contain `id`, `title`, `projectId`, `directory`, `parentId`, `createdAt`, `updatedAt`, `archivedAt`, `worktree`, `activity`, `outcome`, and `items`. Item references contain only this extension's `id` and optional `data`.

`activity` is `unknown`, `idle`, `running`, `retrying`, `waiting-permission`, or `waiting-question` (the agent put a form to the user and is waiting on the answer). `outcome` is the last observed `completed` or `failed` turn, or `null` when unknown or working. Outcomes are in memory for the latest 2,000 observed sessions, reset on runtime switch, and are not reconstructed from persisted history. A later idle event preserves an observed failure until another run starts. `completed` never means the extension's task is Done. Blocking-request contents and approve/reply actions are not exposed.

### Extension storage

`host.storage.get(key)` returns JSON or `undefined` for a missing key. JSON `null` is a stored value. `set(key, value)` and `delete(key)` return `Promise<void>`; `keys()` returns `Promise<string[]>` in sorted order.

Storage belongs to the extension on the connected server and needs no extra capability. Keys contain 1 to 128 characters, each serialized value is at most 64 KiB UTF-8, and the complete namespace is at most 2 MiB and 2,000 keys. Use a project ID in your key when data belongs to one project. Concurrent operations serialize on the server, writes are atomic, and read/write failures preserve existing data. Uninstall deletes the namespace, including for folder installs.

### Full-screen pages

`contributes.page: true` reuses `panel.entry`; `{ entry: 'panel/page.html', title?: 'Board' }` uses separate package HTML. It requires `panel.entry` and the same installed/approved/enabled state as the panel. The sidebar's Extension pages menu is the only page opener; `openSurface` does not open it. `ctx.surface` is `page`, `close()` closes it, and reload or runtime switch returns to chat. Pages use the existing sandbox and capabilities on web/desktop. VS Code and mobile remain unsupported.

### Work Status sections

`contributes.statusSection: true` reuses `panel.entry`; `{ entry: 'status/index.html', title?: 'Recent commits', height?: 160 }` uses separate package HTML (`.html`, inside the package, built scripts checked at install). The object form needs no `panel.entry`, so an extension can ship only a section and no rail icon. `title` is 1 to 60 characters and replaces `panel.name` on the section header; the icon is `panel.icon`. `height` (24 to 320, default 120) is the frame height before your page calls `setHeight`. The section appears in the chat's Work Status panel and in its section chooser, where the user can hide it or move it. `ctx.surface` is `status`. The frame runs only while the panel is shown and the section is expanded, so keep no state in it that you cannot rebuild. It gets the same sandbox, directory, session, theme, grants, and service as a panel. A status-only package may declare `capabilities`, `service`, `integration`, and `filesystem`; `page`, `attach`, `actions`, and `commands` still need `panel.entry` or `background.entry`. Web and desktop only.

`sent` **values** (`startSession` / `prompt`): `sent` | `no-model` | `skipped` | `failed`. After `no-model` / `failed` on `startSession`, the session still exists.

**File path rules** (`readFile` / `writeFile` / `listDir` / `stat`): a relative path (`README.md`, `src/x.ts`, `.`) is joined to the project that is open when the call runs and needs the `files` capability; no open project is `NO_DIRECTORY`. A path starting with `/` or `~/` is outside the project, must match one of the package's `contributes.filesystem` globs, and needs the `filesystem` capability. Any `..` segment, a backslash, or a symlink that leads out of the allowed tree is `BAD_PATH`. The host compares canonical (realpath) paths, so `/tmp/x` on macOS is checked as `/private/tmp/x` and a pattern's literal prefix is canonicalized the same way. Content over 2 000 000 characters is `FILE_TOO_LARGE` in both directions; an OS permission refusal is `DENIED`.

`request` **/** `serviceRequest` **rules:** `method` is `GET` | `POST` | `PUT` | `PATCH` | `DELETE`. `path` must start with `/`, no scheme, stay on the declared origin (cloud API or service loopback). Guest parses `body` as JSON when needed.

### Toast buttons

`ToastRequest.copy` is an optional boolean or `{ text: string }`. `true` copies the displayed message; an object supplies the clipboard value. `false` or omission adds no Copy button. The custom text must contain 1 to `GUEST_CLIPBOARD_TEXT_MAX` characters, with whitespace preserved. The displayed message is trimmed and must contain 1 to `GUEST_TOAST_MAX` characters. The client rejects invalid text lengths as `HOST_REJECTED` before sending; the host independently validates the wire payload.

`dismiss: true` adds OK. `persistent: true` disables automatic expiry and always adds OK regardless of `dismiss`, so every persistent toast can be closed. Omitted or false `persistent` retains the host's usual duration.

Copy leaves the toast open, reports success on the button, and shows a retryable error when the clipboard fails. OK dismisses only its own toast. Buttons use the host's locale and clipboard helper. They retain only the supplied text and toast identity, work after guest disposal or a runtime switch, and never call back into the extension. The `toast` promise resolves after display acknowledgement, without waiting for a click. Web and desktop use the same behavior; extension support on other runtimes is unchanged.

### Background actions

`contributes.actions[].mode` accepts `"open"` or `"background"`. Omitted mode keeps the existing panel/dialog routing and `onItem` delivery. Background actions load `background.entry` when declared, otherwise `panel.entry`. They never use separate attach-dialog HTML. They run on web and desktop, including connections through the private relay; VS Code and mobile still do not load extensions.

`contributes.background` is `{ entry: "<package-local .html>" }`. It starts on demand for an action or command and adds no visible UI. With a background entry, `panel.entry` may be omitted: there is no rail icon, attach picker, or full-screen page, but background actions, slash commands, storage and granted APIs work. Identity remains in `panel.id/name/icon`. Open-mode actions, `page`, and enabled `attach` require `panel.entry`; invalid combinations fail as `invalid-panel`. Without either entry, the extension remains tools-only. Invalid background paths or a missing entry field fail as `invalid-background`.

When both entries exist, the visible panel cannot register the slash-command resolver: the hidden background entry handles `onResolve` and receives `surface: "background"`. Existing panel-only commands retain their current behavior. Clicking an attached chip from a background-only extension shows a no-panel notice; its browser action remains available.

Every background click mounts a fresh sandboxed iframe and sends one `action` request with an invocation `id` and a `GuestActionItem` payload. `host.onAction` receives that message or session item and sends `action-result` with `{ ok: true }` when the handler finishes, or `{ ok: false, error }` when it throws. The error is limited to `GUEST_RESOLVE_ERROR_MAX` characters. The host validates the reply and accepts only the matching invocation from that frame. It sends no acknowledgement for `action-result`.

`ready.surface` is `"background"` and `ready.item` is `null`. Context updates never replay the action. The session and directory context remain scoped to the clicked target; the item itself is the snapshot captured at click time. Calls that explicitly write the composer still write the currently visible composer. `close()` is a no-op in a background frame; returning from the handler completes the action.

The 20-second deadline covers loading and execution. At most eight background invocations may run concurrently. Completion, failure, timeout, disabling, lost approval, extension update/removal, runtime switch, and host unmount release the frame and its listeners. Late messages are ignored. Already completed or server-accepted effects are not undone, and the host does not automatically retry actions. A background action has the same declared capabilities as its extension. It does not hide the extension's rail icon.

See [Actions without opening a panel](./README.md#actions-without-opening-a-panel) for a toast example.

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
| `NO_MODEL`         | `generate` with no usable Small Model         |
| `MODEL_FAILED`     | The Small Model returned an error             |
| `UNSUPPORTED`      | This host surface cannot do that (for example `openCommit` without a Diff view) |
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
| Background action loading and execution | 20 000 ms |
| Badge count                      | 999       |
| Message item `text`              | 200 000   |
| Session item (serialized)        | 2 000 000 |
| File path                        | 1 024     |
| File content (read and write)    | 2 000 000 |
| `listDir` entries                | 2 000     |
| `generate` prompt / system       | 64 000 / 8 000 |
| `generate` `maxOutputTokens`     | 4 000     |
| `generate` answer                | 256 000   |
| `generate` timeout               | 90 000 ms |


---

## 2. `@openchamber/sdk/ui` — drawing kit

DOM building blocks that use host tokens. They do **not** call the provider or `connectHost`. You compose the screen and wire callbacks yourself.

Always call theme first:

```ts
import { applyHostReady, mountList } from '@openchamber/sdk/ui';

let mounted = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  // then mount…
});
```

Every mount returns `{ update(partial), dispose() }`. `update` merges the fields you pass and repaints; `dispose` removes the node and its listeners.

Selection controls report a proposed value; the caller commits it with `update`. Use `activeId` for tabs, `value` for selects, and `checked` for checkboxes and switches. Text and search inputs display typing immediately, but call `update({ value })` too so later updates do not restore stale props. Button clicks do not change `variant`; use tabs for mode selection. Preserve input state across tab changes instead of remounting empty fields.

```ts
import { mountTabs } from '@openchamber/sdk/ui';

let activeId = 'convert';
const tabs = mountTabs(root, {
  items: [{ id: 'convert', label: 'Convert' }, { id: 'format', label: 'Format' }],
  activeId,
  onChange: (next) => {
    activeId = next;
    tabs.update({ activeId });
    // Show the matching panel while preserving its draft values.
  },
});
```

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
      "tools": [{ "match": "mcp.tasks.*", "name": "Tasks", "icon": "checkbox-circle", "title": "{input.id}", "output": "table", "columns": ["id", "title", "status"] }],
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
| `panel.entry` | Optional visible-panel HTML path inside the package. No `..`, absolute path, or URL. Its scripts must be built. Omitting it removes the rail icon and visible views; `background.entry` can still run code. With neither entry, only `tools` plus package identity/version/engines are allowed. `hasGuestPage` means a visible panel, not background execution |
| `background.entry` | Optional package-local `.html` path. Loaded on demand for background actions and slash commands, preferred over `panel.entry` for these calls. Adds no rail icon. The file and its built scripts must exist. Malformed declarations are `invalid-background` |
| `attach`              | `true` / `"panel"` → + menu opens rail; `"dialog"` → host window; omit/`false` → off menus. Object form `{ "mode": "panel" \| "dialog", "entry"?: "panel/attach.html" }`: `entry` (dialog only, same path rules as `panel.entry`, must exist with built scripts) is the page the dialog loads instead of `panel.entry` |
| `capabilities`        | Optional list of `prompt`, `sessions`, `files`, `model`. `files` is read **and** write inside the open project; `model` is `generate`. Approved once at install                     |
| `actions` | Optional, 1–8 entries, unique kebab-case `id`, `label` 1–40 chars, optional `icon` with the `panel.icon` rules, `where: "message" \| "session"`, optional `mode: "open" \| "background"`. Message actions may narrow `roles` to `["user"]` / `["assistant"]`, default both. Session actions may request `payload: ["messages"]`, adding the `conversation` capability. Invalid shape is `invalid-actions`. Default `open` mode opens the guest with `ready.item`, using the attach dialog for `attach: "dialog"` and the rail otherwise. `background` calls `onAction` in a temporary hidden frame; see Background actions above |
| `commands`            | Optional, 1–8 entries, unique `name` matching `/^[a-z][a-z0-9-]{0,23}$/`, optional `description` 1–80 chars (`invalid-commands`). `/name args` in the chat box calls `onResolve` instead of the model and attaches what it returns. A name the composer already has (built-in, OpenCode command, skill) is ignored with a console warning |
| `tools`               | Optional, 1–16 entries that say how the extension's tool calls look in the chat. `match` is the full tool name OpenCode reports (`mcp.jira.search`, `jira_search`), 1–128 chars of `[A-Za-z0-9_.:-]`, with `*` allowed once at the end as a suffix wildcard (`mcp.jira.*`). Optional `name` (1–40, the header title when `title` is absent or renders empty), `icon` (Remixicon name or package `.svg` path, same rules as `panel.icon`; the SVG is drawn in the text colour at the glyph size), `title` / `subtitle` templates (1–200, `{input.path}` / `{output.path}` / `{metadata.path}` placeholders, a missing path renders empty, values are cut at 200), `output` `"auto"` (default) \| `"text"` \| `"json"` \| `"markdown"` \| `"code"` \| `"table"`, `language` (code only), `columns` (table only, 1–16 dotted paths; rows are the output array or `output.items`). Bad shape is `invalid-tools`. An exact `match` beats a wildcard from any extension; among equals the first extension wins. Only an enabled, fully approved extension's rules apply |
| `filesystem`          | Optional, 1–16 globs, each 1–256 chars, starting with `/` or `~/`; `**` spans folders, `*` / `?` stay in one segment; no `..`, empty segment, or backslash (`invalid-filesystem`). Declaring it adds the `filesystem` capability and the dialog lists the globs |
| `integration`         | Optional. Exactly one of `oauth`, `token`, or `host` (`provider: "linear"` only)                                                                                                     |
| `service`               | Optional. `entry` must be a built `.js` file on disk. `provides: ["browser"]` makes it the agent's browser when the user selects it; `surface: true` gives it a host-drawn live panel the user can take over (no `panel.entry` then). Neither needs a panel or background entry. See [GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md) |


Extra keys are dropped, not forwarded.

### 3.2 Parse / version helpers


| Export                                             | Role                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `parseManifest(document)` (`@openchamber/sdk/schemas`) | Typed document → success/failure (does not throw on junk) |
| `parseManifestJson(json)` (`@openchamber/sdk/schemas`) | String → same result                                      |
| `resolveAttachMode(attach)`                        | Normalize to `'panel'                                     |
| `resolveAttachEntry(contributes)`                  | Dialog page from the object form, or `null` when the dialog reuses `panel.entry` |
| `hasGuestPage(contributes)` | `true` when `panel.entry` is set; background-only and tools-only packages return `false` |
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


Constants: `OPENCHAMBER_SDK_CHANNEL`, `OPENCHAMBER_SDK_API_VERSION`, `HOST_LINEAR_API_ORIGIN`, `GUEST_*_MAX`, `GUEST_REQUEST_TIMEOUT_MS`, `GUEST_ACTIONS_MAX`, `GUEST_COMMANDS_MAX`, `GUEST_COMMAND_NAME`, `GUEST_TOOLS_MAX`, `GUEST_TOOL_MATCH`, `GUEST_TOOL_OUTPUTS`, `HOST_REQUEST_ERROR_CODES`, `SERVICE_STATUS_VALUES`, `SESSION_LIFECYCLE_PHASES`, `START_SESSION_SENT`.

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

A service with `provides: ["browser"]` answers the agent's `browser.*` actions at `POST /browser-control` instead of the desktop app's browser panel, once the user selects it in Settings → OpenChamber Tools. The host starts it on the first action and stops it when idle. Parse the body with `readBrowserProviderRequest`; request and answer types (`BrowserProviderRequest`, `BrowserProviderResult`, per-action `Browser*Parameters` / `Browser*Data`) and the limits (`BROWSER_PROVIDER_*`) are exported from `@openchamber/sdk`. Full contract in [GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md#browser-provider-provides-browser).

A service with `surface: true` shows a live picture in the extension's rail panel: the host pulls frames from `GET /surface/frame`, draws them, sends the user's input to `POST /surface/input`, and owns who is in control (nobody, the agent, the user). Paths, event types, and the `readSurface*` parsers are exported from `@openchamber/sdk`; contract in [GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md#shared-surface-surface-true).

Bundle the service with the Node target:

```bash
bunx openchamber-guest-bundle --node service/main.ts service/main.js
```

Full contract (env vars, `/health`, grants, socket overrides): `[GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md)`.

---

## 5. What this package does not provide

Frozen on `apiVersion` 1 — named in docs, no host hole yet:

- Host-side `issues.search` / `issues.get` (guest draws the list; chip is `attach`)
- Public OAuth broker
- Keyboard shortcuts, raw git remotes, magic prompts
- Second `host.provider` beyond Linear
- Arbitrary filesystem access from the page (only the open project with `files`, or declared `contributes.filesystem` globs), terminal, pairing, or host React components. A declared `service` is outside these limits: it is a process with the user's rights and no sandbox

Do not go around the guest contract through `RuntimeAPIs`.

---

## 6. Minimal panel sketch

Mount once and keep the handles. `onReady` can repeat when the session or theme changes. Field listeners replay their current values too; compare relevant fields before fetching data again. For a complete request example with stale-response handling, see [the extension example](https://docs.openchamber.dev/sdk/example/).

```ts
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountList, mountEmpty } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root')!;

let mounted = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;

  const signInRoot = root.appendChild(document.createElement('div'));
  const listRoot = root.appendChild(document.createElement('div'));
  mountEmpty(signInRoot, {
      title: 'Connect Acme',
      action: { label: 'Sign in', onClick: () => { void host.oauthStart(); } },
  });

  mountList(listRoot, {
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
  host.onConnection((connection) => {
    signInRoot.hidden = connection.connected;
    listRoot.hidden = !connection.connected;
  });
});
```

---

## Related files


| File                                                                                                                                                                                                                                                                                                                      | Audience                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [README.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/README.md)                                                                                                                                                                                                                                   | Package overview and first hole   |
| [DOCUMENTATION.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/DOCUMENTATION.md)                                                                                                                                                                                                                     | Agent / maintainer invariants     |
| [GUEST_SERVICES.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/GUEST_SERVICES.md)                                                                                                                                                                                                                       | Local service contract              |
| [src/ui/DOCUMENTATION.md](https://github.com/openchamber/openchamber/blob/main/packages/sdk/src/ui/DOCUMENTATION.md)                                                                                                                                                                                                       | UI kit invariants                 |
| [sdk.mdx](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/sdk.mdx) / [sdk/host.mdx](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/sdk/host.mdx) / [sdk/ui.mdx](https://github.com/openchamber/openchamber/blob/main/packages/docs/content/docs/sdk/ui.mdx) | Author-facing website pages       |
