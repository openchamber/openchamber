# Guest local agents

Implemented on manifest `apiVersion: 1`. Wire envelope `OPENCHAMBER_SDK_API_VERSION` stays `1`.

This is the contract for guests that need a local process (Docker CLI, Engine sockets, kubectl, DB sockets). The iframe stays sandboxed. The host owns spawn and the loopback proxy.

## Why agents exist

HTML guests in a sandboxed iframe reach the network only through `connectHost.request` onto a declared HTTPS `apiOrigin`. That fits cloud trackers. It cannot open `/var/run/docker.sock`, run `docker`, or hold a long-lived local daemon.

Agents keep the iframe. They add a host-owned child process from the same package. The panel never sees the socket. The agent does.

Do not put `docker` (or any product name) on `connectHost`. The SDK knows panel, agent, and a loopback proxy. The package owns the integration.

Declare the OpenChamber floor with `engines.openchamber` (`1.22.0` or `>=1.22.0`). Install refuses when this host is older. Put a semver `version` on `package.json` (`1.0.0`); install requires it and Settings → Extensions shows `v1.0.0` on the card.

## Model

```
panel (iframe) --agentRequest--> host --HTTP 127.0.0.1:port--> agent process --> socket / CLI
                     ^
                     spawn / kill / grant
```

1. Package still ships `panel/index.html` and a classic IIFE `panel/main.js`.
2. Optional `contributes.agent` names a built entry the host can spawn.
3. After a permissions grant (when `sockets` / `exec` are non-empty), the first `agentRequest` starts that entry with the app runtime (`process.execPath` + `ELECTRON_RUN_AS_NODE` on desktop). A system `node` on PATH is not required.
4. The host binds `127.0.0.1` on an ephemeral port and passes `OPENCHAMBER_AGENT_PORT` and `OPENCHAMBER_AGENT_TOKEN` in the agent env.
5. The panel calls `agentRequest({ method, path, query?, body? })`. The host proxies only to that guest's loopback listener. Same stay-on-origin rule as `request`, but the origin is the agent the host started.
6. The agent talks to Docker, kubectl, or anything else. That logic stays in the package.

## Permissions: `exec` vs `sockets`

| Declare | Means | Agent does |
|---|---|---|
| `exec` | Named binaries on PATH | `child_process` / CLI |
| `sockets` | Unix socket or named pipe | Dial Engine API (or similar) itself |

