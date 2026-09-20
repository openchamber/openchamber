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
- `service.provides` is optional: roles the service stands in for on the host. Only `"browser"` exists today (below). A service that provides a role needs no `panel.entry` or `background.entry`; the host starts it itself.
- `service.surface` is optional (`true`): the service shows a live picture the host draws in the extension's rail panel and takes the user's input back (below). It excludes `panel.entry`; the surface is the panel.
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
- Existing: `HOST_TIMEOUT`, `HOST_REJECTED`, `HOST_UNAVAILABLE`, `BAD_PATH`

Server routes (authenticated UI session):

- `POST /api/guests/:id/service/request`
- `GET /api/guests/:id/service/status`
- `PUT /api/guests/:id/capabilities` — `{ granted }`, the full requested list or `[]` to withdraw
- `PUT /api/guests/:id/service/sockets` — `{ id, path }` (`path` empty or null clears the override). Stops a running service so the next request respawns with the new env.

The panel never receives `OPENCHAMBER_SERVICE_TOKEN` and never dials the port itself. Opaque iframe origin stays. Only the host proxy talks to loopback.

VS Code and mobile stay `unsupported` for the guest catalog. They do not spawn services.

## Service process contract

Env the host sets:

- `OPENCHAMBER_SERVICE_PORT` — port to bind on `127.0.0.1`
- `OPENCHAMBER_SERVICE_TOKEN` — shared secret
- `OPENCHAMBER_SERVICE_SOCKETS` — JSON map `{ [socketId]: absolutePath }` for every binding that resolved (override or first existing candidate)

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
| Crash | Status `failed`. Panel sees `SERVICE_FAILED` / status. Manual retry, not silent loops. |

## Security invariants

- Panel → host → service loopback only. No panel → socket.
- `serviceRequest` path must stay on that service (host-allocated port for that guest id).
- Every service requires an explicit grant before proxy.
- Permissions text is advisory. Phase 1 does not enforce an OS sandbox around those lists: an allowed service can run any command, use git, and read or write any file the user can. The approval dialog says so in plain words.

## Example

`examples/service-echo` is a checked-in service extension: a Node HTTP server on loopback that the panel calls through `serviceRequest` and whose status it shows. Bundle the service with `--node`, install the folder from Settings → Extensions, allow the local service in the approval dialog, then open the rail panel. Streaming from a service to the panel (shell into a container, log tails) is deferred; it needs a streaming call on the SDK first.

## Browser provider (`provides: ["browser"]`)

The host's `openchamber_web` tool gives agents ten `browser.*` actions. By default a connected desktop app answers them with its browser panel; on a server with no desktop client the agent gets nothing. A service that declares `provides: ["browser"]` can answer instead, from a browser it runs itself (headless Chrome over CDP, for instance). The agent sees one tool either way.

The user picks the provider in Settings → General → OpenChamber Tools → Browser provider. The dropdown lists installed, enabled, fully approved extensions with the role; with none it shows only "OpenChamber Web", disabled. The choice is `browserProvider` in the instance's `settings.json` (`builtin` or the extension id) and is read on every action, so it applies to the next action without a restart. Pausing, removing, or withdrawing approval from the selected extension puts `builtin` back and every open client shows a toast saying so; the same happens on the next action if the extension became unusable any other way.

Lifecycle differs from a panel-driven service in two ways. The host starts the service on the first action, so the agent can browse with no panel and no viewer; the grant is the same one the user gave at install. After `BROWSER_PROVIDER_IDLE_MS` (ten minutes) without an action the host stops the process; the next action starts it again. A `browser.open` may take `BROWSER_PROVIDER_OPEN_TIMEOUT_MS` (45 s), every other action `BROWSER_PROVIDER_ACTION_TIMEOUT_MS` (20 s). Answers are read up to `BROWSER_PROVIDER_RESPONSE_MAX` (12 MB), enough for a screenshot.

### Wire

`POST /browser-control` on the service loopback, same bearer as every request, JSON body:

```json
{ "requestId": "browser-…", "action": "browser.click", "parameters": { "selector": "#save" } }
```

