# Event Stream Module Documentation

## Purpose
This module contains the OpenChamber message-stream WebSocket protocol and runtime bridge. It keeps the browser-facing WebSocket transport separate from the upstream OpenCode SSE transport.

## Entrypoints and structure
- `packages/web/server/lib/event-stream/index.js`: public entrypoint re-exporting protocol and runtime helpers.
- `packages/web/server/lib/event-stream/global-hub.js`: shared global upstream SSE hub for server-side subscribers and browser WS fan-out.
- `packages/web/server/lib/event-stream/global-ws-bridge.js`: browser-facing global WS bridge that subscribes clients to the shared global hub.
- `packages/web/server/lib/event-stream/directory-ws-bridge.js`: browser-facing per-directory WS bridge that owns one scoped upstream reader per connection.
- `packages/web/server/lib/event-stream/protocol.js`: path constants, SSE envelope parsing, and WebSocket frame serialization helpers.
- `packages/web/server/lib/event-stream/upstream-reader.js`: reusable upstream SSE reader with event-id tracking, stall recovery, and reconnect handling.
- `packages/web/server/lib/event-stream/runtime.js`: thin WebSocket server runtime for upgrade handling and path dispatch to the global/directory bridges.
- `packages/web/server/lib/event-stream/protocol.test.js`: unit tests for protocol helpers.
- `packages/web/server/lib/event-stream/upstream-reader.test.js`: unit tests for upstream SSE reader behavior.
- `packages/web/server/lib/event-stream/runtime.test.js`: unit tests for runtime-side broadcaster behavior.
- `packages/web/server/lib/event-stream/global-hub.test.js`: unit tests for shared-hub replay bounds, status fanout, and parking.
- `packages/web/server/lib/event-stream/rebind.test.js`: unit tests for upstream rebinding after a managed OpenCode restart.

## Public exports

### Protocol helpers
- `MESSAGE_STREAM_GLOBAL_WS_PATH`: `/api/global/event/ws`
- `MESSAGE_STREAM_DIRECTORY_WS_PATH`: `/api/event/ws`
- `MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS`: heartbeat interval for browser-facing WS connections.
- `parseSseEventEnvelope(block)`: parses an SSE block into `{ eventId, directory, payload }`.
- `sendMessageStreamWsFrame(socket, payload)`: serializes and sends a JSON WS frame.
- `sendMessageStreamWsEvent(socket, payload, options)`: sends an event frame with optional `eventId` and `directory`.
- `serializeMessageStreamWsEvent(payload, options)` and `sendSerializedMessageStreamWsFrame(socket, frame)` separate encoding from per-socket delivery. Delivery retains ready-state and backpressure checks.

### Runtime helpers
- `createGlobalMessageStreamHub(...)`: creates a shared `/global/event` upstream SSE hub with event/status subscribers and bounded event-id replay.
- `createGlobalUiEventBroadcaster({ sseClients, wsClients, writeSseEvent })`: returns a broadcaster that fans out the same synthetic UI event to SSE and WS clients.
- `createMessageStreamWsRuntime(...)`: mounts the message-stream WS server, upgrade handler, and SSE-to-WS bridge onto the web HTTP server.

### Upstream reader helpers
- `DEFAULT_UPSTREAM_STALL_TIMEOUT_MS`: default idle timeout before an attached upstream SSE fetch is aborted for reconnect.
- `DEFAULT_UPSTREAM_RECONNECT_DELAY_MS`: default base delay between upstream reconnect attempts.
- `DEFAULT_UPSTREAM_RECONNECT_DELAY_MAX_MS`: default cap for the bounded exponential reconnect backoff (30 s).
- `DEFAULT_UPSTREAM_BUILD_URL_FAILURE_LIMIT`: consecutive `buildUrl` failures that make the reader eligible to park (5). Parking is opt-in: it requires the caller to provide `onParked`.
- `createUpstreamSseReader(...)`: creates a start/stop reader for OpenCode SSE streams. The reader parses SSE blocks, tracks the latest `Last-Event-ID`, reconnects after closed or stalled upstream streams, and reports events through callbacks. Reconnect waits grow exponentially to the cap while attempts keep failing and reset to the base once upstream bytes arrive. When `buildUrl` keeps throwing and the caller supplied `onParked`, the reader reports the failure through `onParked` once and stops retrying. Without `onParked` it never parks: it reports the failure through `onError` and keeps retrying at the capped backoff, so isolated callers retain recovery.

