# Preview — Remote-host relay (design)

Status: design only, no implementation.
Owner: TBD.
Audience: contributors planning the next phase of the embedded preview feature.

## Problem

The current preview implementation (`packages/web/server/lib/preview/proxy-runtime.js`,
`packages/ui/src/components/layout/ContextPanel.tsx`) terminates inside the
OpenChamber server process and forwards requests to a **loopback** target
(`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`). It works for these topologies:

| Topology                                                                 | Works today? |
| ------------------------------------------------------------------------ | ------------ |
| Web UI in browser, OpenChamber server on same host as dev server         | yes          |
| Electron desktop, dev server on same host                                | yes          |
| VS Code extension, dev server on same host                               | yes          |
| Mobile/tablet hitting OpenChamber over LAN, dev server on host           | yes          |
| **Remote OpenChamber** (cloud / shared / tunneled), dev server on user's local machine | **no**       |

The blocked case is real: a user runs `openchamber serve` on a remote box (or a
hosted OpenChamber instance) but their dev server (`vite`, `next dev`, etc.)
runs on their laptop. The proxy correctly refuses to talk to non-loopback
targets — that is a deliberate SSRF gate, not a bug. We need a separate path
that tunnels traffic from the remote OpenChamber back to the user's laptop
without weakening that gate.

## Non-goals

- Replacing the existing loopback proxy. The local-loopback path is the common
  case and stays unchanged.
- Acting as a generic public ingress for arbitrary local services. We only
  expose dev servers selected through the preview UI, scoped to the active
  user's session.
- Providing a hosted relay service. The relay is something the user runs;
  OpenChamber provides the agent + the server endpoints.

## Constraints (carried forward from the loopback proxy)

- Same-origin in the browser. The iframe must load from the OpenChamber
  origin so HTTPS, cookies, and CSP behave predictably.
- Per-target cookie auth. A target id must not be guessable, and the cookie
  must be HttpOnly + scoped to that target's path.
- WebSocket upgrade support (HMR is a hard requirement; without it the
  feature is uninteresting).
- Strip frame-busting headers on the response.
- Strip OpenChamber credentials before forwarding to the dev server.
- Survive partial failure cleanly: if the agent disconnects, the iframe
  should land on the existing "dev server is not responding" overlay, not a
  zombie hang.

## Architecture

Three components, in order of where they run.

### 1. Local agent (runs on the user's laptop)

A small process the user starts on the same machine as the dev server. Two
shipping options:

- A subcommand of the existing CLI: `openchamber preview-agent`.
- A standalone single-binary build for users who do not have the full UI
  installed locally.

Responsibilities:

- Open exactly one outbound, authenticated WebSocket to the remote
  OpenChamber server (`wss://<host>/api/preview/agent`). Outbound-only — no
  inbound port on the user's machine, so it works behind NAT, VPN,
  corporate firewall, etc.
- Authenticate with a short-lived enrollment token issued by the remote
  OpenChamber server (see "Pairing flow").
- Advertise the set of dev servers the user has authorised. Scope is
  loopback-only on the agent side (same allowlist as the existing proxy:
  `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`). The agent never proxies to
  arbitrary hosts on the user's network.
- Multiplex per-request streams over the single control WebSocket
  (frame protocol below). Each browser request becomes one logical stream.
- Forward HTTP and upgraded WebSocket connections to the local dev server.
- Send authoritative `agent-disconnected` notifications so the server can
  evict targets immediately rather than waiting for TTL.

Deliberately out of scope for the agent:

- TLS termination. The agent only talks to loopback over plain HTTP; the
  outbound link to OpenChamber is TLS via the server's existing cert.
- Anything that mutates the user's filesystem.
- Acting as a general SOCKS/HTTP proxy. It is dev-server-scoped.

### 2. Remote OpenChamber server (extends `proxy-runtime.js`)

Adds two new surfaces alongside the existing loopback proxy:

- `GET /api/preview/agent` (WebSocket): the single control channel an agent
  connects to after enrollment. Authenticated by the enrollment token + the
  user's UI session.
- `POST /api/preview/targets/remote`: same shape as the existing
  `POST /api/preview/targets`, but the URL is interpreted **relative to a
  connected agent**. The body becomes
  `{ agentId, url, ttlMs? }` (or the existing endpoint accepts an optional
  `agentId` and dispatches to the right path). The response keeps the same
  contract: `{ id, proxyBasePath, expiresAt }`. The browser does not learn
  it is talking to a remote agent — that is a server-side detail.

The existing `/api/preview/proxy/:id/*` route is reused unchanged from the
browser's perspective. Internally it now dispatches based on the registered
target type:

- `kind: 'loopback'` (existing) → `http-proxy-middleware` to a local origin.
- `kind: 'agent'` (new) → encode the request into a frame, push it onto the
  matching agent's WebSocket, await the response frames, stream them back
  to the browser.

This dispatch boundary is the only invasive change to the existing runtime.
The factory stays `createPreviewProxyRuntime`; the agent registry, frame
codec, and response streaming live in a sibling module
(`packages/web/server/lib/preview/agent-runtime.js`) so the loopback path
remains readable and individually testable.

### 3. Browser (UI layer)

Almost no change. `PreviewPane` already POSTs to `/api/preview/targets` and
loads the iframe at the returned `proxyBasePath`. The remote case adds:

- A small "no agent connected" empty state when the user's profile has no
  active agent but tries to preview a non-public URL. Gives them the exact
  command to run and a one-click copy of the enrollment token.
- The existing 502 / dev-server-down overlay handles agent disconnects too
  — the proxy returns 502 if the agent vanishes mid-request.

## Pairing / enrollment flow

The agent must prove it is acting on behalf of a specific UI user, and the
server must be able to revoke that proof.

1. User opens Settings → Preview → "Connect a local dev-server agent".
2. Server mints a short-lived (5 min) enrollment token bound to the user's
   UI session id, with a single allowed scope: `preview-agent.connect`. UI
   shows the command:
   ```
   openchamber preview-agent --server https://<host> --token <enrollment-token>
   ```
3. Agent posts the enrollment token to `POST /api/preview/agent/enroll` and
   receives a long-lived `agentId` + `agentSecret`. Stored in the agent's
   config dir (`$XDG_CONFIG_HOME/openchamber/agent.json` or platform
   equivalent).
4. Agent opens the control WebSocket, authenticating with `agentId` +
   `agentSecret`. The server verifies and registers the agent against the
   owning user.
5. Agent sends an initial `hello` frame with: agent version, OS, hostname
   hint (display only — never used for routing), and a list of dev-server
   URLs the user has explicitly approved on the agent side.

Revocation:

- User can revoke an agent from Settings; the server invalidates the
  `agentSecret` and closes any open WebSocket.
- The agent honours `disconnect` frames from the server with a clean
  shutdown.
- Enrollment tokens are single-use and expire after 5 min.

## Wire protocol (control WebSocket)

Binary frames, little-endian, one frame = one logical operation. JSON metadata
header followed by an opaque body. Designed to be implementable in Node and
Bun without exotic deps.

```
+--------+--------+--------+----------------------+----------------------+
| u8 ver | u8 op  | u32 len| metadata (JSON, len) | body (remaining)     |
+--------+--------+--------+----------------------+----------------------+
```

Operations:

| op   | name              | direction      | metadata                                                            | body                                |
| ---- | ----------------- | -------------- | ------------------------------------------------------------------- | ----------------------------------- |
| 0x01 | hello             | agent → server | `{ agentVersion, hostnameHint, allowedTargets: [{origin}] }`        | empty                               |
| 0x02 | hello-ack         | server → agent | `{ ok, serverVersion }` or `{ ok: false, reason }`                  | empty                               |
| 0x10 | http-request      | server → agent | `{ streamId, method, path, headers, originHint }`                   | request body bytes                  |
| 0x11 | http-response-head| agent → server | `{ streamId, status, headers }`                                     | empty                               |
| 0x12 | http-response-data| agent → server | `{ streamId, fin: bool }`                                           | response body chunk                 |
| 0x13 | http-error        | agent → server | `{ streamId, code, message }`                                       | empty                               |
| 0x20 | ws-open           | server → agent | `{ streamId, path, headers, subprotocols }`                         | empty                               |
| 0x21 | ws-open-ack       | agent → server | `{ streamId, ok, status?, subprotocol? }`                           | empty                               |
| 0x22 | ws-frame          | both           | `{ streamId, opcode: 'text'|'binary', fin: bool }`                  | frame payload                       |
| 0x23 | ws-close          | both           | `{ streamId, code?, reason? }`                                      | empty                               |
| 0x30 | cancel            | server → agent | `{ streamId }`                                                      | empty                               |
| 0xFE | ping              | both           | `{ ts }`                                                            | empty                               |
| 0xFF | disconnect        | server → agent | `{ reason }`                                                        | empty                               |

Notes:

- `streamId` is server-assigned for `http-request` and `ws-open`. It scopes
  ordering and back-pressure per logical request.
- Body chunks for HTTP responses are streamed (`fin: false` until the last
  chunk). The server proxies them to the browser without buffering, so
  large downloads do not balloon memory on either side.
- The `originHint` lets the agent log which approved target a request was
  routed to; routing itself is determined by the registered target's
  `agentId` + origin, not by anything the browser sends.
- Back-pressure: if the server's downstream socket is paused, it stops
  reading from the agent's WebSocket. WebSocket flow control then applies
  end-to-end. We do not implement an additional credit scheme until
  measurement shows we need one.

## Security model

Every guarantee the loopback proxy gives must hold here too. Checked
against the same threat model:

- **Server-side SSRF**: target URLs are still validated against the loopback
  allowlist — but on the agent, not the server. The server never makes a
  network call on behalf of a target.
- **Cross-user target access**: a target id is owned by the user that
  registered it. Cookie + path scope unchanged.
- **Cross-agent leakage**: a target id is also bound to the specific
  `agentId` it was registered against. Even if two users somehow share a
  target id (they cannot — ids are 128-bit random), dispatch only reaches
  the agent the target was bound to.
- **Agent impersonation**: `agentSecret` is per-agent, stored only on the
  user's machine, transported only over TLS during enrollment + connect.
  Revocable from Settings.
- **Frame-busting headers**: stripped server-side after the agent returns
  the response, identical to the loopback path. Same code path
  (`stripFrameBustingHeaders`) — keep it as a single point of truth.
- **Dev-server credentials**: the agent strips `cookie`, `authorization`,
  and `x-openchamber-ui-session` before forwarding to the local dev
  server, mirroring the existing `proxyReq` handler.
- **Public-internet exposure**: no inbound port opens on the user's
  machine; no egress to non-loopback addresses; the agent process refuses
  to start with `0.0.0.0` upstream targets that resolve off-loopback.
- **Connection pinning**: when the agent's WebSocket disconnects, all of
  its targets are evicted immediately and any in-flight streams are
  aborted with 502. The cached entry on the browser side (see
  `previewProxyTargetCache` in `ContextPanel.tsx`) will then re-register
  on the next attempt and surface the "no agent connected" empty state.

Out-of-scope hardening to revisit later:

- mTLS for the agent ↔ server link (current proposal: TLS + agentSecret;
  mTLS is a future option for self-hosters who want it).
- Audit logging of every proxied request (today the loopback path doesn't
  do this; the remote path should not become an exception without a UX
  for inspecting the log).

## Failure modes