`readBrowserProviderRequest(body)` from `@openchamber/sdk` parses it (`null` → answer HTTP 400). The host validated `parameters` for the action before posting, so the service can trust the shape. Answer HTTP 200 with one of:

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
| `browser.scroll` | `direction?` (`up`/`down`/`top`/`bottom`) or `selector?` | `scrollY`, `maxScrollY`, `atTop`, `atBottom`, optional `scrolledTo`/`direction` |
| `browser.back` / `browser.forward` | none | `url`, `title` |
| `browser.inspect` | `selector` | `selector`, `tag`, `label`, `bounds`, `inViewport`, `styles` (computed, as strings) |
| `browser.capture` | `label?` | `base64`, `mime`, `width`, `height`, `url`, `title`, `viewport`; the host writes the file into the project and returns its path |
| `browser.resize` | `viewport` (`mobile`/`tablet`/`desktop`/`fill`) | `viewport` |

`viewport` in answers is `{ mode, width, height }` (`mode` may be `custom`; `fill` has `null` sizes). Snapshot `elements` carry `selector`, `tag`, `bounds`, and only the fields that apply (`inViewport`, `type`, `role`, `label`, `disabled`, `missingAccessibleName`). Keep `text` and `elements` bounded yourself; report what was dropped with the truncation fields.

`examples/browser-provider-stub` is a checked-in provider with no browser: one in-memory page that answers every action. Install it to see the dropdown, the routing, and the idle stop before writing a real one.

## Shared surface (`surface: true`)

A surface lets a person watch what an agent is working in and step in for a manual step. It is not about browsers: a service that drives a browser, a simulator, or a desktop app can show one. The host draws it in the extension's rail panel (a canvas; the extension runs no code there), sends the user's pointer, keyboard, and paste back, and decides who is in control.

Control has three states. Nobody, the agent (for `SURFACE_AGENT_HOLD_MS`, 30 s, after each action the host ran against this extension, such as a browser provider action), or the user. The user takes control by acting: the first click, wheel, key, or paste while nobody or the agent holds it. Moving the pointer over the picture is looking, not acting; it takes nothing and is not even sent until the user holds control. While the user holds it, the host refuses the browser provider's actions with a message that tells the agent to wait or ask, and the panel shows a "Hand back to agent" button. A second device sees who holds control and cannot take it. Every change is posted to the service so its own automation can pause. The service is kept running while a viewer is attached, and returns to its idle window when the last one leaves.

### Wire

Plain HTTP on the service loopback, same bearer as everything else:

| Call | Body / answer |
|---|---|
| `GET /surface/frame?after=<seq>&wait=<ms>` | 200 with `image/jpeg` or `image/png` bytes and headers `x-surface-seq`, `x-surface-width`, `x-surface-height`, optional `x-surface-title`, optional `x-surface-agent-active: 1` while your own automation is driving; 204 when nothing newer than `seq` arrived within `wait` ms. Sequence numbers start at 1, so `after=0` is "the current picture, now". The host asks one frame at a time per viewer; a viewer that draws slowly skips frames rather than queueing them. Frames up to `SURFACE_FRAME_MAX_BYTES` (8 MB). |
| `POST /surface/input` | `{ events: SurfaceInputEvent[] }`: `pointer` (`down`/`up`/`move`, `x`, `y` in frame pixels, `button`, `buttons`, `modifiers`), `wheel` (`x`, `y`, `deltaX`, `deltaY`, `modifiers`), `key` (`down`/`up`, `key`, `code`, `modifiers`), `text` (pasted or composed text). Parse with `readSurfaceInputBatch`; `null` → 400. Sent only while the user holds control. |
| `POST /surface/control` | `{ controller: "none" \| "agent" \| "user" }` whenever control changes. Parse with `readSurfaceControlNotice`. Advisory. |
| `POST /surface/resize` | `{ width, height }` the panel can show, in device pixels. Answer `{ width, height }` you settled on, or 400 to keep your size. Parse with `readSurfaceResizeRequest`. |
| `GET /surface/clipboard` | `{ text }`: what the user copied inside the surface. The host asks after a copy chord and puts it on the user's clipboard. |

Input, control notices, resizes, and clipboard reads reach the service one at a time, in the order the viewer sent them, so a batch never overtakes the one before it. Copy and paste: the host sends `Ctrl/Cmd+C` as a `key` event and then, behind it, reads `/surface/clipboard`; it never sends the paste chord, it sends a `text` event with the pasted text instead. Every other key reaches you as pressed, including the host's own shortcuts, which stand down while the surface has focus.

The types and paths are exported from `@openchamber/sdk` (`SURFACE_*`, `SurfaceInputEvent`, …). `examples/browser-provider-stub` also declares `surface: true` and paints its fake page with rectangles, so the viewer, the hand-off, and the input path can be seen working without a browser.