## Runtime behavior
- Browser clients connect to the WS endpoints above.
- OpenChamber still fetches OpenCode upstream event streams over SSE.
- The web server creates one shared global message-stream hub. OpenCode watcher side effects and global WS clients subscribe to that hub, so there is one upstream `/global/event` SSE reader for both server-side processing and browser fan-out.
- The global hub keeps a bounded replay buffer keyed by SSE `eventId` so reconnecting browser clients can receive buffered events after their requested `Last-Event-ID`.
- Replay retains at most 2,048 events and 8 MiB of UTF-8 wire frames. It stores encoded frames rather than retaining parsed payloads as well. Encoding is shared with live WS fanout. An oversized event still reaches live clients in full, but clears the retained suffix so replay cannot cross its gap. A missing replay cursor returns `null`, distinct from a complete empty tail; the bridge sends `ready` with `replayReset: true` and no partial replay. The client retires its cursor and requests authoritative repair, including during the early-boot reconnect grace period. A stopped hub retains its bounded suffix for clients reconnecting after the last socket closed.
- Directory WS clients still attach one upstream `/event?directory=...` SSE reader per connection because directory streams are scoped.
- If an upstream SSE stream stalls after the browser WS is already ready, the reader aborts that upstream fetch and reconnects upstream with `Last-Event-ID`, keeping the browser WS alive when recovery is fast.
- When the shared global upstream reconnects after it was previously ready, the global WS bridge sends a fresh `ready` frame to already-ready browser clients. The browser treats this as a reconnect edge and can run scoped state repair without requiring the browser WS to close.
- Health checks are reserved for initial upstream connect failures and explicit upstream-unavailable responses, not for ordinary stall recovery on an already-established stream.
- Upstream reconnect pacing is bounded. Each consecutive failed attempt (non-OK response, stream error, or a thrown `buildUrl`) doubles the wait from `DEFAULT_UPSTREAM_RECONNECT_DELAY_MS` up to `DEFAULT_UPSTREAM_RECONNECT_DELAY_MAX_MS`; receiving upstream bytes resets the pacing to the base, so a genuinely healthy stream always reconnects promptly.
- A thrown `buildUrl` means OpenCode has no addressable URL (for example the managed process is dead and its port is gone). When the caller supplied `onParked`, after `DEFAULT_UPSTREAM_BUILD_URL_FAILURE_LIMIT` consecutive build-URL failures the reader parks: it stops dialing and reports one terminal `onParked`. The global hub turns that into an `unavailable` status carrying `buildUrlFailed` and `everConnected`, and stays parked until an explicit `stop()`/`start()` cycle such as `rebindUpstream()` after a managed restart. Transient `upstream_unavailable` and stream errors keep retrying with capped backoff and never park. Callers that do not supply `onParked` (for example the standalone watcher fallback) never park: every failure is reported through `onError` and the reader keeps dialing at the capped backoff.
- While parked, the global WS bridge logs the failure once instead of on every attempt and keeps already-connected clients parked; clients that connect before the first successful upstream connect still get the initial-error close. Directory-scoped bridges close the socket once when their reader parks so the client reconnect path can recover after the next rebind.
- Global synthetic events such as `openchamber:session-status`, `openchamber:session-activity`, `openchamber:notification`, and `openchamber:heartbeat` are preserved on the WS path, but heartbeat frames are emitted only while an upstream SSE stream is actively attached.
- Global UI broadcasts are fan-out capable across both SSE and WS clients.
- Global UI broadcasts serialize once per wire format, irrespective of client count. The SSE writer accepts an optional pre-serialized payload; isolated callers keep the two-argument contract. Failed or backpressured clients cannot block delivery to healthy clients.
- The reusable upstream reader centralizes SSE fetch/parsing/reconnect behavior for the WS runtime and OpenCode watcher. Additional event consumers should move to it only with parity tests for their lifecycle and error semantics.
- Browser transport concerns live in the WS bridge modules; server-side global stream ownership lives in `global-hub.js`.

## Notes for contributors
- Keep protocol helpers pure and small so they can be unit tested without spinning up a server.
- Keep `runtime.js` focused on WebSocket upgrade and endpoint dispatch. Put global browser-client lifecycle in `global-ws-bridge.js`, directory stream lifecycle in `directory-ws-bridge.js`, and upstream stream sharing in `global-hub.js`.
- Do not change upstream OpenCode transport assumptions here; OpenCode remains SSE-based.
- Keep global replay bounded; do not turn it into an unbounded event log.

## Testing
- Run `bun test packages/web/server/lib/event-stream/protocol.test.js`
- Run `bun test packages/web/server/lib/event-stream/upstream-reader.test.js`
- Run `bun test packages/web/server/lib/event-stream/runtime.test.js`
- Run `bun test packages/web/server/lib/event-stream/global-hub.test.js`
- Run `bun test packages/web/server/lib/event-stream/rebind.test.js`
- Run repo validation before finalizing: `bun run type-check`, `bun run lint`, `bun run build`
