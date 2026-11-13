# Guest local services

Implemented on manifest `apiVersion: 1`. Wire envelope `OPENCHAMBER_SDK_API_VERSION` stays `1`.

This is the contract for guests that need a local process (Docker CLI, Engine sockets, kubectl, DB sockets). The iframe stays sandboxed. The host owns spawn and the loopback proxy.

## Why services exist

HTML guests in a sandboxed iframe reach the network only through `connectHost.request` onto a declared HTTPS `apiOrigin`. That fits cloud trackers. It cannot open `/var/run/docker.sock`, run `docker`, or hold a long-lived local daemon.

Services keep the iframe. They add a host-owned child process from the same package. The panel never sees the socket. The service does.

Do not put `docker` (or any product name) on `connectHost`. The SDK knows panel, service, and a loopback proxy. The package owns the integration.

Declare the OpenChamber floor with `engines.openchamber` (`1.22.0` or `>=1.22.0`). Install refuses when this host is older. Put a semver `version` on `package.json` (`1.0.0`); install requires it and Settings → Extensions shows `v1.0.0` on the card.

## Model

```
panel (iframe) --serviceRequest--> host --HTTP 127.0.0.1:port--> service process --> socket / CLI
                     ^
                     spawn / kill / grant
```

1. Package still ships `panel/index.html` and a classic IIFE `panel/main.js`.
2. Optional `contributes.service` names a built entry the host can spawn.
3. After the user allows the service in Settings → Extensions, the first `serviceRequest` starts that entry with the app runtime (`process.execPath` + `ELECTRON_RUN_AS_NODE` on desktop). A system `node` on PATH is not required.
4. The host binds `127.0.0.1` on an ephemeral port and passes `OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN` in the service env. The service does not inherit the host environment: only PATH, HOME, temp, locale, and the Windows system variables are copied. API keys, the UI password, and other host secrets never reach it.
5. The panel calls `serviceRequest({ method, path, query?, body? })`. The host proxies only to that guest's loopback listener. Same stay-on-origin rule as `request`, but the origin is the service the host started.
6. The service talks to Docker, kubectl, or anything else. That logic stays in the package.

## Permissions: `exec` vs `sockets`

| Declare | Means | Service does |
|---|---|---|
| `exec` | Named binaries on PATH | `child_process` / CLI |
| `sockets` | Unix socket or named pipe | Dial Engine API (or similar) itself |

Use `exec` when the integration shells out (like a modern Docker CLI panel). Use `sockets` when the service opens the daemon endpoint. Do not list a socket path in Needs for a CLI-only service.

## Manifest

```json
{
  "apiVersion": 1,
  "engines": {
    "openchamber": ">=1.22.0"
  },
  "contributes": {
    "panel": {
      "id": "docker-sock",
      "name": "Docker (socket)",
      "icon": "icon.svg",
      "entry": "panel/index.html"
    },
    "service": {
      "entry": "service/main.js",
      "runtime": "host",
      "permissions": {
        "sockets": [{
          "id": "docker",
          "candidates": {
            "linux": ["/var/run/docker.sock", "/run/user/1000/docker.sock"],
            "darwin": ["~/.docker/run/docker.sock", "~/.colima/default/docker.sock"],
            "win32": ["//./pipe/docker_engine"]
          }
        }]
      }
    },
    "attach": false
  }
}
```

A CLI service looks the same except `permissions.exec: ["docker"]` and no `sockets`.

Socket entry shapes:

- `string` — legacy one path for every platform; public id is that string
- `{ id, path }` — same path on linux / darwin / win32
- `{ id, candidates: { linux?, darwin?, win32? } }` — per-OS lists; `~` expands

Parse rules:

- `apiVersion` is `1`. Wire `v` on postMessage stays `1`.
- `engines.openchamber` is optional. Values are `1.22.0` or `>=1.22.0` only. Install returns `host-too-old` when this OpenChamber build is older.
- `contributes.panel` stays required. Same id / name / icon / entry rules as any guest.
- `contributes.service` is optional. A guest without `service` is HTML-only.
- `service.entry` is a relative path inside the package. Ship compiled JS; the host never compiles TypeScript.
- `service.runtime` phase 1 accepts only `"host"`.
- `service.provides` is optional: host roles `"browser"`, `"source-control"`, `"notifications"`, `"tracker"` and `"quota"`, plus `"opencode"` for the reads described under [OpenCode access](#opencode-access). A service that provides a role needs no `panel.entry` or `background.entry`; the host starts it itself. An extension is a Git host or a tracker, never both: the two would share the id `ext-<panel.id>`.
- `service.keepRunning` is optional (`true`): the host starts the service with OpenChamber and brings it back when it stops (*Running with nobody asking*, below). The approval dialog says so.
- `service.schedule` is optional, up to `SERVICE_SCHEDULE_MAX` (8) of `{ id, cron, timezone? }`: runs the host posts on a clock. The approval dialog lists them.
- `service.surface` is optional (`true`): the service shows a live picture the host draws in the extension's rail panel and takes the user's input back (below). With `panel.entry` too, that page is docked to one edge of the picture (`panel.dock`: `top`, `bottom`, `left`, or `right`, default `top`; `panel.size` in CSS px across that edge, 24 to 480, default 40); without it, the picture is the whole panel.
- `service.permissions.sockets` and `service.permissions.exec` are shown to the user in the approval dialog. They describe intent and do not confine the process: a service runs with the user's full access. Declaring `contributes.service` adds the `service` capability to the package's request list; the user approves the whole list once when the package is installed (Settings → Extensions), and the first `serviceRequest` is refused with `NO_SERVICE` until then.
- The catalog adds `service.socketBindings`: `{ id, candidates, resolved, override }` for this host. The user can override a path in Extensions. Override empty clears it and the next spawn re-resolves.
- `contributes.integration` remains valid next to `service`. Cloud `request` and `serviceRequest` may both exist on one guest.

Extra keys still drop, not forward.

## Host hole

| Method | Role |
|---|---|
| `serviceRequest` | `{ method, path, query?, body? }` → `{ status, body }`. Proxy to this guest's service loopback only. `path` starts with `/`, no scheme. |
| `serviceStatus` | `stopped` \| `starting` \| `ready` \| `failed`. |

Do not add: raw unix socket from the panel, arbitrary `spawn`, arbitrary filesystem, `host.docker`.

Error codes:

- `NO_SERVICE` — no service declared, not granted, not started, or already torn down
- `DISABLED` — extension paused in Settings → Extensions (service stopped; tokens/grants stay)
- `SERVICE_FAILED` — process crashed or never became ready; nothing was sent to it
- `REQUEST_FAILED` — the request was sent but got no usable answer (timeout, dropped connection); the service may have acted on it
- `RESPONSE_TOO_LARGE` — the service answered with more than `GUEST_REQUEST_RESPONSE_MAX` bytes; it acted on the request, the answer is dropped whole
- Existing: `HOST_TIMEOUT`, `HOST_REJECTED`, `HOST_UNAVAILABLE`, `BAD_PATH`

Server routes (authenticated UI session):

- `POST /api/guests/:id/service/request`
- `GET /api/guests/:id/service/status`
- `PUT /api/guests/:id/capabilities` — `{ granted }`, the full requested list or `[]` to withdraw
- `PUT /api/guests/:id/service/sockets` — `{ id, path }` (`path` empty or null clears the override). Stops a running service so the next request respawns with the new env.

The panel never receives `OPENCHAMBER_SERVICE_TOKEN` and never dials the port itself. Opaque iframe origin stays. Only the host proxy talks to loopback.

VS Code and mobile stay `unsupported` for the guest catalog. They do not spawn services.

| Runtime | Extension services |
|---|---|
| Web | Supported on the connected OpenChamber server |
| Electron desktop | Supported through the connected OpenChamber server |
| VS Code | Unsupported; the extension catalog is unavailable |
| Hosted mobile | Unsupported; the extension catalog is unavailable |
| Capacitor mobile | Unsupported; the extension catalog is unavailable |

Services approved on a web or desktop instance continue on that server regardless of which clients are connected. Mobile clients do not expose extension setup.

## Service process contract

Env the host sets:

- `OPENCHAMBER_SERVICE_PORT` — port to bind on `127.0.0.1`
- `OPENCHAMBER_SERVICE_TOKEN` — shared secret
- `OPENCHAMBER_SERVICE_DATA_DIR` — this extension's own folder (`OPENCHAMBER_SERVICE_DATA_DIR` in `@openchamber/sdk` names the variable). The host creates it before the start. It survives restarts and updates and is deleted when the extension is removed. Keep the service's files here, never next to OpenChamber's own: the location of OpenChamber's data is not part of this contract
- `OPENCHAMBER_SERVICE_SOCKETS` — JSON map `{ [socketId]: absolutePath }` for every binding that resolved (override or first existing candidate)
- `OPENCHAMBER_HOST_CALLBACK_URL` — OpenChamber's callback listener: what a service calls on its own (*Calling OpenChamber*, below) and the requests the `source-control`, `notifications` and `tracker` roles send out
- `OPENCHAMBER_OPENCODE_URL` is the loopback read-only OpenCode connection for an approved `opencode` service. Authenticate with `OPENCHAMBER_SERVICE_TOKEN`; upstream credentials stay in the host.

Inbound auth: every request, including ready, must send:

```
Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>
```

Ready signal: host polls `GET /health` until HTTP 200 (15s timeout), then marks `ready`.

Listen only on `127.0.0.1`. Do not bind `0.0.0.0`.

Ship `service/main.js` already built. Same packaging rule as `panel/main.js`.

## Lifecycle

| Event | Host behavior |
|---|---|
| Install | Catalog row includes public `service` (`runtime`, `permissions`, `socketBindings`, `granted: false`) and `capabilities.requested` containing `service`. No spawn yet. |
| Approve | `PUT .../capabilities` writes `capabilityGrants[id]` in `extensions.json`; the list must equal what the package requests. |
| Socket override | `PUT .../service/sockets` writes `serviceSocketOverrides`. Running service for that guest stops. |
| First `serviceRequest` | Grant missing → `NO_SERVICE`. Else spawn with resolved sockets, wait for `/health`, proxy. |
| Panel open | Status via `serviceStatus`. Dead service restarts on the next `serviceRequest`. |
| Uninstall | SIGTERM, then kill after timeout. Clear grant and socket overrides. Path-install does not delete the user's folder. |
| Host quit | Kill every guest service. |
| Host crash | The service keeps running until the next host start, which stops it (SIGTERM, then kill after timeout) before spawning any service. |
| Crash | Status `failed`. Panel sees `SERVICE_FAILED` / status. Manual retry, not silent loops. |

## Security invariants

- Panel → host → service loopback only. No panel → socket.
- `serviceRequest` path must stay on that service (host-allocated port for that guest id).
- Every service requires an explicit grant before proxy.
- Permissions text is advisory. Phase 1 does not enforce an OS sandbox around those lists: an allowed service can run any command, use git, and read or write any file the user can. The approval dialog says so in plain words.

## Example

`examples/service-echo` is a checked-in service extension: a Node HTTP server on loopback that the panel calls through `serviceRequest` and whose status it shows. Bundle the service with `--node`, install the folder from Settings → Extensions, allow the local service in the approval dialog, then open the rail panel. Streaming from a service to the panel (shell into a container, log tails) is deferred; it needs a streaming call on the SDK first.

## Calling OpenChamber

`createServiceHost({ env: process.env })` is the service's way back. Every call is a `POST` to `SERVICE_HOST_PATH` on the callback listener with `OPENCHAMBER_SERVICE_TOKEN` as its bearer, which names the service. The catalog decides each call at that moment, so a paused extension or a withdrawn approval is refused whatever the process still holds. A refusal throws `ServiceHostError` with a `code`.

| Call | Needs | What it does |
|---|---|---|
| `sessions.start({ prompt, projectId?, directory?, title?, model?, variant?, agent? })` | `contributes.sessionControl` | Creates a session and sends it the prompt. Answers `{ sessionId, directory }` |
| `sessions.send(sessionId, prompt)` | `sessionControl` | Sends to a session. A form or page the agent waits on there is closed first, as when the user writes in the chat, so the message never waits behind it |
| `sessions.retry(sessionId)` | `sessionControl` | Sends the session's last message again, for a turn that failed |
| `sessions.status(sessionId)` | `sessionControl` | `idle`, `busy`, or `waiting` when only the user can move it on |
| `sessions.lastReply(sessionId)` | `sessionControl: { content: true }` | The agent's last answer, or `null` |
| `sessions.stop(sessionId)` | `sessionControl` | Stops the running turn, as the stop button does. Answers `{ stopped }`, false when nothing ran. The session reads `busy` for a moment after, and a stopped turn emits no `turn-finished` |
| `sessions.answerPermission(sessionId, requestId, { decision, message? })` | `sessionControl: { answers: true }` | Answers the request a `permission-asked` event names in `event.permission.requestId`. `allow` lets the agent do it this once; `deny` refuses, and `message` (up to `SERVICE_ANSWER_MESSAGE_MAX`, 2,000) reaches the agent as the reason. "Always allow" stays a click in the app |
| `sessions.answerForm(sessionId, formId, values, message?)` | `sessionControl: { answers: true }` | Answers the form a `question-asked` event names in `event.question.id` (`kind: "form"`). `values` are keyed by the field `key` from the event's content; a choice field takes an option's `value`. `null` dismisses the form and `message` tells the agent why. A `page` cannot be answered from a service: send to the session instead |
| `setInstructions(directory, text)` | `contributes.instructions` | Text the agent reads in every session under `directory`, or everywhere with `null`, up to `SERVICE_INSTRUCTIONS_MAX` (4096). Empty text removes it. It stays on the server, so no message waits on your process |
| `setMark(target, mark)` | `contributes.marks` | Puts one icon on the sidebar rows `target` names, in place of the one you set there before; `null` removes it. `target` is `{ sessionId }`, `{ directory, branch }` or `{ directory }`; `mark` is `{ icon, tone, text, url? }`. Answers `{ saved: true }`. See *Marks on sidebar rows* |
| `emit(topic, data?)` | nothing | Sends `data` to the extension's open frames, which hear it through `host.onServiceEvent`. Up to `SERVICE_EVENT_RATE_MAX` (30) a second and `SERVICE_EVENT_DATA_MAX` (64 000) characters of JSON. Nothing replays: a frame that opens later reads the current state from the service |
| `readSettings()` | nothing | The fields of `contributes.integration.settings`, the `secret` ones included |
| `needsConfiguration(message)` | nothing | Shows `message` on the extension's card until cleared with `null` |

A service sends at most 60 prompts an hour, counting starts, sends and retries, and sets its status at most 30 times a minute. Panel events stop at 30 a second and 256,000 characters a second. Marks change at most `SERVICE_MARK_RATE_MAX` (60) times a minute. Past a limit the call answers 429 and does nothing.

`sessionControl` shows in the approval dialog as its own line, and `content: true` adds `transcript`. `answers: true` adds `sessionAnswers`, a line of its own too: the service answers for the user in any session, so a messenger bridge can carry the agent's requests to the user and their decisions back. Hosts up to 2.6.1 refuse the key, so declare an `engines.openchamber` floor above it. An answer to a request that settled meanwhile, in the app or on another device, is a 404. A failed session call answers what the session service told the caller, never its internals.

## Marks on sidebar rows (`contributes.marks`)

`contributes.marks: true` lets the service put small icons on the rows of the sidebar: a red cross on the sessions of a branch whose checks fail, a robot on a session the extension started. It needs `contributes.service`, and the approval dialog shows it as its own line, "Show marks in the sidebar".

```ts
await host.setMark({ directory: '/repo', branch: 'feature/login' }, { icon: 'close-circle', tone: 'error', text: 'Checks failed' });
await host.setMark({ sessionId }, { icon: 'robot-2', tone: 'info', text: 'Started from the desk' });
await host.setMark({ sessionId }, null);
```

The target says which rows:

| Target | Rows |
|---|---|
| `{ sessionId }` | That session's row |
| `{ directory, branch }` | Every session on that branch of the repository `directory` belongs to, and the branch's worktree row. `directory` is any folder of the repository: the project root or any worktree. A row whose branch OpenChamber does not know yet shows no branch mark |
| `{ directory }` | The sessions in that folder, the sessions in the worktree at it, and that worktree's row |

The mark is drawn by OpenChamber from four values. `icon` is a Remixicon kebab name (`close-circle`), as in a status view; a name the app lacks draws a generic glyph. `tone` is `neutral`, `info`, `success`, `warning` or `error` and sets the colour from the theme. `text` is plain text for the tooltip, up to `SERVICE_MARK_TEXT_MAX` (200) characters, and OpenChamber puts the extension's name before it. `url` is an optional `https` address without credentials, up to `SERVICE_MARK_URL_MAX` (2,048) characters. A call with anything else is a 400 and sets nothing.

A click on a mark opens your panel in that row's session when the extension has a panel, and `url` is ignored then. Without a panel it opens `url` in the browser. With neither, the mark only has its tooltip.

One mark per target: setting a target again replaces its mark. When one row matches several of your targets, the session's mark shows before the branch's and the branch's before the folder's. A row draws at most two marks, one per extension in the order of the Extensions list, and its tooltip lists them all. On a one-line row the row's buttons cover the marks on hover, so a click reaches a mark on two-line rows and on touch screens.

A mark lives as long as your process. When the service stops, for any reason, its marks are gone, and the next process starts with none. Declare `service.keepRunning`, and set the marks again on start from your own state. OpenChamber does not check that a target exists: a mark for a deleted session shows nowhere and still counts.

You hold at most `SERVICE_MARKS_MAX` (200) marks; one more answers 409 `TOO_MANY_MARKS` until you remove one. Setting a mark to what it already is costs nothing and counts against no limit, so a service can set its marks on every check without comparing first.

VS Code, mobile and the rows of an isolated space show no marks. Marks ship in the first OpenChamber release after 2.7.0; an older host ignores the manifest key and refuses the call, so declare an `engines.openchamber` floor above 2.7.0.

## Running with nobody asking

A service starts on the first request and stops after ten idle minutes; the next request starts it again, so keep state in `OPENCHAMBER_SERVICE_DATA_DIR` or set `keepRunning`. Two manifest keys change that, and either one frees the service from needing a panel or background entry.

`service.keepRunning: true` starts the service when OpenChamber starts or the extension is approved, and holds it through every idle stop. A check every 15 s brings a stopped one back, and a process that keeps dying waits longer each time, up to five minutes. A service that needs outside events holds its own connection or polls; arbitrary inbound routes do not exist.

`service.schedule` posts `POST /schedule` (`SERVICE_SCHEDULE_PATH`) when an entry comes due, with five-field cron and the host's timezone unless `timezone` names one:

```json
{ "v": 1, "requestId": "…", "id": "nightly", "at": 1730000000000 }
```

Parse it with `readServiceScheduleRequest` (`null` → HTTP 400) and answer any 2xx within `SERVICE_SCHEDULE_TIMEOUT_MS` (10 s). A run is at most once: one missed while OpenChamber was down, or that the service failed to take, is gone. Without `keepRunning`, the service stops `SERVICE_SCHEDULE_IDLE_MS` (ten minutes) after its last run.

## Rows in the `@` menu (`contributes.mentions`)

`contributes.mentions: { label }` adds a section to the composer's `@` menu. OpenChamber posts `{ query, directory }` to `MENTIONS_SEARCH_PATH` as the user types and draws the rows you answer, `{ items: [{ id, title, subtitle?, url? }] }`, up to `MENTIONS_ITEMS_MAX` (20). A search has `MENTIONS_SEARCH_TIMEOUT_MS` (2 s); a slower or failing service adds nothing and never holds the files back.

When the user picks a row, OpenChamber posts `{ id }` to `MENTIONS_RESOLVE_PATH`, and `{ text }` (up to `MENTION_TEXT_MAX`, 16 000) becomes a chip whose text the agent reads with the message. A row that cannot be read leaves no chip and says so, since the message would otherwise go out without what the user chose. What the user types goes to your service, which the approval dialog says.

## Browser provider (`provides: ["browser"]`)

The host's `openchamber_web` tool gives agents twelve `browser.*` actions. By default a connected desktop app answers them with its browser panel; on a server with no desktop client the agent gets nothing. A service that declares `provides: ["browser"]` can answer instead, from a browser it runs itself (headless Chrome over CDP, for instance). The agent sees one tool either way.

The user picks the provider in Settings → General → OpenChamber Tools → Browser provider. The dropdown lists installed, enabled, fully approved extensions with the role; with none it shows only "OpenChamber Web", disabled. The choice is `browserProvider` in the instance's `settings.json` (`builtin` or the extension id) and is read on every action, so it applies to the next action without a restart. Pausing, removing, or withdrawing approval from the selected extension puts `builtin` back and every open client shows a toast saying so; the same happens on the next action if the extension became unusable any other way.

Lifecycle differs from a panel-driven service in two ways. The host starts the service on the first action, so the agent can browse with no panel and no viewer; the grant is the same one the user gave at install. After `BROWSER_PROVIDER_IDLE_MS` (ten minutes) without an action the host stops the process; the next action starts it again. A `browser.open` may take `BROWSER_PROVIDER_OPEN_TIMEOUT_MS` (45 s), every other action `BROWSER_PROVIDER_ACTION_TIMEOUT_MS` (20 s). Answers are read up to `BROWSER_PROVIDER_RESPONSE_MAX` (12 MB), enough for a screenshot.

### Wire

`POST /browser-control` on the service loopback, same bearer as every request, JSON body:

```json
{
  "requestId": "browser-…",
  "action": "browser.click",
  "parameters": { "selector": "#save" },
  "context": { "directory": "/Users/me/app", "sessionId": "ses_…" }
}
```

`readBrowserProviderRequest(body)` from `@openchamber/sdk` parses it (`null` → answer HTTP 400). The host validated `parameters` for the action before posting, so the service can trust the shape.

`context` says where the action came from: the project the agent works in and the chat it runs in. The host fills it from the tool call; the model never types it. A provider that keeps one browser per project or chat keys its targets on these; one that keeps a single browser ignores them. Either field is `null` when the host had none (an action sent from the CLI, for example); treat that as "unknown", not as a scope of its own. The shared surface is still one per service: if you keep several targets, choose which one the picture shows.

Answer HTTP 200 with one of:

```json
{ "ok": true, "data": { … } }
{ "ok": false, "error": "No element matches #save" }
```

`error` goes to the agent as the tool's error, so write it as what to do differently, not what broke inside. Any other status or shape is reported to the agent as "unknown page state".

### Actions

Parameters the host sends and `data` the service answers; types are exported from `@openchamber/sdk` (`BrowserOpenParameters`, `BrowserOpenData`, …). Every shape is what the desktop app's own panel answers, so an agent's prompt written against one works against the other.

| Action | Parameters | `data` |
|---|---|---|
| `browser.open` | `url` (absolute http/https), `viewport?` | `url`, `title`, `opened: true`, `settled` (`false` = still loading, not a failure), `viewport` |
| `browser.snapshot` | `selector?` (scope) | `url`, `title`, `scope`, `scrollY`, `maxScrollY`, `text`, `elements[]`, `viewport`, optional `textTruncated`/`textTotalChars`, `elementsTruncated`/`interactiveElementsOnPage`, `consoleProblems[]` |
| `browser.click` | `selector?` or `text?` (visible label) | `clicked` (selector), `label`, `url` |
| `browser.type` | `selector`, `value`, `submit` | `selector`, `url` |
| `browser.select` | `selector`, exactly one of `label` or `value` | `selector`, selected `label`, selected `value`, `url` |
| `browser.scroll` | `direction?` (`up`/`down`/`top`/`bottom`) or `selector?` | `scrollY`, `maxScrollY`, `atTop`, `atBottom`, optional `scrolledTo`/`direction` |
| `browser.back` / `browser.forward` | none | `url`, `title` |
| `browser.inspect` | `selector` | `selector`, `tag`, `label`, `bounds`, `inViewport`, `styles` (computed, as strings) |
| `browser.capture` | `label?` | `base64`, `mime`, `width`, `height`, `url`, `title`, `viewport`; the host writes the file into the project and returns its path |
| `browser.resize` | `viewport` (`mobile`/`tablet`/`desktop`/`fill`) | `viewport` |
| `browser.close` | none (see `tabId` below) | `closed: true`, optional `tabId`; a provider with a single page answers `ok: false` instead |

Every action may carry `tabId` (`BrowserTabTarget`): an id from the `tabs` your snapshot listed (`[{ id, title, url, active }]`, `active` being the tab the user sees), passed through from the agent untouched. Without it, act on the tab the user sees, except `browser.open`: without `tabId` it opens a new background tab and answers its id as `tabId` (`BrowserOpenData`), so the agent never replaces the user's page. Refuse an id you did not issue with `ok: false`; never act on another tab instead. A provider with one page lists no tabs and refuses every id. `browser.close` is the exception to "the tab the user sees": it closes a tab the agent opened, so without `tabId` it closes the one this caller opened most recently and refuses a tab it did not open.

`viewport` in answers is `{ mode, width, height }` (`mode` may be `custom`; `fill` has `null` sizes). Snapshot `elements` carry `selector`, `tag`, `bounds`, and only the fields that apply (`inViewport`, `type`, `role`, `label`, `disabled`, `missingAccessibleName`). Native `select` elements additionally carry `multiple` and an `options[]` list in DOM order. Each option has its live `label`, `value`, `selected`, and `disabled` state; the list is capped at 32 entries and each label/value at 80 characters. `optionsTruncated: true` means the list or one of its strings was capped. A selected option outside the cap is not moved into the returned prefix. Keep `text`, `elements`, and select options bounded yourself; report what was dropped with the truncation fields.

`browser.select` uses exact string matching. It targets native single-value HTML `<select>` elements, rejects custom controls and multiple selects, and refuses disabled selects or matching options. A missing or ambiguous label/value is an error, so the service must leave the page unchanged.

`examples/browser-provider-stub` is a checked-in provider with no browser: one in-memory page that answers every action. Install it to see the dropdown, the routing, and the idle stop before writing a real one.

## Source-control provider (`provides: ["source-control"]`)

A service with this role is a Git host next to GitHub, GitLab, Gitea and Gerrit: its own card in Settings → Integrations, its pull requests and issues on the board, its badges on branches, worktrees from its pull requests. The role needs `contributes.sourceControl` in the same manifest, and the manifest needs it only with the role; either alone fails as `invalid-service`. Hosts older than the role refuse the manifest the same way, so declare an `engines.openchamber` floor.

OpenChamber names the host `ext-<panel.id>` (provider ids are at most 32 characters, so `panel.id` is at most `SOURCE_CONTROL_GUEST_ID_MAX`, 28). The id stays the same across versions; accounts, bindings and mutation records are stored under it. `sourceControlProviderIdOf(guestId)` spells it.

### `contributes.sourceControl`

Declared in the manifest, not answered by the service: OpenChamber reads it to draw the card, route Git transport and recognise remotes without starting a process, and the approval dialog shows it. Every object is strict; an unknown key fails.

| Field | Contents |
|---|---|
| `wire` | `1` |
| `label` | Product name, 1–64 characters, shown untranslated |
| `terminology` | `{ changeRequest: "pullRequest" \| "mergeRequest" \| "change", ci: "checks" \| "pipeline" }` |
| `referencePrefix` | `{ changeRequest, issue }`, 1–4 characters each (`#`, `!`) |
| `repositoryPath` | `"owner/name"` or `"namespace/name"` (nested groups) |
| `instances` | `{ defaultInstances: up to 4 https origins, custom, allowLoopbackHttp, allowPort, placeholder }`. With `custom: false` the user can add only the default instances, and there must be at least one |
| `capabilities` | `projects`, `issues`, `changeRequests`, `draftChangeRequests`, `draftConversion?` (serves `/pr/draft`; absent means the route answers 501), `merge` (`false` or `{ methods: ["merge" \| "squash" \| "rebase" \| "submit"] }`, with `submit` the only method when present), `ci`, `comments`, `reviews`, `state`, `labels`, `reviewers`, `changeRequestPatch`, `liveSummaries`, `reviewModel?` (`"verdict"` by default, or `"votes"`), `revisions?`. One left out is off. Review threads, uploads, stacks, the reference picker, multiple accounts and how a change request is created are fixed by OpenChamber |
| `login` | Optional `{ kind: "service", hint }`. The service owns sign-in; `hint` is 1 to 2000 characters shown when this instance has no login. At least `login` or `token` is required |
| `token` | Optional `{ header: "authorization" \| "private-token", scheme: "bearer" \| "token" \| "basic" \| "none", username?, scopes, createPath? }`. `private-token` takes the bare token (`none`); `authorization` takes `Bearer`, `token` or `basic`. `basic` needs `username: true`, and `username: true` is refused with any other scheme |
| `transport` | `{ httpsUsername: { kind: "login" } \| { kind: "fixed", value }, appendDotGitToHttpsClone }`: how Git over HTTPS signs in with the stored token |
| `limits` | `{ commentMaxLength (≤ 1 000 000), reviewerId: "numeric" \| "login", labelsMax (≤ 100), reviewersMax (≤ 50) }` |
| `trackedItems` | `{ batchLimit }`, 1–50 items per `liveSummaries` call |
| `presentation` | `{ abbreviation (1–8), promptNoun, sharedNumberSpace, iconPath? (24×24 SVG path data), urls: { changeRequest[], issue[] }, features: { authorCanReview, issueEdit, changeRequestEdit, baseChange, updateBranch, issueCloseReason, rebase, submitRequirements? }, changeRequestTemplates[] }`. `issueCloseReason` and `rebase` are published as `false` whatever the manifest says: the standard routes carry neither a close reason nor a rebase, so a control for them would always fail |

`presentation.urls` are web path templates such as `/{owner}/{repo}/pulls/{number}`: `/`, then segments that are each a literal (`[A-Za-z0-9._~-]`) or one placeholder (`SOURCE_CONTROL_URL_TOKENS`). `{repo}` and `{number}` appear once, and the owner once as `{owner}` for `owner/name` paths or `{namespace+}` (one or more segments) for `namespace/name` paths. OpenChamber compiles them into the pattern that recognises a pasted link; an extension never supplies a regular expression. `changeRequestTemplates` are repository file paths (`.gitea/pull_request_template.md`), first match wins.

### Change-based hosts

A host that reviews one change at a time, with numbered revisions and per-label votes (Gerrit is the model), declares the fields below. Each is optional, and a manifest without them parses, installs and publishes exactly as before. Hosts older than these fields refuse a manifest that uses them as `invalid-service`, because every object is strict. Declare an `engines.openchamber` floor of the first release that has them, newer than 2.5.0.

| Field | Effect |
|---|---|
| `terminology.changeRequest: "change"` | The UI says "change" where other hosts say pull request or merge request |
| `capabilities.reviewModel: "votes"` | `/pr/review` takes `{ votes, body? }` instead of a verdict. `votes` maps a label name to an integer score. The labels, their ranges and the caller's permitted scores come with each change's context as `voteLabels`. A verdict sent to a votes host, or votes sent to a verdict host, is refused with a 400 before the service sees it |
| `capabilities.revisions: true` | `changeRequestContext`, `readChangeRequestPatch` and `readChangeRequestFile` may carry `revision`, a 40-hex commit sha, to read that revision. The context lists them as `revisions`, oldest first. Without the capability a read with `revision` is a 400 and never reaches the service |
| `capabilities.merge: { methods: ["submit"] }` | The merge button reads Submit. `/pr/merge` carries `{ method: "submit" }` |
| `presentation.features.submitRequirements: true` | The context carries `submitRequirements`, `[{ name, status, description? }]`, and the UI lists the unmet ones by the Submit button |
| `token: { header: "authorization", scheme: "basic", username: true }` | Settings asks for a username beside the token. The proxy sends `Authorization: Basic base64(<login>:<token>)` with the account's stored login. `auth.verify` goes out with the username the user typed; a login with a `:` or a control character is refused |

`changeRequestStatus` may add `localRevision: { sha, changeId, uploadedAs }` (the local tip, the change id in its commit message or `null`, the revision number it was uploaded as or `null`) and `stack: { number: null, base, layers }` with layers bottom first.

Creating a change by pushing to `refs/for/<branch>` stays host-only. An extension's host creates through `/pr/create`, and its change request heads are branches, so declare `changeRequests` only if the forge's API can open one. `auth.probe` never carries a token, with `basic` too: answer it from an anonymous request, or answer `{ supported: true }` when the instance refuses anonymous reads and let `auth.verify` decide.

The catalog row carries `toPublicSourceControl(contribution)`: `{ label, defaultInstances, custom }`, what the approval dialog shows.

### Service-owned sign-in

Declare `login: { kind: "service", hint: "Run forge auth login on the OpenChamber server" }` when the service uses an existing CLI login. Keep credentials in that CLI. OpenChamber calls `auth.status` with `session.instance` set to the exact normalized origin, `session.user: null`, an empty `input`, and a handle with no token or forge access. Return `{ user: null }` only when that instance has no login. A CLI with one login and no instance flag returns null for every other origin. A timeout, unavailable CLI or unreadable status is an error; it does not remove the account or its bindings.

Both `auth.verify` and `auth.status` return the same user DTO: `id` is a positive safe integer or a non-empty string of at most 256 characters, with `login` and optional `name`, `email`, `avatarUrl`. String IDs remain unchanged in storage and resource sessions, including numeric-looking strings beyond JavaScript's safe integer range. Compare identities with `String(current.id) === String(session.user.id)`; keep the original ID in the DTO without trimming or numeric conversion.

OpenChamber reuses its CLI account, `<instance>#cli:<user.id>`, without storing the account or a token. Each status and account resolution checks the service again. With login alone it is the current account; the Settings card shows its user or the hint and offers no token field or account-switch actions. With both login and token, the existing CLI activation and stored-token actions remain available. Declare known login origins in `instances.defaultInstances` so the host can discover them without a token connection.

Every resource call carries the verified `session.user`. Check the CLI identity before reading and again before returning the result. If it differs, discard the result and answer `{ ok: false, error: { code: "ACCOUNT_CHANGED", message: "The CLI account changed", status: 409 } }`. OpenChamber invalidates that exact account and its bindings. This code is trusted only on a service-login account's call; a service-reported 401 still requires proxy evidence on token accounts. No account-switch command or multi-account CLI is required.

The account's handles cannot reach the forge proxy. Read through the service's CLI and leave clone, fetch and push on system Git, `mode: 'system'`. OpenChamber never extracts a CLI credential or supplies this account as a managed HTTPS credential. A failed CLI mutation whose service was reached has an unknown outcome, because the proxy cannot observe its writes.

`login` and string IDs need OpenChamber 2.7.1 or newer: declare `engines.openchamber: ">=2.7.1"`. Older hosts reject the unknown `login` field.

### Lifecycle

OpenChamber registers the host when the extension is installed, enabled, approved for `service`, and declares the role; pausing, withdrawing approval, or an update without the role unregisters it, and its routes answer 404 until it comes back. Tokens stay through a pause; uninstalling forgets them. The service starts on the first call, not at registration, and stops after `SOURCE_CONTROL_PROVIDER_IDLE_MS` (ten minutes) without one. Every read starts a cold service at worst, so do not cache across calls: OpenChamber keeps its own status cache and drops it after each write.

### Calls

`POST /source-control` on the service loopback (`SOURCE_CONTROL_PROVIDER_PATH`), same bearer as every request:

```json
{
  "v": 1,
  "requestId": "scm-…",
  "method": "listIssues",
  "provider": "ext-teahouse",
  "session": { "instance": "https://git.example.com", "handle": "…", "user": { "id": 7, "login": "mona" } },
  "input": { "context": { … }, "directory": "/Users/me/app", "remote": "origin", "page": 1, "state": "open", "people": "any" }
}
```

`readSourceControlProviderRequest(body)` parses it (`null` → answer HTTP 400). `provider` is the id OpenChamber gave the host: put it in every DTO's `provider` field. `session.user` is `null` in `auth.verify`, `auth.probe` and `auth.status`, before an account exists. `input` per method is `SourceControlProviderInputs`; the reads take the route shell's own input, with `directory` and `remote` as OpenChamber resolved them and `context` the binding it validated.

Answer HTTP 200 with `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "message", "status"?, "code"? } }` (`message` ≤ 2000 characters, `status` 400–599, `code` `[A-Z_]{1,64}`). Any other status or shape is a malformed answer, never an empty one.

| Method | Answer OpenChamber checks |
|---|---|
| `auth.verify` | `{ user: { id, login, name?, email?, avatarUrl? } }`: who the candidate token belongs to; OpenChamber stores the account |
| `auth.probe` | `{ supported, version?, message? }`: whether the instance is this forge; the handle carries no token |
| `auth.status` | `{ user: { id, login, name?, email?, avatarUrl? } \| null }`: the service's current login for this exact instance; called only when `login` is declared, with no candidate token |
| `changeRequestStatus` | The branch's status as the badge shows it (`ChangeRequestStatus` in the UI): its open pull request, else its most recent closed or merged one, so a merged branch is not offered a new pull request |
| `listChangeRequests`, `changeRequestContext`, `listIssues`, `getIssue`, `issueComments`, `projectUpstream`, `projectBranches`, `listLabels`, `listReviewerCandidates` | A JSON object or array within `SOURCE_CONTROL_PROVIDER_RESPONSE_MAX`; the UI parses these DTOs itself |
| `readChangeRequestPatch` | `{ patch, meta: { owner, repo, number } }`: the change request's whole unified diff (`diff --git` per file) and the repository it was read from. Served to the Changes view and walkthroughs only when `capabilities.changeRequestPatch` is on. `sourceRepo`, when given, names the repository the change request lives in; read only within the bound repository's network |
| `readChangeRequestFile` | `{ original, modified }`: one file at the diff's base (the merge base) and at the head, for `path` (`previousPath` for the old side of a rename). `status` `A` has an empty `original`, `D` an empty `modified`. Same capability and network rule as the patch |
| `liveSummaries` | `{ summaries, issueSummaries }` for the refs asked; an item the forge cannot answer is left out, a 401 fails the batch |
| `readChangeRequestHead` | `{ project: { id, owner, name }, headSha (40 hex), headBranch, headOwner }` |
| `resolveChangeRequestSource` | `{ sourceProject, targetProject, classification, headSha, headRef, endpoint }`; OpenChamber checks the endpoint is on the instance and names `sourceProject`, and that the sha is the one it expected |
| `mutation.resolveTarget` | `{ providerTarget (≤ 4 KB JSON), target }`; `target` has exactly the keys OpenChamber stores and must match the context's target. On a replay, return `replayOf.target` unchanged |
| `mutation.perform` | Only the stored result keys (`number`, `merged`, `state`, `ready`, …) |
| `mutation.reconcile` | `{ state: "succeeded" \| "failed" \| "outcome-unknown", result? }`: after a restart, whether the write recorded as running landed |

A change request is in reach when the repository it targets is in the context's repository network (the primary remote's repository and its fork parent), as the built-in hosts do: refuse one whose target is outside it, and do not check where its head comes from. A maintainer's upstream clone reads, comments on, reviews and merges a contributor's fork pull request through the target repository, which the forge already authorises for the token. Creating one is the other direction: its `headRemote` must be in the network.

