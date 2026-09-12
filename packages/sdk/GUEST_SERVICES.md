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
- `SERVICE_FAILED` — process crashed or never became ready
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
- Permissions text is advisory. Phase 1 does not enforce an OS sandbox around those lists.

## Examples

Local samples under `examples/` (gitignored):

- `examples/docker` — CLI via `exec: ["docker"]`
- `examples/docker-sock` — Engine API over the resolved `docker` socket

Bundle the panel, install from Settings → Extensions as a folder or a zip of the built files, allow the local service, then open the rail panel. Shell into containers is deferred (needs SDK streaming; only with maintainer approval).
