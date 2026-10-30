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
- `service.provides` is optional: roles the service stands in for on the host, `"browser"` and `"source-control"` (below). A service that provides a role needs no `panel.entry` or `background.entry`; the host starts it itself.
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
- `OPENCHAMBER_SERVICE_SOCKETS` — JSON map `{ [socketId]: absolutePath }` for every binding that resolved (override or first existing candidate)
- `OPENCHAMBER_HOST_CALLBACK_URL` — only for a service that provides `source-control` or `notifications`: OpenChamber's callback listener for the requests those roles send out (see below)

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
| `capabilities` | `projects`, `issues`, `changeRequests`, `draftChangeRequests`, `merge` (`false` or `{ methods: ["merge" \| "squash" \| "rebase" \| "submit"] }`, with `submit` the only method when present), `ci`, `comments`, `reviews`, `state`, `labels`, `reviewers`, `changeRequestPatch`, `liveSummaries`, `reviewModel?` (`"verdict"` by default, or `"votes"`), `revisions?`. One left out is off. Review threads, uploads, stacks, the reference picker, multiple accounts and how a change request is created are fixed by OpenChamber |
| `token` | `{ header: "authorization" \| "private-token", scheme: "bearer" \| "token" \| "basic" \| "none", username?, scopes, createPath? }`. `private-token` takes the bare token (`none`); `authorization` takes `Bearer`, `token` or `basic`. `basic` needs `username: true`, and `username: true` is refused with any other scheme |
| `transport` | `{ httpsUsername: { kind: "login" } \| { kind: "fixed", value }, appendDotGitToHttpsClone }`: how Git over HTTPS signs in with the stored token |
| `limits` | `{ commentMaxLength (≤ 1 000 000), reviewerId: "numeric" \| "login", labelsMax (≤ 100), reviewersMax (≤ 50) }` |
| `trackedItems` | `{ batchLimit }`, 1–50 items per `liveSummaries` call |
| `presentation` | `{ abbreviation (1–8), promptNoun, sharedNumberSpace, iconPath? (24×24 SVG path data), urls: { changeRequest[], issue[] }, features: { authorCanReview, issueCloseReason, submitRequirements? }, changeRequestTemplates[] }` |

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

`readSourceControlProviderRequest(body)` parses it (`null` → answer HTTP 400). `provider` is the id OpenChamber gave the host: put it in every DTO's `provider` field. `session.user` is `null` in `auth.verify` and `auth.probe`, before an account exists. `input` per method is `SourceControlProviderInputs`; the reads take the route shell's own input, with `directory` and `remote` as OpenChamber resolved them and `context` the binding it validated.

Answer HTTP 200 with `{ "ok": true, "data": … }` or `{ "ok": false, "error": { "message", "status"?, "code"? } }` (`message` ≤ 2000 characters, `status` 400–599, `code` `[A-Z_]{1,64}`). Any other status or shape is a malformed answer, never an empty one.

| Method | Answer OpenChamber checks |
|---|---|
| `auth.verify` | `{ user: { id, login, name?, email?, avatarUrl? } }`: who the candidate token belongs to; OpenChamber stores the account |
| `auth.probe` | `{ supported, version?, message? }`: whether the instance is this forge; the handle carries no token |
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
| `merge` | `/pr/merge` | `change-request-merge` | `{ method }`, one of the declared `merge.methods` |
| `draftChangeRequests` | `/pr/ready` | `change-request-ready` | `{}` |
| `comments` | `/pr/comment`, `/issues/comment` | `change-request-comment`, `issue-comment` | `{ body }` |
| `state` | `/pr/state`, `/issues/state` | `change-request-state`, `issue-state` | `{ state }`: `open` or `closed` |
| `labels` | `/pr/labels`, `/issues/labels` | `change-request-labels`, `issue-labels` | `{ names }`: the whole set |
| `reviewers` | `/pr/reviewers` | `change-request-reviewers` | `{ names }`: the whole set, as `limits.reviewerId` spells them |
| `reviews` | `/pr/review` | `change-request-review` | `{ verdict: "approve" \| "request-changes", body? }`, for the `headSha` in the target. With `reviewModel: "votes"`, `{ votes, body? }` instead |

Review threads have routes too, but they stay off for an extension's Git host.

Deadlines: `changeRequestStatus` 12 s (past it the last known status shows), other reads 20 s, mutation steps 30 s, `auth.*` 15 s (`sourceControlProviderTimeoutMs`).

OpenChamber decides, not the service, what a failure means. A mutation counts as definitely failed only when the service was never reached or every write the proxy saw got a 4xx; anything else is an unknown outcome to reconcile. A `status: 401` writes off the account only when OpenChamber's proxy saw the forge answer 401 on that call; a 401 the service reports on its own is a malformed answer.

### Reaching the forge

The service never holds a token. `createSourceControlForge({ env: process.env })` returns `{ request(handle, req) }`, which posts to `${OPENCHAMBER_HOST_CALLBACK_URL}/source-control/outbound` with `Authorization: Bearer <handle>`. `OPENCHAMBER_HOST_CALLBACK_URL` is a separate loopback listener, set only for services with this role or the `notifications` role.