A capability opens the mutation routes below; one that is off answers 501 there and never reaches the service. `mutation.*` calls carry the route's `kind`, and its normalized `input` (without the digest). A service that cannot perform a kind its capabilities open should answer `UNSUPPORTED` (501), but the user then sees an action fail that the board offered, so implement every kind of every capability you turn on.

| Capability | Route | `kind` | Normalized `input` |
|---|---|---|---|
| `changeRequests` | `/pr/create` | `change-request-create` | `{ title, draft, body?, remote?, headRemote? }`. `remote` is where the pull request opens and `headRemote` where its head branch lives; either left out means the context's `primaryRemote`. A head on another remote is usually a fork: name its branch the way the forge expects (Gitea and GitHub take `owner:branch`) and refuse a remote that is not in the target's network |
| `changeRequests` | `/pr/update` | `change-request-update` | `{ title, body? }`: a new title, and a new body when given |
| `changeRequests` | `/pr/base` | `change-request-base` | `{ base }`: the new base branch, without `refs/heads/` |
| `changeRequests` | `/pr/update-branch` | `change-request-update-branch` | `{ expectedHeadSha }`: 40 lowercase hex, the head the caller read; refuse when the branch has moved |
| `changeRequests` | `/pr/subscription` | `change-request-subscription` | `{ subscribed }`: follow or unfollow |
| `issues` | `/issues/update` | `issue-update` | `{ title, body? }`: a new title, and a new body when given; an empty `body` clears it |
| `issues` | `/issues/subscription` | `issue-subscription` | `{ subscribed }`: follow or unfollow |
| `merge` | `/pr/merge` | `change-request-merge` | `{ method }`, one of the declared `merge.methods` |
| `draftChangeRequests` | `/pr/ready` | `change-request-ready` | `{}` |
| `draftConversion` | `/pr/draft` | `change-request-draft` | `{}` |
| `comments` | `/pr/comment`, `/issues/comment` | `change-request-comment`, `issue-comment` | `{ body }` |
| `comments` | `/pr/comment/update` | `change-request-comment-update` | `{ commentId, body }`: replaces one conversation comment's text |
| `comments` | `/pr/comment/delete` | `change-request-comment-delete` | `{ commentId }`: removes one conversation comment |
| `comments` | `/issues/comment/update` | `issue-comment-update` | `{ commentId, body }`: replaces one conversation comment's text |
| `comments` | `/issues/comment/delete` | `issue-comment-delete` | `{ commentId }`: removes one conversation comment |
| `state` | `/pr/state`, `/issues/state` | `change-request-state`, `issue-state` | `{ state }`: `open` or `closed` |
| `labels` | `/pr/labels`, `/issues/labels` | `change-request-labels`, `issue-labels` | `{ names }`: the whole set |
| `reviewers` | `/pr/reviewers` | `change-request-reviewers` | `{ names }`: the whole set, as `limits.reviewerId` spells them |
| `issues` | `/issues/assignees` | `issue-assignees` | `{ names }`: the whole set, as the ids `/references/reviewers` names candidates by |
| `reviews` | `/pr/review` | `change-request-review` | `{ verdict: "approve" \| "request-changes", body? }`, for the `headSha` in the target. With `reviewModel: "votes"`, `{ votes, body? }` instead |