Use `exec` when the integration shells out (like a modern Docker CLI panel). Use `sockets` when the agent opens the daemon endpoint. Do not list a socket path in Needs for a CLI-only agent.

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
    "agent": {
      "entry": "agent/main.js",
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

A CLI agent looks the same except `permissions.exec: ["docker"]` and no `sockets`.

Socket entry shapes:

- `string` — legacy one path for every platform; public id is that string
- `{ id, path }` — same path on linux / darwin / win32
- `{ id, candidates: { linux?, darwin?, win32? } }` — per-OS lists; `~` expands

Parse rules:

- `apiVersion` is `1`. Wire `v` on postMessage stays `1`.
- `engines.openchamber` is optional. Values are `1.22.0` or `>=1.22.0` only. Install returns `host-too-old` when this OpenChamber build is older.
- `contributes.panel` stays required. Same id / name / icon / entry rules as any guest.
- `contributes.agent` is optional. A guest without `agent` is HTML-only.
- `agent.entry` is a relative path inside the package. Ship compiled JS. The packaged app will not compile TypeScript for you.
- `agent.runtime` phase 1 accepts only `"host"`.
- `agent.permissions.sockets` and `agent.permissions.exec` drive the grant UI. They are not an OS jail in phase 1. Settings → Extensions shows **Allow local agent** when either list is non-empty and the user has not granted yet.
- The catalog adds `agent.socketBindings`: `{ id, candidates, resolved, override }` for this host. The user can override a path in Extensions. Override empty clears it and the next spawn re-resolves.
- `contributes.integration` remains valid next to `agent`. Cloud `request` and `agentRequest` may both exist on one guest.

Extra keys still drop, not forward.

## Host hole

| Method | Role |
|---|---|
| `agentRequest` | `{ method, path, query?, body? }` → `{ status, body }`. Proxy to this guest's agent loopback only. `path` starts with `/`, no scheme. |
| `agentStatus` | `stopped` \| `starting` \| `ready` \| `failed`. |

Do not add: raw unix socket from the panel, arbitrary `spawn`, arbitrary filesystem, `host.docker`.

Error codes:

- `NO_AGENT` — no agent declared, not granted when required, not started, or already torn down
- `DISABLED` — extension paused in Settings → Extensions (agent stopped; tokens/grants stay)
- `AGENT_FAILED` — process crashed or never became ready
- Existing: `HOST_TIMEOUT`, `HOST_REJECTED`, `HOST_UNAVAILABLE`, `BAD_PATH`

Server routes (authenticated UI session):

- `POST /api/guests/:id/agent/request`
- `GET /api/guests/:id/agent/status`
- `PUT /api/guests/:id/agent/grant`
- `PUT /api/guests/:id/agent/sockets` — `{ id, path }` (`path` empty or null clears the override). Stops a running agent so the next request respawns with the new env.

The panel never receives `OPENCHAMBER_AGENT_TOKEN` and never dials the port itself. Opaque iframe origin stays. Only the host proxy talks to loopback.

VS Code and mobile stay `unsupported` for the guest catalog. They do not spawn agents.

## Agent process contract

Env the host sets:

- `OPENCHAMBER_AGENT_PORT` — port to bind on `127.0.0.1`
- `OPENCHAMBER_AGENT_TOKEN` — shared secret
- `OPENCHAMBER_AGENT_SOCKETS` — JSON map `{ [socketId]: absolutePath }` for every binding that resolved (override or first existing candidate)

Inbound auth: every request, including ready, must send:

```
Authorization: Bearer <OPENCHAMBER_AGENT_TOKEN>
```

Ready signal: host polls `GET /health` until HTTP 200 (15s timeout), then marks `ready`.

Listen only on `127.0.0.1`. Do not bind `0.0.0.0`.

Ship `agent/main.js` already built. Same packaging rule as `panel/main.js`.

## Lifecycle

| Event | Host behavior |
|---|---|
| Install | Catalog row includes public `agent` (`runtime`, `permissions`, `socketBindings`, `granted: false`). No spawn yet. |
| Grant | `PUT .../agent/grant` writes `agentGrants` in `extensions.json`. |
| Socket override | `PUT .../agent/sockets` writes `agentSocketOverrides`. Running agent for that guest stops. |
| First `agentRequest` | If grant required and missing → `NO_AGENT`. Else spawn with resolved sockets, wait for `/health`, proxy. |
| Panel open | Status via `agentStatus`. Dead agent restarts on the next `agentRequest`. |
| Uninstall | SIGTERM, then kill after timeout. Clear grant and socket overrides. Path-install does not delete the user's folder. |
| Host quit | Kill every guest agent. |
| Crash | Status `failed`. Panel sees `AGENT_FAILED` / status. Manual retry, not silent loops. |

## Security invariants

- Panel → host → agent loopback only. No panel → socket.
- `agentRequest` path must stay on that agent (host-allocated port for that guest id).
- Non-empty `sockets` / `exec` requires an explicit grant before proxy.
- Permissions text is advisory. Phase 1 does not enforce an OS sandbox around those lists.

## Examples

Local samples under `examples/` (gitignored):

- `examples/docker` — CLI via `exec: ["docker"]`
- `examples/docker-sock` — Engine API over the resolved `docker` socket

Bundle the panel, install from Settings → Extensions as a folder or a zip of the built files, allow the local agent, then open the rail panel. Shell into containers is deferred (needs SDK streaming; only with maintainer approval).
