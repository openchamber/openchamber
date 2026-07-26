---
name: relay-transport
description: Use when adding or changing OpenChamber WebSocket, SSE, streaming, realtime endpoints, shared UI sockets, runtime transport internals, private relay behavior, or files under the UI/server relay modules.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber has a private relay: a client (mobile app, browser, another desktop) reaches a user's instance through an OpenChamber-hosted relay over an **end-to-end encrypted tunnel**. All of the app's traffic — many HTTP requests, the event stream (SSE), and WebSockets (terminal, dictation) — is multiplexed and encrypted through **one** connection per client.

Architecture overview: `packages/web/server/lib/relay/DOCUMENTATION.md`. Code: `packages/ui/src/lib/relay/` (client + shared, TS) and `packages/web/server/lib/relay/` (host, JS).

**Why this skill exists:** relay bugs do not show up in normal testing. The event stream is SSE (which behaves differently from WebSockets), so a new WebSocket feature is often the *first* real WebSocket to cross the tunnel on mobile — and it fails there while working everywhere else. We have fixed the same class of bug across several iterations. The rules below are those lessons.

## The core mental model

- **The tunnel is transparent.** A feature should reach the server through the shared runtime transport (`runtimeFetch`, `openRuntimeWebSocket`) and never know whether it is direct or relayed. If a feature constructs its own `fetch`/`WebSocket` against a runtime URL, it bypasses the tunnel and breaks in relay mode.
- **Three transports behave differently over the tunnel:**
  - HTTP and SSE authenticate with the client's **bearer token** (a header). They "just work" through the tunnel for any allowlisted `/api/*`, `/auth/*`, `/health` path.
  - **WebSockets cannot send headers.** They authenticate with a short-lived **URL-scoped token** (`oc_url_token`) that must be minted first and passed as a query parameter. This is the source of most relay WS bugs.

## Rules for adding or changing a WebSocket endpoint

Adding a new WS endpoint (or porting one, e.g. the planned terminal port) requires ALL of these, or it breaks over the relay:

1. **Open it via `openRuntimeWebSocket`** (`packages/ui/src/lib/relay/runtime-socket.ts`), never `new WebSocket(...)` directly. A raw `new WebSocket` against a runtime URL fails in relay mode (the resolver yields a tunnel-virtual/custom-scheme URL the platform rejects — surfaced as "The string did not match the expected pattern").
2. **Add the path to BOTH allowlists** (they are separate and both required):
   - Host tunnel dispatcher: `ALLOWED_WS_PATHS` in `packages/web/server/lib/relay/tunnel-host.js`.
   - URL-token auth gate: `isUrlAuthWebSocketPath` in `packages/web/server/lib/ui-auth/ui-auth.js` (otherwise the `oc_url_token` is refused for that path → 401).
3. **Mint the URL token before connecting.** Call `refreshRuntimeUrlAuthToken()` and build the URL through the resolver's `websocket(...)` so `oc_url_token` is appended. SSE/HTTP do not need this; WS does.
4. **Do not touch origin handling.** The server rejects WS upgrades whose `Origin` it does not trust. Over the tunnel the host dials loopback and presents the loopback origin (`http://127.0.0.1:<port>`), which the server trusts as same-origin — this already covers every allowlisted WS path. **Never reintroduce reliance on `window.location.origin`**: in the iOS WKWebView it is `"null"`/empty for the custom scheme, so forwarding it produces a 403.
5. **Test over the relay, not just direct/desktop.** A new WS may be the first WebSocket the mobile client runs through the tunnel (events are SSE-locked on Capacitor). Passing on desktop or a direct connection proves nothing about the relay path.

## Rules for the tunnel/crypto/codec internals

- **Two implementations must stay byte-compatible.** The E2EE and framing exist as TS (`packages/ui/src/lib/relay/{crypto,handshake,tunnel-codec}.ts`, normative) and a JS host mirror (`packages/web/server/lib/relay/{e2ee,tunnel-codec}.js`). Any wire-format, frame-type, handshake, or batching change must update **both** and keep `packages/web/server/lib/relay/cross-compat.test.js` green.
- **Frame types live in `protocol.ts`** and must match across `protocol.ts`, `tunnel-codec.ts`, and `tunnel-codec.js`. Adding a frame type without mirroring it corrupts the stream on one side.
- **Frame batching is capability-negotiated** in the handshake with a legacy fallback, so mixed client/host app versions still interoperate. Preserve the negotiation and the single-frame fallback; do not make batching unconditional.
- **The encrypted-frame counter/IV is per-direction and strictly increasing.** One encrypted WS message = one encrypt call = one counter tick. Keep encrypt+send serialized per direction; do not reorder or parallelize it.

## Rules for the runtime transport layer

- Relay mode routes through `runtime-switch` (activates the tunnel singleton), `runtime-fetch` (routes runtime requests through it), `runtime-url`/`runtime-socket` (tunnel-backed URLs/sockets), and `runtime-auth` (mints the URL token through the tunnel). When refactoring any of these, preserve the relay branch and the direct-URL/Electron-realtime-proxy branches — they must remain byte-identical in behavior for non-relay runtimes.
- **The host dispatcher never injects credentials.** Tunneled requests carry the client's own token; the server authenticates them. Do not add host-side auth shortcuts, and do not trust loopback source address as authentication (relay traffic arrives at loopback but represents remote clients).

## Reconnect pacing

For indefinite SSE/WebSocket reconnect loops:

- Use exponential backoff based on consecutive failures, not a constant short delay.
- Use the long backoff cap while `navigator.onLine` is false or `document.visibilityState` is hidden.
- Treat permanent 4xx responses as long-backoff failures; keep 408 and 429 retryable.
- Make waits interruptible by `online`, visibility becoming visible, and the pipeline abort signal.
- Reset failure state only after a genuinely healthy connection.

Blind short retries on hidden, offline, unauthorized, or stale-path clients waste battery and flood server logs.

## Testing guidance (a stub that skips auth/origin hides the exact bugs)

- Exercise the real auth and origin gates. An end-to-end test whose stub server accepts any WS upgrade will pass while the real server rejects it — this is precisely how the origin-check bug shipped. When writing a relay integration test, mirror the real gates (`ensureSessionToken` via `oc_url_token`, `isRequestOriginAllowed`) or run against the real server pieces.
- Run relay tests per file (`bun test <file>`); the suite has order sensitivity.
- Validate both sides: `packages/ui` `type-check`/`lint`, and `node --check` on changed JS host files.

## Quick checklist before finishing relay-adjacent work

- [ ] New WS endpoint added to `ALLOWED_WS_PATHS` AND `isUrlAuthWebSocketPath`?
- [ ] UI opens it via `openRuntimeWebSocket`, not `new WebSocket`?
- [ ] URL token minted before the WS connects?
- [ ] No new dependence on `window.location.origin`?
- [ ] Wire/codec/handshake change mirrored in TS and JS, cross-compat test green?
- [ ] Direct and relay paths both still work; verified over the relay on the transport that actually uses it?