Review threads, lock and rebase have routes too, but they stay off for an extension's Git host: the standard table carries no lock or rebase route, so `/pr/lock`, `/issues/lock` and `/pr/rebase` answer 501 whatever the manifest says.

Deadlines: `changeRequestStatus` 12 s (past it the last known status shows), other reads 20 s, mutation steps 30 s, `auth.*` 15 s (`sourceControlProviderTimeoutMs`).

OpenChamber decides what a failure means. A token-account mutation counts as definitely failed only when the service was never reached or every write the proxy saw got a 4xx; anything else is an unknown outcome to reconcile. Service-login mutations are described under *Service-owned sign-in*. A `status: 401` writes off the account only when OpenChamber's proxy saw the forge answer 401 on that call; a 401 the service reports on its own is a malformed answer.

### Reaching the forge

The service never holds a token. `createSourceControlForge({ env: process.env })` returns `{ request(handle, req) }`, which posts to `${OPENCHAMBER_HOST_CALLBACK_URL}/source-control/outbound` with `Authorization: Bearer <handle>`. The callback listener is shared with the `notifications` and `tracker` roles; each has its own route and handles.

- Request (`SourceControlOutboundRequest`): `{ method: GET|POST|PUT|PATCH|DELETE, path, query?, headers?, body? }`. `path` starts with one `/` and stays on the call's instance origin. `headers` (lower-case names) may be `accept`, `content-type`, `if-none-match` and `range`; OpenChamber sets the rest, the token included, per `token.header` and `token.scheme` (with `basic`, the account's login too). `body` is text up to `SOURCE_CONTROL_OUTBOUND_BODY_MAX` (1 MB).
- Answer: HTTP 200 with `{ status, headers, body }`, the forge's status (any, 401 included), the headers in `SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS` plus `x-ratelimit-*`, and the body as text up to `SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX` (8 MB). Redirects are not followed. `request` resolves with it.
- Refusal: any other status with `{ error: { message, code } }` (an expired or unknown handle, a path off the instance, a body too large). `request` throws `SourceControlForgeError` with that `code` and `status`; `HOST_UNAVAILABLE` when there was no usable answer.