| Failure                                | Behaviour                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Agent never connected                  | `POST /api/preview/targets/remote` returns 409 with `{ error: 'No agent connected' }`. UI shows empty state.   |
| Agent disconnected mid-request         | Server cancels the stream, returns 502 to the browser, evicts the target. Existing overlay handles it.         |
| Dev server down on user's laptop       | Agent forwards the connection refusal as `http-error`; server emits 502. Existing overlay handles it.          |
| Slow agent / dev server                | Streamed response keeps flowing; no buffering on the server. WebSocket flow control gates the data rate.       |
| Server restarted                       | Agent reconnects with stored `agentSecret`. Browser-side cache 404s on next request and re-registers.          |
| Enrollment token expired               | `POST /api/preview/agent/enroll` returns 401 with a clear error; UI prompts to mint a new one.                 |
| Two agents registered for same user    | Allowed. The browser-side flow always picks the most recently active agent for a given upstream URL.           |

## Open questions

These need a decision before implementation, not before the doc lands.

1. **CLI surface.** Is `openchamber preview-agent` the right verb, or should
   it live under `openchamber agent preview`? Bias: the former; only one
   agent today, and we can rename without breaking anything if we ever ship
   a second.
2. **Multi-agent UX.** When a user has two agents online (laptop + desktop)
   and registers a `localhost:3000` preview, which one wins? Most-recent
   activity is a sensible default but we should also let the user pin a
   target to an agent.
3. **Browser-side detection of remote vs loopback.** Today the UI has no
   reason to know. If the empty state needs the user's enrolled agents,
   that becomes a new `GET /api/preview/agents` endpoint. Acceptable.
4. **Storage of `agentSecret`.** Plain file under the agent config dir is
   simplest. OS keychain integration is nicer but a much larger surface.
   Bias: file first, keychain later.
5. **Frame protocol vs. full HTTP/2 / gRPC.** The custom frame protocol is
   maybe 200 lines in each runtime. gRPC would handle streaming and back
   pressure for us but adds a heavy dep. Bias: custom frames; revisit only
   if we hit a back-pressure or multiplexing bug we cannot solve cleanly.
6. **Compression.** The current loopback path forces `accept-encoding:
   identity` to keep the proxy simple. The remote path probably wants
   gzip/br between the agent and the server to save bandwidth on slow
   links — but the dev server may not be configured for it. Decide once we
   measure.

## Implementation milestones

Each milestone is independently shippable and reviewable. Numbers are
sequence, not effort.

1. Agent registry + enrollment endpoints on the server. No proxying yet.
   Settings UI to mint and revoke enrollment tokens.
2. Standalone agent that connects, says hello, and stays connected with
   ping/pong. No proxying yet. Validates the auth + reconnect story.
3. HTTP-only proxying through the agent (`http-request` /
   `http-response-*`). Browser can register a remote target and load
   static pages. No HMR yet.
4. WebSocket proxying through the agent (`ws-open` / `ws-frame` /
   `ws-close`). HMR works.
5. Failure-mode polish: 502 on disconnect, target eviction, browser-side
   empty state, "agent connected" indicator in Settings.
6. Documentation + tutorial for the remote-host scenario; update
   `docs/REVERSE_PROXY.md` cross-link.

## Why not …?

- **A reverse SSH tunnel from the agent.** Works but requires SSH server
  on the OpenChamber host, exposes a port, and breaks the same-origin
  guarantee unless we also reverse-proxy that port through the
  OpenChamber HTTP server. The control-WebSocket design avoids all of
  that and keeps a single TLS endpoint.
- **Cloudflare/ngrok-style hosted relay.** Would work but turns
  OpenChamber into a service that depends on a third party (or on us
  hosting a relay). The agent design lets users run entirely
  self-hosted.
- **WebRTC data channels.** Lower latency in theory, much harder to debug
  and to reason about behind corporate NATs. Not worth the complexity
  for HTTP + WS forwarding.

## Cross-references

- Loopback runtime: `packages/web/server/lib/preview/proxy-runtime.js`
- Browser PreviewPane + cache: `packages/ui/src/components/layout/ContextPanel.tsx`
- Reverse-proxy deployment notes: `docs/REVERSE_PROXY.md`
