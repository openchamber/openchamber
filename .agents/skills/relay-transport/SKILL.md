---
name: relay-transport
description: Use when adding or changing OpenChamber WebSocket, SSE, streaming, realtime endpoints, shared UI sockets, runtime transport internals, private relay behavior, or files under the UI/server relay modules.
license: MIT
compatibility: opencode
---

## Overview

The private relay carries all of a client's HTTP, SSE and WebSocket traffic through one end-to-end encrypted tunnel per client. Architecture: `packages/web/server/lib/relay/DOCUMENTATION.md`. Code: `packages/ui/src/lib/relay/` (client and shared, TS) and `packages/web/server/lib/relay/` (host, JS).

Load `ui-api-decoupling` when the change adds or alters a shared runtime API, URL/auth contract, bridge, proxy, or runtime-switch behavior. This skill owns relay mechanics; `ui-api-decoupling` owns the shared UI/runtime boundary.

## The core mental model

- **The tunnel is transparent.** A feature should reach the server through the shared runtime transport (`runtimeFetch`, `openRuntimeWebSocket`) and never know whether it is direct or relayed. If a feature constructs its own `fetch`/`WebSocket` against a runtime URL, it bypasses the tunnel and breaks in relay mode.
- **Three transports behave differently over the tunnel:**
  - HTTP and SSE authenticate with the client's **bearer token** (a header). They "just work" through the tunnel for any allowlisted `/api/*`, `/auth/*`, `/health` path.
  - **WebSockets cannot send headers.** They authenticate with a short-lived **URL-scoped token** (`oc_url_token`) that must be minted first and passed as a query parameter. This is the source of most relay WS bugs.

## WebSocket Endpoint Branch

Adding or porting a WS endpoint needs every step below, or it breaks over the relay:

1. **Open it via `openRuntimeWebSocket`** (`packages/ui/src/lib/relay/runtime-socket.ts`), never `new WebSocket(...)` directly. A raw `new WebSocket` against a runtime URL fails in relay mode (the resolver yields a tunnel-virtual/custom-scheme URL the platform rejects — surfaced as "The string did not match the expected pattern").
2. **Add the path to BOTH allowlists** (they are separate and both required):
   - Host tunnel dispatcher: `ALLOWED_WS_PATHS` in `packages/web/server/lib/relay/tunnel-host.js`.
   - URL-token auth gate: `isUrlAuthWebSocketPath` in `packages/web/server/lib/ui-auth/ui-auth.js` (otherwise the `oc_url_token` is refused for that path → 401).
3. **Mint the URL token before connecting.** Call `refreshRuntimeUrlAuthToken()` and build the URL through the resolver's `websocket(...)` so `oc_url_token` is appended. SSE/HTTP do not need this; WS does.
4. **Do not touch origin handling.** The host dials loopback and presents the trusted loopback origin (`http://127.0.0.1:<port>`) for every allowlisted WS path. Never rely on `window.location.origin`; in the iOS WKWebView it is `"null"` or empty for the custom scheme, so forwarding it produces a 403.
5. **Test over the relay, not just direct/desktop.** A new WS may be the first WebSocket the mobile client runs through the tunnel (events are SSE-locked on Capacitor). Passing on desktop or a direct connection proves nothing about the relay path.

## Wire Format And Codec Branch

- **Two implementations must stay byte-compatible.** Any wire-format, frame-type, handshake, or batching change must update both the TS implementation and the JS host mirror and keep `packages/web/server/lib/relay/cross-compat.test.js` green.
- **Frame types live in `protocol.ts`** and must match across `protocol.ts`, `tunnel-codec.ts`, and `tunnel-codec.js`. Adding a frame type without mirroring it corrupts the stream on one side.
- **Frame batching is capability-negotiated** in the handshake with a legacy fallback, so mixed client/host app versions still interoperate. Preserve the negotiation and the single-frame fallback; do not make batching unconditional.
- **The encrypted-frame counter/IV is per-direction and strictly increasing.** One encrypted WS message = one encrypt call = one counter tick. Keep encrypt+send serialized per direction; do not reorder or parallelize it.

## Runtime Transport Branch

- Relay mode routes through `runtime-switch` (activates the tunnel singleton), `runtime-fetch` (routes runtime requests through it), `runtime-url`/`runtime-socket` (tunnel-backed URLs/sockets), and `runtime-auth` (mints the URL token through the tunnel). When refactoring any of these, preserve the relay branch and the direct-URL/Electron-realtime-proxy branches — they must remain byte-identical in behavior for non-relay runtimes.
- **The host dispatcher never injects credentials.** Tunneled requests carry the client's own token; the server authenticates them. Do not add host-side auth shortcuts, and do not trust loopback source address as authentication (relay traffic arrives at loopback but represents remote clients).

## Reconnect Branch

For indefinite SSE/WebSocket reconnect loops:

- Use exponential backoff based on consecutive failures, not a constant short delay.
- Use the long backoff cap while `navigator.onLine` is false or `document.visibilityState` is hidden.
- Treat permanent 4xx responses as long-backoff failures; keep 408 and 429 retryable.
- Make waits interruptible by `online`, visibility becoming visible, and the pipeline abort signal.
- Reset failure state only after a genuinely healthy connection.

Blind short retries on hidden, offline, unauthorized, or stale-path clients waste battery and flood server logs.

## Verification

- Exercise the real auth and origin gates. An end-to-end test whose stub server accepts any WS upgrade will pass while the real server rejects it. When writing a relay integration test, mirror the real gates (`ensureSessionToken` via `oc_url_token`, `isRequestOriginAllowed`) or run against the real server pieces.
- Run `node --check` on changed JS host files; `check:changed` does not cover them.
- Run relay tests per file (`bun test <file>`); the suite has order sensitivity.

Completion requires every applicable branch above: WS path allowlists/auth/origin and real relay exercise; mirrored TS/JS wire changes with cross-compat coverage; preserved direct and relay runtime branches; or reconnect pacing under offline, hidden, permanent-failure, recovery, and abort conditions.