A handle is minted for one call, carries `auth.verify`'s candidate token or the bound token account's token, and is revoked when the call ends. `auth.probe` carries none. `auth.status` and service-login accounts carry none and cannot send forge requests. Never store a handle.

This is least exposure, not a sandbox. OpenChamber keeps tokens because Git transport needs them anyway and the proxy is the one place origin pinning, enterprise policy and audit can act. An approved service still runs as the user and could read OpenChamber's files itself.

VS Code lists no Git hosts from extensions: the guest catalog is unsupported there.

`examples/source-control-provider` is a checked-in provider for a subset of Gitea's REST v1, with a fake forge its tests run against.

## Notification channel (`provides: ["notifications"]`)

A service with this role delivers the user's notifications, next to the desktop and the phone: Slack, Matrix, a phone automation, a receiver of your own. The role needs `contributes.notifications` in the same manifest, and the manifest needs it only with the role; either alone fails as `invalid-service`. OpenChamber names the channel `ext-<panel.id>` (so `panel.id` is at most `NOTIFICATIONS_GUEST_ID_MAX`, 28), draws its account card in Settings → Integrations from the contribution, and keeps the account: the user connects it there, the token stays in OpenChamber, and the service never sees it.

```json
"service": { "entry": "service/main.js", "runtime": "host", "provides": ["notifications"] },
"notifications": {
  "label": "Slack",
  "instances": { "kind": "fixed", "origin": "https://slack.com" },
  "token": { "header": "authorization", "scheme": "bearer", "scopes": ["chat:write"], "createPath": "/apps" }
}
```

| Field | Rules |
|---|---|
| `label` | The channel's name on its card, untranslated, 1 to 64 characters |
| `instances` | `{ kind: "fixed", origin }` when every account lives on one https origin (Slack); `{ kind: "user", label, placeholder? }` when the user types the server at connect (a Matrix homeserver). A typed server is an https origin, or http on this machine for a development receiver; paths, queries and credentials are refused, the service builds the paths |
| `token` | `{ header: "authorization" \| "private-token", scheme: "bearer" \| "token" \| "basic" \| "none", username?, scopes?, createPath? }`, the Git host's token block: `private-token` takes the bare token (`none`); `basic` needs `username: true`, which makes the card ask for a username beside the token |

Approving the extension and connecting an account is the whole switch: there is no setting for the channel on the Notifications page. A channel receives exactly the kinds the user's notification toggles let through (`GUEST_NOTIFICATION_KINDS`: `ready`, `error`, `question`, `permission`, `review`, `goal_complete`, `goal_blocked`, `goal_budget`), after the same debounces and suppressions, and only when no client is visible, unless the user chose to be notified always. Pausing the extension stops it; removing it forgets the account. In enterprise mode the channel gets the kind's generic title and no body, session name or directory, as the phone does, and the role installs only from an allowed repository like every service.

### Calls

OpenChamber posts `POST /notifications` (`NOTIFICATIONS_PROVIDER_PATH`) with the service bearer, one call at a time:

```json
{ "v": 1, "requestId": "…", "method": "notify", "provider": "ext-slack-bridge",
  "session": { "instance": "https://slack.com", "handle": "…", "account": { "id": "U123", "login": "mona" } },
  "input": { "notification": { "kind": "ready", "title": "…", "body": "…", "tag": "ready-ses_…", "at": 1730000000000,
             "sessionId": "ses_…", "sessionName": "Fix the parser", "directory": "/Users/me/repo", "url": "/?session=ses_…" } } }
```

| Method | Deadline | Answer `data` |
|---|---|---|
| `auth.probe` | 15 s | `{ supported, message? }`: whether `session.instance` is a server this channel delivers to. The handle carries no token; `account` is null |
| `auth.verify` | 15 s | `{ account: { id, login, name? } }`: who the candidate token belongs to; OpenChamber stores the account under `id`. The handle carries the token; `account` is null |
| `notify` | 10 s | `{ delivered: true }` once the notification is on its way. The handle carries the account's token |

Parse the body with `readNotificationsProviderRequest` (`NotificationsProviderRequest`; `null` → HTTP 400) and answer HTTP 200 `{ ok: true, data }` or `{ ok: false, error: { message, status?, code? } }` (`NotificationsProviderResult`). OpenChamber checks answers with `notificationsProviderSchemasV1`; one that does not parse is a failed delivery, never a delivered one. A `status: 401` writes the account off (the card says it needs attention until the user connects again) only when OpenChamber's proxy saw the server answer 401 through the call's handle; a 401 the service reports on its own is a malformed answer.

### Reaching the server

The service never holds a token. `createNotificationsOutbound({ env: process.env })` returns `{ request(handle, req) }`, which posts to `${OPENCHAMBER_HOST_CALLBACK_URL}/notifications/outbound` with `Authorization: Bearer <handle>`; `req` is `{ method, path, query?, headers?, body? }`, `path` on the account's instance origin, `headers` limited to `accept`, `content-type`, `if-none-match` and `range`, the body up to 1 MB. OpenChamber adds the token per `token.header` and `token.scheme` (with `basic`, the account's login too), keeps the request on the origin, and relays `{ status, headers, body }`. A refusal (an expired handle, a path off the origin) is a `NotificationsOutboundError`. The handle ends with the call; never store it.

Delivery is at most once: a failed `notify` (a timeout, a non-200, `ok: false`, a body that does not parse) is logged once a minute per channel and never retried. OpenChamber never logs a notification's text. The service runs on demand and stops after `NOTIFICATIONS_PROVIDER_IDLE_MS` (ten minutes) without a call.

Authentication and notification calls share one ordered queue per channel, capped at 200 outstanding calls. New calls beyond the cap are dropped with a rate-limited warning for notifications or a busy error for Connect. Pausing the extension cancels its in-flight call and drops queued calls. Disconnect supersedes an earlier pending Connect; a delayed 401 can invalidate only the account used by that call. Enterprise mode is checked again immediately before sending, including for notifications that were queued before it was enabled.

`examples/notification-webhook` is the reference: a channel that posts every notification to a receiver the user names, with the receiver to try it against.

## Tracker (`provides: ["tracker"]`)

A service with this role is a work item tracker next to Linear: YouTrack, Jira, Plane, a tracker of your own. Its items appear wherever Linear's do: the picker and the composer chips, New Worktree, the linked items of a session, the live states of tracked items, and the account card in Settings → Integrations under Extension accounts. The role needs `contributes.tracker` in the same manifest, and the manifest needs it only with the role; either alone fails as `invalid-service`. OpenChamber names the tracker `ext-<panel.id>` (so `panel.id` is at most `TRACKER_GUEST_ID_MAX`, 28), lists it from the contribution without starting the service, and keeps the accounts: the user connects them on the card, tokens stay in OpenChamber, and the service never sees one.

```json
"service": { "entry": "service/main.js", "runtime": "host", "provides": ["tracker"] },
"tracker": {
  "wire": 1,
  "label": "YouTrack",
  "instances": { "kind": "user", "label": "Server address", "placeholder": "https://youtrack.example.com" },
  "auth": {
    "token": { "header": "authorization", "scheme": "bearer", "createPath": "/users/me?tab=account-security" },
    "oauth": { "authorizeUrl": "/hub/api/rest/oauth2/auth", "tokenUrl": "/hub/api/rest/oauth2/token", "scopes": ["YouTrack"] }
  },
  "capabilities": { "stateUpdate": true, "labels": true, "priority": true, "filters": { "people": true }, "projectMapping": true, "sessionComments": true },
  "stateFilters": ["open", "all", "todo", "in-progress", "done", "inReview"],
  "identifier": "key-number",
  "urls": { "item": ["/issue/{id}", "/{segments+}/issue/{id}", "/agiles/{segment}/current?issue={id}"] }
}
```