- Request (`SourceControlOutboundRequest`): `{ method: GET|POST|PUT|PATCH|DELETE, path, query?, headers?, body? }`. `path` starts with one `/` and stays on the call's instance origin. `headers` (lower-case names) may be `accept`, `content-type`, `if-none-match` and `range`; OpenChamber sets the rest, the token included, per `token.header` and `token.scheme` (with `basic`, the account's login too). `body` is text up to `SOURCE_CONTROL_OUTBOUND_BODY_MAX` (1 MB).
- Answer: HTTP 200 with `{ status, headers, body }`, the forge's status (any, 401 included), the headers in `SOURCE_CONTROL_OUTBOUND_RESPONSE_HEADERS` plus `x-ratelimit-*`, and the body as text up to `SOURCE_CONTROL_OUTBOUND_RESPONSE_MAX` (8 MB). Redirects are not followed. `request` resolves with it.
- Refusal: any other status with `{ error: { message, code } }` (an expired or unknown handle, a path off the instance, a body too large). `request` throws `SourceControlForgeError` with that `code` and `status`; `HOST_UNAVAILABLE` when there was no usable answer.

A handle is minted for one call, carries `auth.verify`'s candidate token or the bound account's token (none for `auth.probe`), and is revoked when the call ends. Never store it.

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

## Session events (`contributes.sessionEvents`)

A service can be told what happens in the user's sessions without a window being open. Declare which events it wants next to the service:

```json
"service": { "entry": "service/main.js", "runtime": "host" },
"sessionEvents": { "events": ["turn-finished", "question-asked"], "content": true }
```

`events` lists 1 to 4 distinct types:

| Type | When |
|---|---|
| `turn-finished` | The session went idle with nothing waiting: no running subagent, no open permission, form or page, no goal or auto-review step still driving it. A turn the user stopped emits nothing |
| `turn-failed` | The turn ended in an error |
| `permission-asked` | The agent asked a permission the user has to answer: sent 500 ms after the ask, only when it is still open and not answered by the session's own policy |
| `question-asked` | The agent asked the user a question, through a form or a page it shows and waits on. An MCP elicitation, which belongs to no session, is not sent |

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
    "permission": { "requestId": "perm_…" }
  },
  "content": { "type": "turn-finished", "sessionTitle": "Fix the parser", "reply": "Done. …", "replyTruncated": false }
}
```

- `event.id` is OpenCode's event id (or one OpenChamber made for an event it synthesized), `at` epoch milliseconds, `session.parentId` set for a subagent's session, `project.directory` the session's directory or `null` when OpenChamber does not know it. `linked` is what the user attached to the session: ids, kinds, urls, the tracker's `provider` and `identifier`, a Git host's `number`, never a title. `permission` comes with `permission-asked` only.
- `content` comes only with the `transcript` grant, typed by `type`: `turn-finished` carries `sessionTitle`, `reply` (cut at `SESSION_EVENT_REPLY_MAX`, 64 000 characters, with `replyTruncated`); `turn-failed` carries `error { type, message }` and no reply; `permission-asked` carries `action`, `resources`, `message`; `question-asked` carries `ask`, a form (`id`, `title`, `fields[{ title, description }]`) or a page (`id`, `title`).
- Parse the body with `readSessionEventRequest` (zod-free; `null` is a body that is not a session event of this wire version, answer HTTP 400) and answer HTTP 200 `{ "ok": true }` once the event is taken, or `{ "ok": false, "error": "…" }` (`GuestSessionEventResult`, `error` up to `SESSION_EVENT_ERROR_MAX`). OpenChamber parses the answer with `sessionEventResultSchema`; anything else is a failed delivery.

### Delivery

- Host sessions in every project are sent, each with its directory. Sessions inside isolated spaces are not delivered to extensions yet. Which projects an extension acts on is its own choice: compare `event.project.directory` with your own settings and answer `{ ok: true }` for the rest.
- The first event starts the service; `SESSION_EVENTS_IDLE_MS` (ten minutes) without one stops it, and the next event starts it again. Events that arrive while it starts wait, at most `SESSION_EVENT_PENDING_MAX` (200), newer ones dropped with one warning.
- Event preparation also admits at most one oldest event and `SESSION_EVENT_PENDING_MAX` later events before starting reads. Excess announcements are dropped, while open asks and their answers remain tracked. Shutdown discards prepared events and prevents further reads.
- One request in flight per service, in order. A delivery has `SESSION_EVENT_TIMEOUT_MS` (10 s). A failed delivery (a timeout, a non-200 status, `ok: false`, a body that does not parse) drops that service's events for the next 30 s and logs the `error` text; OpenChamber never logs an event's content.
- At most once, with no persistence: an event that happened while OpenChamber was down, while the extension was paused, or during that backoff is gone. A paused extension, a withdrawn approval and a removal drop what waited for them.
- Two idle events for one turn end (OpenCode announces it twice) are one `turn-finished`.
- The service never receives a token, a callback URL or a way back into the session through this path.

`examples/session-events-log` is the reference: a service-only extension that journals every event to a file.

## Shared surface (`surface: true`)

A surface lets a person watch what an agent is working in and step in for a manual step. It is not about browsers: a service that drives a browser, a simulator, or a desktop app can show one. The host draws it in the extension's rail panel (a canvas; the extension runs no code there), sends the user's pointer, keyboard, and paste back, and decides who is in control.

Control has three states. Nobody, the agent (for `SURFACE_AGENT_HOLD_MS`, 30 s, after each action the host ran against this extension, such as a browser provider action), or the user. The user takes control by acting: the first click, wheel, key, or paste while nobody or the agent holds it. Moving the pointer over the picture is looking, not acting; it takes nothing and is not even sent until the user holds control. While the user holds it, the host refuses the browser provider's actions with a message that tells the agent to wait or ask, and the panel shows a "Hand back to agent" button. A second device sees who holds control and cannot take it. Every change is posted to the service so its own automation can pause. The service is kept running while a viewer is attached, and returns to its idle window when the last one leaves.

### Wire

Plain HTTP on the service loopback, same bearer as everything else:

| Call | Body / answer |
|---|---|
| `GET /surface/frame?after=<seq>&wait=<ms>` | 200 with `image/jpeg` or `image/png` bytes and headers `x-surface-seq`, `x-surface-width`, `x-surface-height`, optional `x-surface-title`, optional `x-surface-agent-active: 1` while your own automation is driving; 204 when nothing newer than `seq` arrived within `wait` ms. Sequence numbers start at 1, so `after=0` is "the current picture, now". The host asks one frame at a time per viewer; a viewer that draws slowly skips frames rather than queueing them. Frames up to `SURFACE_FRAME_MAX_BYTES` (8 MB). |
| `POST /surface/input` | `{ events: SurfaceInputEvent[] }`: `pointer` (`down`/`up`/`move`, `x`, `y` in frame pixels, `button`, `buttons`, `modifiers`), `wheel` (`x`, `y`, `deltaX`, `deltaY`, `modifiers`), `key` (`down`/`up`, `key`, `code`, `modifiers`), `text` (pasted or composed text). Parse with `readSurfaceInputBatch`; `null` → 400. Sent only while the user holds control. Headers `x-surface-viewer` (the viewer's id) and `x-surface-frame-seq` (your own sequence number of the frame that viewer last drew, `0` before its first) say where the input came from; answer 409 to refuse input made on a picture you no longer show, and the host tells the viewer it was not applied. |
| `POST /surface/control` | `{ controller: "none" \| "agent" \| "user", viewer? }` whenever control changes; `viewer` is the controlling viewer's id when `controller` is `user`. Parse with `readSurfaceControlNotice`. Advisory. |
| `POST /surface/resize` | `{ width, height }` the panel can show, in device pixels. Answer `{ width, height }` you settled on, or 400 to keep your size. Parse with `readSurfaceResizeRequest`. |
| `GET /surface/clipboard` | `{ text }`: what the user copied inside the surface. The host asks after a copy chord and puts it on the user's clipboard. |

Input, control notices, resizes, and clipboard reads reach the service one at a time, in the order the viewer sent them, so a batch never overtakes the one before it. Copy and paste: the host sends `Ctrl/Cmd+C` as a `key` event and then, behind it, reads `/surface/clipboard`; it never sends the paste chord, it sends a `text` event with the pasted text instead. Every other key reaches you as pressed, including the host's own shortcuts, which stand down while the surface has focus.

### Your own controls beside the picture

Declare `panel.entry` as well and the host docks that page to one edge of the surface: `panel.dock` picks the edge (`top` by default; `bottom` for an inspector, `left` or `right` for a tool column) and `panel.size` its thickness in CSS pixels across that edge (default 40). It is an ordinary sandboxed panel page: it talks to your service through `host.serviceRequest`, gets the theme and the current session like any panel, and stays mounted while the tab is hidden. Call `host.setHeight(px)` to grow or shrink the dock, for example to open a console under the address field and close it again: the value is the thickness across the dock's edge (a width for `left` and `right`), at least 24 px and at most half the panel, so the picture stays in view. Put an address field, tabs, a device picker, or a console toggle there; the picture, the input, and who is in control stay with the host. The page and the surface are independent: the page does not see frames, and the host does not route input through it.

While a viewer is open in the same window, every `serviceRequest` from your pages (the docked one included) reaches the service with three headers the host sets itself: `x-surface-viewer`, `x-surface-viewer-controls` (`1` while that viewer holds control, else `0`), and `x-surface-frame-seq` (the frame it last drew). Compare the viewer with the one from `/surface/control` to let the person in control use the dock while others only watch, and compare the frame with the view it belongs to so a toolbar command made on an old picture cannot change a view selected since. Without a viewer in that window the headers are absent.

The types and paths are exported from `@openchamber/sdk` (`SURFACE_*`, `SurfaceInputEvent`, …). `examples/browser-provider-stub` also declares `surface: true` and paints its fake page with rectangles, so the viewer, the hand-off, and the input path can be seen working without a browser; its `panel/` is a one-line address bar docked above the picture.