| Field | Rules |
|---|---|
| `wire` | `1` |
| `label` | The tracker's name on its card and in the picker, untranslated, 1 to 64 characters |
| `instances` | `{ kind: "fixed", origin }` when every account lives on one https origin; `{ kind: "user", label, placeholder? }` when the user types the server at connect (a self-hosted server, a per-company site). A typed server is an https origin, or http on this machine for a development server; paths, queries and credentials are refused, the service builds the paths. The accounts of one tracker live on one server; the API and the item pages share that origin |
| `auth` | `token`, `oauth`, or both. `token` is the Git host's token block (`header`, `scheme`, `username?` with `basic`, `scopes?`, `createPath?`). `oauth` is `{ authorizeUrl, tokenUrl, scopes? }`: https URLs, or paths on the instance for a `user` tracker; OpenChamber runs PKCE S256 with a client id (and secret) the user enters on the card, and keeps the tokens |
| `capabilities` | Flags, each off when left out: `multipleAccounts`, `stateUpdate` (also `states.list`), `children`, `labels`, `priority`, `filters.people`, `filters.priority`, `projectMapping` (also `containers.list`), `sessionComments` (also `comments.create`). Host access for SDK guests is not declared: the host keeps it off, because the service itself never sees a token |
| `stateFilters` | In menu order, 2 to 16 unique ids: `open`, `all`, then the neutral categories you answer (`triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled`) and your own ids (`inReview`, `^[a-z][a-zA-Z0-9-]{0,31}$`). What `items.list` is asked for |
| `identifier` | The shape of an item's key: `key-number` (`PROJ-42`), `number` (`123`), `short-code` (letters and digits). OpenChamber compares identifiers case-insensitively everywhere and sends them upper-cased |
| `urls.item` | 1 to 8 link templates: `/`, segments that are each a literal (`[A-Za-z0-9._~-]`) or a placeholder of `TRACKER_URL_TOKENS` (`{id}` the identifier, `{segment}` any one segment, `{segments+}` one or more, at most once), and optionally `?name={id}` when the identifier travels in the query. `{id}` once per template, in the path or the query. OpenChamber compiles them against the instance into the pattern that recognises a pasted link, on the server and in every client; an extension never supplies a regular expression |

What the user sees: the card under Extension accounts asks for the server address first when `instances.kind` is `user`, then offers the ways in you declared: a token field (and a username for `basic`) with a link to `createPath`, and, for `oauth`, the client id and secret fields with the redirect URL to register, then a browser sign-in. Connected accounts, switching between them (`multipleAccounts`), project mapping (`projectMapping`) and the session comments switch (`sessionComments`) follow the capabilities. An extension without `contributes.integration` gets the tracker's account through `host.onConnection` in its frames: `connected`, and the account's name in `account`. It reads as not connected until OpenChamber has read the status. Pausing the extension takes the tracker out of every surface and keeps the accounts; removing it forgets them. In enterprise mode the role installs only from an allowed repository like every service; its reads carry no conversation content and its comments carry a fixed label and a session link, so nothing else is stripped.

### Calls

OpenChamber posts `POST /tracker` (`TRACKER_PROVIDER_PATH`) with the service bearer. Reads may overlap, since the picker, the preview and the board read at once; each call carries its own handle.

```json
{ "v": 1, "requestId": "…", "method": "items.list", "provider": "ext-youtrack",
  "session": { "instance": "https://youtrack.example.com", "handle": "…", "account": { "id": "u-1", "login": "mona" } },
  "input": { "query": "login", "state": "todo", "people": "me", "priority": "all", "containerId": null } }
```

| Method | Deadline | `input` | Answer `data` |
|---|---|---|---|
| `auth.probe` | 15 s | `{}` | `{ supported, message? }`: whether `session.instance` is a server this tracker works with. The handle carries no credential; `account` is null |
| `auth.verify` | 15 s | `{}` | `{ account: { id, login, name?, avatarUrl? } }`: who the credential belongs to (a pasted token, or the OAuth bearer OpenChamber minted). OpenChamber stores the account under `id`. `account` is null |
| `items.list` | 20 s | `{ query?, cursor?, state, people, priority, containerId }` | `{ items, cursor, hasMore }`: up to `TRACKER_PROVIDER_LIST_MAX` (100) `TrackerProviderItemSummary`, an opaque cursor for the next page or null. A query that is a link your templates claim, or an identifier of your declared shape, is read through `items.get` first and answered as a page of one; a bare word of your identifier shape that `items.get` answers null for reaches `items.list` as a search after all |
| `items.get` | 20 s | `{ id }` | `{ item }`: a `TrackerProviderItem` with description, comments, children, or null for an unknown id. `id` is an item's `id` as you answered it, or its identifier (`PROJ-1`, upper-cased) when OpenChamber resolves a pasted link or key; answer both |
| `items.updateState` | 30 s | `{ id, stateId }` | `{ item }` after the change. A write: the handle may send `POST`, `PUT`, `PATCH`, `DELETE` |
| `items.liveSummaries` | 20 s | `{ identifiers }` (up to 50) | `{ items: [{ identifier, title, state: { name, category } }] }`; identifiers you do not know are left out |
| `states.list` | 20 s | `{ containerId }` | `{ states: [{ id, name, category, position }] }` |
| `containers.list` | 20 s | `{}` | `{ containers: [{ id, key, name }] }`: the projects, teams or spaces items belong to, for project mapping |
| `comments.create` | 30 s | `{ identifier, body }` | `{ comment: { id } }`, or `{ comment: null }` for an unknown identifier. A write. `body` is Markdown OpenChamber wrote: `[OpenChamber session completed](https://…/?session=…)` |

Items answer in the neutral shapes without `provider`; OpenChamber adds it. An item's `url` is an absolute http(s) URL. `state.category` is one of the six categories or null; `priority` one of `none`, `urgent`, `high`, `medium`, `low`. Parse the body with `readTrackerProviderRequest` (`TrackerProviderRequest`; `null` → HTTP 400) and answer HTTP 200 `{ ok: true, data }` or `{ ok: false, error: { message, status?, code? } }` (`TrackerProviderResult`). OpenChamber checks answers with `trackerProviderSchemasV1`, bounded in count and length; one that does not parse is `502 MALFORMED_PROVIDER_RESPONSE`, never an empty list. A `status: 401` writes the account off (the card says it needs attention until the user connects again) only when OpenChamber's proxy saw the server answer 401 through the call's handle; a 401 the service reports on its own is a malformed answer.

### Reaching the server

The service never holds a credential. `createTrackerOutbound({ env: process.env })` returns `{ request(handle, req) }`, which posts to `${OPENCHAMBER_HOST_CALLBACK_URL}/tracker/outbound` with `Authorization: Bearer <handle>`; `req` is `{ method, path, query?, headers?, body? }`, `path` on the account's instance origin, `headers` limited to `accept`, `content-type`, `if-none-match` and `range`, the body up to 1 MB. OpenChamber adds the credential (the token per `auth.token`, or `Bearer <access token>` for OAuth, renewed before it lapses), keeps the request on the origin, and relays `{ status, headers, body }`. A read's handle sends `GET` only; a write through it is refused with 403 `METHOD_NOT_ALLOWED`. A refusal is a `TrackerOutboundError`. The handle ends with the call; never store it.

Session comments: when the user turns them on, OpenChamber posts `started` when a session starts from one of your items, then `completed` or `failed` once each when that session's turn ends or fails, each through `comments.create`, with a link only to an origin other people can open. The service runs on demand and stops after `TRACKER_PROVIDER_IDLE_MS` (ten minutes) without a call.

`examples/tracker-provider` is the reference: a tracker over a fake server you run beside it, run by `scripts/tracker-provider-example.test.ts`.

## Usage provider (`provides: ["quota"]`)

A service with this role reports usage next to the built-in providers: a provider OpenChamber does not read itself, or one of the extension's own. The role needs `contributes.quota` in the same manifest, and the manifest needs it only with the role; either alone fails as `invalid-service`. OpenChamber names the provider `ext-<panel.id>` (so `panel.id` is at most `QUOTA_GUEST_ID_MAX`, 28), draws its card with the extension's name and icon after the built-ins on the Usage page, in the header, in Work Status, on the phone and in the desktop tray, and asks the service for usage the way it asks a built-in.

```json
"service": { "entry": "service/main.js", "runtime": "host", "provides": ["quota"] },
"quota": { "providers": ["openrouter", "deepinfra"] }
```

| Field | Rules |
|---|---|
| `providers` | Up to `QUOTA_PROVIDERS_MAX` (16) unique OpenCode provider ids (`OPENCODE_PROVIDER_ID`: lowercase letters and digits, then `.`, `_` and `-`), the keys of OpenCode's credential store (`openrouter`, `zai-coding-plan`). Checked by shape alone: a credential can arrive after install, and one OpenCode does not hold is the "not configured" state the card already draws. May be empty, for a provider whose key lives in the extension's own settings |

What the user sees: the approval dialog lists the providers and says the extension receives the credential OpenCode holds for each of them and nothing else; a version that adds or drops one asks again, like a new capability. The card is configured when OpenCode holds at least one listed credential, and always when the list is empty. Pausing the extension takes the card away and keeps the user's Usage settings for it; removing it takes the card away. In enterprise mode the role installs only from an allowed repository like every service, and it receives no conversation content. VS Code loads no extensions and shows no such card; the phone shows the card and sets nothing up; a session inside an isolated space reads usage from that space's own server, which has no extensions.

### Calls

OpenChamber posts `POST /quota` (`QUOTA_PROVIDER_PATH`) with the service bearer, one call per refresh of the card; concurrent refreshes share one call, as they do for a built-in.

```json
{ "v": 1, "requestId": "…", "method": "usage.read", "provider": "ext-openrouter-usage",
  "input": { "credentials": { "openrouter": { "type": "api", "key": "sk-or-…" } } } }
```

| Method | Deadline | `input` | Answer `data` |
|---|---|---|---|
| `usage.read` | 20 s | `{ credentials }`: the credential OpenCode holds for each listed provider, keyed by provider id, as OpenCode stores it (`QuotaProviderCredential`: `{ type: "api", key }`, or `{ type: "oauth", access, refresh, expires, … }` for a browser login); a listed provider OpenCode holds nothing for is absent | `QuotaProviderUsageData`: the result a built-in computes, `ok`, `configured`, `error?`, `planLabel?`, and `usage` with `windows` keyed by name (`5h`, `weekly`, `credits_balance`), each `{ usedPercent, windowSeconds?, resetAt?, valueLabel?, value?, creditsUsed? }`, plus `models` for per-model windows |

A listed provider OpenCode holds no credential for is answered as not configured by OpenChamber itself; the service is not called. OpenChamber refreshes no login for the service: an expired one is the service's to report in `error`, as a built-in reports it. `configured: false` draws the card's "not configured" state, which points at the Providers page, so answer it only when a listed OpenCode credential is what is missing; a key of the extension's own that is missing is `configured: true` with an `error` that says where to enter it.

Parse the body with `readQuotaProviderRequest` (`QuotaProviderRequest`; `null` → HTTP 400) and answer HTTP 200 `{ ok: true, data }` or `{ ok: false, error: { message, status?, code? } }` (`QuotaProviderResult`); the envelope's `ok: false` is for a call the service could not handle at all, and its message reaches the card as the error. OpenChamber checks `data` with `quotaProviderSchemasV1`, bounded in count and length (32 windows, 64 models); an answer that does not parse is `502 MALFORMED_PROVIDER_RESPONSE`, never an empty result, and the card keeps its last reading with the failure beside it. OpenChamber adds the provider id, the name and the time of the read, and derives each window's remaining share, reset countdown and formatted strings (`toUsageWindow`), so the card matches a built-in's field for field. The service runs on demand and stops after `QUOTA_PROVIDER_IDLE_MS` (ten minutes) without a call; the Usage page refreshes every three minutes while open, so the service stays up while someone watches.

The service reaches its provider's API itself with the credential it was handed. Quota requests use no outbound proxy. The user approved exactly which credentials cross in the dialog.

`examples/quota-provider` is the reference: a provider over a fake usage API you run beside it, run by `scripts/quota-provider-example.test.ts`.

## OpenCode access

A service with `provides: ["opencode"]` reads from the OpenCode server the host is currently using. The role adds the implicit `opencode` capability alongside `service`, and the user must approve both. Do not put `opencode` in `contributes.capabilities`.

The access is read-only, and the host enforces it on every request. Sessions and messages hold what was said in them, including anything pasted there, so approve it only for a service you trust with that. Enterprise extension policy, including `allowedExtensions`, applies to this capability.

This example is a `contributes` block:

```json
{
  "panel": { "id": "opencode-reader", "name": "OpenCode reader", "icon": "apps", "entry": "panel/index.html" },
  "service": { "entry": "service/main.js", "runtime": "host", "provides": ["opencode"] }
}
```

The panel can start the service through `serviceRequest`. A service-only declaration can omit `panel.entry` and combine the role with host-driven contributions such as `sessionEvents`. The `opencode` role alone schedules no calls.

### What a service can read

| Request | Returns |
| --- | --- |
| `GET /api/session` | Sessions, with OpenCode's filters and paging, such as `parentID` for a session's subagents |
| `GET /api/session/active` | Sessions running right now |
| `GET /api/session/<sessionID>` | One session |
| `GET /api/session/<sessionID>/message` | A session's messages, with tool calls |
| `GET /api/session/<sessionID>/message/<messageID>` | One message |
| `GET /api/project` | Projects |
| `GET /api/event` | Live events as SSE, with `types` to pick them |

Everything else answers 403 with code `NOT_A_LISTED_READ` and never reaches OpenCode: writes, prompts, configuration, plugin RPC, the server's own details, reads scoped to a directory, and any route OpenCode adds later. Those directory reads are left out on purpose, because each one starts that directory's MCP servers.

### Client setup

The host provides `OPENCHAMBER_OPENCODE_URL`, a loopback address, when the approved service starts. Use the existing service token as its bearer. The host does not put the upstream address or its authentication in the service environment.

```ts
import { OpenCode } from '@opencode/client';

if (!process.env.OPENCHAMBER_OPENCODE_URL || !process.env.OPENCHAMBER_SERVICE_TOKEN) {
  throw new Error('OpenChamber OpenCode access is unavailable');
}

const client = OpenCode.make({
  baseUrl: process.env.OPENCHAMBER_OPENCODE_URL,
  headers: { Authorization: `Bearer ${process.env.OPENCHAMBER_SERVICE_TOKEN}` },
});

const sessions = await client.session.list();
```

Missing environment variables are a failure. Do not discover or start another OpenCode server as a fallback.

Requests carry only the path, the query and `Accept`. Each request goes to the OpenCode selected when it arrives and makes one upstream request. Redirects are not followed. Responses keep OpenCode's HTTP status and body, with no extra envelope. WebSockets are unsupported.

### Lifetime and failures

The authorization lasts for the service process, so it works between host calls and after a service response completes. Keep the URL and token inside the service; never pass them to the panel. Service stop, process exit, pause, removal, package update, approval withdrawal and host shutdown revoke access and abort reads in flight, the event stream included. A restarted service receives its environment from the host again.

When the host moves to another OpenCode, new requests go there and a stream still open ends without delivering anything more from the old server. Reconnect to follow the new one. Requests are not an atomic snapshot across such a move.

The host rechecks approval and extension policy on every request and on every chunk of a response, so a stream closes at its next chunk once approval is gone, an administrator's policy change included. Missing or revoked authorization, unlisted requests and an unavailable OpenCode fail explicitly. OpenCode's HTTP failures keep their status and body; a stream failure after headers closes the stream. No failure becomes an empty successful response.

Each response, the event stream included, is limited to `GUEST_REQUEST_RESPONSE_MAX` bytes, so a long-lived event subscription has to reconnect. OpenCode inactivity is limited to `GUEST_REQUEST_TIMEOUT_MS`. Exceeding either limit terminates the transfer.

Web and Electron desktop use the connected OpenChamber backend in direct and relay modes. The connection stays on loopback between that backend and its service and is unavailable through UI APIs, relay routes or tunnels. VS Code, hosted mobile and Capacitor mobile keep the guest catalog unsupported.

## Session events (`contributes.sessionEvents`)

A service can be told what happens in the user's sessions without a window being open. Declare which events it wants next to the service:

```json
"service": { "entry": "service/main.js", "runtime": "host" },
"sessionEvents": { "events": ["turn-finished", "question-asked"], "content": true }
```

`events` lists 1 to 8 distinct types:

| Type | When |
|---|---|
| `turn-finished` | The session went idle with nothing waiting: no running subagent, no open permission, form or page, no goal or auto-review step still driving it. A turn the user stopped emits nothing |
| `turn-failed` | The turn ended in an error |
| `permission-asked` | The agent asked a permission the user has to answer: sent 500 ms after the ask, only when it is still open and not answered by the session's own policy |
| `question-asked` | The agent asked the user a question, through a form or a page it shows and waits on. An MCP elicitation, which belongs to no session, is not sent |
| `turn-started` | The session began a turn: once per turn, however often its status repeats |
| `session-created` | A session was created, a subagent's included (`session.parentId` is set) |
| `session-archived` | The session was archived |
| `session-deleted` | The session was deleted |

`sessionEvents` needs `contributes.service` (`invalid-session-events` otherwise) and, like a role, lets the service go without a panel or background entry. Hosts older than this feature drop the key at parse and send nothing, so declare an `engines.openchamber` floor.

Approving the package is the subscription: the dialog lists the events under the service line. With `content: true` the manifest also asks for the `transcript` capability, shown as a line of its own, and the service receives what the agent said or asked; without it, identifiers only. The grant scope records the event list and the content flag, so a version that adds a type or starts asking for content shows Needs approval and receives nothing until the user approves again. In enterprise mode `transcript` is gated with `service`.

### Wire

OpenChamber posts `POST /session-events` (`SESSION_EVENTS_PATH`) with the service bearer, one request per event per subscribed service. The body is a `GuestSessionEventRequest`:

```json
{
  "v": 1,
  "requestId": "…",
  "event": {
    "id": "evt_…", "type": "turn-finished", "at": 1730000000000,
    "session": { "id": "ses_…", "parentId": null },
    "project": { "directory": "/Users/me/repo" },
    "linked": [{ "id": "linear:OPE-367", "kind": "linear", "url": "https://…", "provider": "linear", "identifier": "OPE-367" }],
    "permission": { "requestId": "perm_…" },
    "question": { "kind": "form", "id": "frm_…" }
  },
  "content": { "type": "turn-finished", "sessionTitle": "Fix the parser", "reply": "Done. …", "replyTruncated": false }
}
```

- `event.id` is OpenCode's event id (or one OpenChamber made for an event it synthesized), `at` epoch milliseconds, `session.parentId` set for a subagent's session, `project.directory` the session's directory or `null` when OpenChamber does not know it. `linked` is what the user attached to the session: ids, kinds, urls, the tracker's `provider` and `identifier`, a Git host's `number`, never a title. `permission` comes with `permission-asked` only, `question` (`kind` `form` or `page`, and its `id`) with `question-asked` only.
- `content` comes only with the `transcript` grant, typed by `type`: the four session types carry `sessionTitle`; `turn-finished` carries `sessionTitle`, `reply` (cut at `SESSION_EVENT_REPLY_MAX`, 64 000 characters, with `replyTruncated`); `turn-failed` carries `error { type, message }` and no reply; `permission-asked` carries `action`, `resources`, `message`; `question-asked` carries `ask`, a form (`id`, `title`, `fields`) or a page (`id`, `title`). Each field (`GuestFormField`) has `key`, `type` (`string`, `number`, `integer`, `boolean`, `multiselect` or `external`, a link only the user can open), `title`, `description`, `required`, and for a choice its `options[{ value, label }]`, with `custom` on a multiselect that takes values of its own, and `when` on a field asked only when earlier answers match (`[{ key, op: "eq" | "neq", value }]`, all of them). A field the form hides from the user is left out. `sessions.answerForm` builds the reply the way the chat's form card does: a field you leave out takes its default, and a value for a field whose `when` does not hold is dropped.
- Parse the body with `readSessionEventRequest` (zod-free; `null` is a body that is not a session event of this wire version, answer HTTP 400) and answer HTTP 200 `{ "ok": true }` once the event is taken, or `{ "ok": false, "error": "…" }` (`GuestSessionEventResult`, `error` up to `SESSION_EVENT_ERROR_MAX`). OpenChamber parses the answer with `sessionEventResultSchema`; anything else is a failed delivery.

### Delivery

- Host sessions in every project are sent, each with its directory. Sessions inside isolated spaces are not delivered to extensions yet. Which projects an extension acts on is its own choice: compare `event.project.directory` with your own settings and answer `{ ok: true }` for the rest.
- The first event starts the service; `SESSION_EVENTS_IDLE_MS` (ten minutes) without one stops it, and the next event starts it again. Events that arrive while it starts wait, at most `SESSION_EVENT_PENDING_MAX` (200), newer ones dropped with one warning.
- Event preparation also admits at most one oldest event and `SESSION_EVENT_PENDING_MAX` later events before starting reads. Excess announcements are dropped, while open asks and their answers remain tracked. Shutdown discards prepared events and prevents further reads.
- One request in flight per service, in order. A delivery has `SESSION_EVENT_TIMEOUT_MS` (10 s). A failed delivery (a timeout, a non-200 status, `ok: false`, a body that does not parse) drops that service's events for the next 30 s and logs the `error` text; OpenChamber never logs an event's content.
- At most once, with no persistence: an event that happened while OpenChamber was down, while the extension was paused, or during that backoff is gone. A paused extension, a withdrawn approval and a removal drop what waited for them.
- Two idle events for one turn end (OpenCode announces it twice) are one `turn-finished`.
- Session events alone grant no OpenCode access. A service with the separately approved `opencode` role can read through its own connection during event handling and between events, under the [OpenCode access](#opencode-access) contract.

`examples/session-events-log` is the reference: a service-only extension that journals every event to a file.

## Waits (`contributes.waits`)

A service can offer agents things to wait on without holding a turn open: a deploy that finishes, a URL that comes up, a timer. The agent starts a wait with the `openchamber` tool's `wait.start`, ends its turn, and OpenChamber wakes its session with one message when the service says the wait fired. It asks for less than `sessionControl`: the service never sends to a session itself, and OpenChamber writes only to the session that started the wait, once. It has its own capability, `wake`.

```json
"service": { "entry": "service/main.js", "runtime": "host" },
"waits": [
  { "id": "timer", "title": "Timer", "description": "Wakes the session once the given number of seconds has passed",
    "params": { "seconds": { "type": "number", "required": true } }, "interval": 10000 }
]
```

| Field | Rule |
|---|---|
| `id` | Kebab-case, unique in the package, at most 32 characters. The agent names it as `<panel.id>/<id>` |
| `title` | 1 to 40 characters; the approval dialog lists it and the wake message names it |
| `description` | 1 to 200 characters, written for the agent: when the wait fires |
| `params` | Up to 8 flat arguments, each `{ type: "string" \| "number" \| "boolean", description?, required?: true }`. OpenChamber checks the agent's arguments against them before your service sees a request |
| `interval` | Milliseconds between two checks, 10 000 to 3 600 000; default 30 000 |

`waits` needs `contributes.service` (`invalid-waits` otherwise) and, like session events, lets the service go without a panel or background entry. Declaring any asks for the `wake` capability, shown as a line of its own with the wait titles under it. Its grant scope is the sorted list of wait ids, so a version that adds a wait is unapproved until the user approves again. Hosts up to 2.7.0 drop the key at parse, so a service with nothing else to start it fails there as `invalid-panel`; declare `engines.openchamber: ">=2.7.1"`.

### Wire

Both requests are `POST` with the service bearer. Parse them with `readWaitStartRequest` and `readWaitCheckRequest` (zod-free; `null` is a body of another version, answer HTTP 400), and answer HTTP 200 with JSON.

| Route | Body | Answer |
|---|---|---|
| `/waits/start` (`WAITS_START_PATH`) | `{ v: 1, requestId, wait: { id, type, args, session: { id, directory } } }` | `{ ok: true, state?, label? }` takes the wait; `{ ok: false, error }` refuses it, and the agent's call fails with `error` |
| `/waits/check` (`WAITS_CHECK_PATH`) | `{ v: 1, requestId, waits: [{ id, type, args, state }] }`, the due waits of one type, at most 50 | `{ results: [{ id, fired: false, state? } \| { id, fired: true, summary }] }`. A wait left out keeps waiting unchanged |

- `state` is any JSON up to 4 096 characters; OpenChamber stores it and posts it back on the next check, so the service needs no storage of its own and may stop between checks. `label` (up to 80, cut it yourself: a longer one refuses the wait) names the wait next to its title: the deploy, the URL.
- `summary` (1 to 2 000 characters) is what the agent reads when it wakes. OpenChamber removes `<` and `>` from it and wraps it in an envelope that names your extension, so write it as a report of what happened, never as instructions.
- An answer whose `results` envelope does not parse, a non-200 status, or no answer is a failed check: nothing fires and nothing changes, and OpenChamber asks that type again after its interval doubled per failure, up to ten minutes. A wait whose every check failed for six hours ends with a wake that says so.
- Inside a good envelope each entry is read on its own. An entry that breaks the limits, such as a `state` over 4 096 characters or a `summary` over 2 000, ends that wait with a wake saying OpenChamber could not read it; the other entries are applied.
- Each request has `WAIT_REQUEST_TIMEOUT_MS` (10 s). Requests go through the same proxy as `serviceRequest`, so the service starts on the first one and stops ten minutes after the last.

### Delivery

- One wake ends the wait. The agent starts another when it needs to wait again.
- The message waits until the session and its subagents are idle, and an archived session is not woken.
- Pausing or removing the extension, withdrawing its approval, or dropping a wait type from the manifest ends the waits it held with a wake that says so.
- Sessions inside isolated spaces cannot start waits.

`examples/wait-kit` is the reference: a timer and a URL that starts answering.

## Shared surface (`surface: true`)

A surface lets a person watch what an agent is working in and step in for a manual step. It is not about browsers: a service that drives a browser, a simulator, or a desktop app can show one. The host draws it in the extension's rail panel (a canvas; the extension runs no code there), sends the user's pointer, keyboard, and paste back, and decides who is in control.

Control has three states. Nobody, the agent (for `SURFACE_AGENT_HOLD_MS`, 30 s, after each action the host ran against this extension, such as a browser provider action), or the user. The user takes control by acting: the first click, wheel, key, or paste while nobody or the agent holds it. Moving the pointer over the picture is looking, not acting; it takes nothing and is not even sent until the user holds control. While the user holds it, the host refuses the browser provider's actions with a message that tells the agent to wait or ask, and the panel shows a "Hand back to agent" button. A second device sees who holds control and cannot take it. Every change is posted to the service so its own automation can pause. The service is kept running while a viewer is attached, and returns to its idle window when the last one leaves.

### Wire

Plain HTTP on the service loopback, same bearer as everything else:

| Call | Body / answer |
|---|---|
| `GET /surface/frame?after=<seq>&wait=<ms>` | 200 with `image/jpeg` or `image/png` bytes and headers `x-surface-seq`, `x-surface-width`, `x-surface-height`, optional `x-surface-title`, optional `x-surface-agent-active: 1` while your own automation is driving; 204 when nothing newer than `seq` arrived within `wait` ms. Sequence numbers start at 1, so `after=0` is "the current picture, now". The host asks one frame at a time per viewer; a viewer that draws slowly skips frames rather than queueing them. Frames up to `SURFACE_FRAME_MAX_BYTES` (8 MB). |
| `POST /surface/input` | `{ events: SurfaceInputEvent[] }`: `pointer` (`down`/`up`/`move`, `x`, `y` in frame pixels, `button`, `buttons`, `modifiers`), `wheel` (`x`, `y`, `deltaX`, `deltaY`, `modifiers`), `key` (`down`/`up`, `key`, `code`, `modifiers`, and `keyCode`, the legacy code the viewer's browser computed for the user's keyboard layout; older hosts omit it, so derive one from `key` and `code` then), `text` (pasted or composed text). Parse with `readSurfaceInputBatch`; `null` → 400. Sent only while the user holds control. Headers `x-surface-viewer` (the viewer's id) and `x-surface-frame-seq` (your own sequence number of the frame that viewer last drew, `0` before its first) say where the input came from; answer 409 to refuse input made on a picture you no longer show, and the host tells the viewer it was not applied. |
| `POST /surface/control` | `{ controller: "none" \| "agent" \| "user", viewer? }` whenever control changes; `viewer` is the controlling viewer's id when `controller` is `user`. Parse with `readSurfaceControlNotice`. Advisory. |
| `POST /surface/resize` | `{ width, height }` the panel can show, in device pixels. Answer `{ width, height }` you settled on, or 400 to keep your size. Parse with `readSurfaceResizeRequest`. |
| `GET /surface/clipboard` | `{ text }`: what the user copied inside the surface. The host asks after a copy chord and puts it on the user's clipboard. |

Input, control notices, resizes, and clipboard reads reach the service one at a time, in the order the viewer sent them, so a batch never overtakes the one before it. Copy and paste: the host sends `Ctrl/Cmd+C` as a `key` event and then, behind it, reads `/surface/clipboard`; it never sends the paste chord, it sends a `text` event with the pasted text instead. Every other key reaches you as pressed, including the host's own shortcuts, which stand down while the surface has focus.

### Your own controls beside the picture

Declare `panel.entry` as well and the host docks that page to one edge of the surface: `panel.dock` picks the edge (`top` by default; `bottom` for an inspector, `left` or `right` for a tool column) and `panel.size` its thickness in CSS pixels across that edge (default 40). It is an ordinary sandboxed panel page: it talks to your service through `host.serviceRequest`, gets the theme and the current session like any panel, and stays mounted while the tab is hidden. Call `host.setHeight(px)` to grow or shrink the dock, for example to open a console under the address field and close it again: the value is the thickness across the dock's edge (a width for `left` and `right`), at least 24 px and at most half the panel, so the picture stays in view. Put an address field, tabs, a device picker, or a console toggle there; the picture, the input, and who is in control stay with the host. The page and the surface are independent: the page does not see frames, and the host does not route input through it.

While a viewer is open in the same window, every `serviceRequest` from your pages (the docked one included) reaches the service with three headers the host sets itself: `x-surface-viewer`, `x-surface-viewer-controls` (`1` while that viewer holds control, else `0`), and `x-surface-frame-seq` (the frame it last drew). Compare the viewer with the one from `/surface/control` to let the person in control use the dock while others only watch, and compare the frame with the view it belongs to so a toolbar command made on an old picture cannot change a view selected since. Without a viewer in that window the headers are absent.

The types and paths are exported from `@openchamber/sdk` (`SURFACE_*`, `SurfaceInputEvent`, …). `examples/browser-provider-stub` also declares `surface: true` and paints its fake page with rectangles, so the viewer, the hand-off, and the input path can be seen working without a browser; its `panel/` is a one-line address bar docked above the picture.
