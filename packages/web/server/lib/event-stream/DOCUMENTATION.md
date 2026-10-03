# Event Stream Module Documentation

## Purpose
This module contains the OpenChamber message-stream WebSocket protocol and runtime bridge. It keeps the browser-facing WebSocket transport separate from the upstream OpenCode SSE transport.

## Entrypoints and structure
- `packages/web/server/lib/event-stream/index.js`: public entrypoint re-exporting protocol and runtime helpers.
- `packages/web/server/lib/event-stream/global-hub.js`: shared global upstream SSE hub for server-side subscribers and browser WS fan-out.
- `packages/web/server/lib/event-stream/delta-coalescer.js`: merges consecutive `message.part.delta` events before replay and fan-out. Pure, with injectable clock and timers.
- `packages/web/server/lib/event-stream/global-ws-bridge.js`: browser-facing global WS bridge that subscribes clients to the shared global hub.
- `packages/web/server/lib/event-stream/directory-ws-bridge.js`: browser-facing per-directory WS bridge that owns one scoped upstream reader per connection.
- `packages/web/server/lib/event-stream/protocol.js`: path constants, SSE envelope parsing, and WebSocket frame serialization helpers.
- `packages/web/server/lib/event-stream/translate-v2.js`: the single place that maps OpenCode 2.x wire events onto the server's own event vocabulary.
- `packages/web/server/lib/event-stream/upstream-reader.js`: reusable upstream SSE reader with event-id tracking, stall recovery, and reconnect handling.
- `packages/web/server/lib/event-stream/runtime.js`: thin WebSocket server runtime for upgrade handling and path dispatch to the global/directory bridges.
- `packages/web/server/lib/event-stream/protocol.test.js`: unit tests for protocol helpers.
- `packages/web/server/lib/event-stream/upstream-reader.test.js`: unit tests for upstream SSE reader behavior.
- `packages/web/server/lib/event-stream/runtime.test.js`: unit tests for runtime-side broadcaster behavior.

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

### Event translation
- `translateWireEvent(payload)`: one v2 wire event in, zero or more server-vocabulary events out.
- `wireEventDirectory(payload)`: the directory an event belongs to, read from `payload.location.directory`.
- `forwardTranslatedWireEvent(payload, handle)`: translate and forward, for consumers that take one handler.

### Coalescing helpers
- `createDeltaCoalescer(...)`: merges consecutive streaming fragments before replay and fan-out. In OpenCode 2.x the merged shapes are `session.text.delta`, `session.reasoning.delta` and `session.tool.input.delta` (v1 had a single `message.part.delta`); every other event is a barrier. Text and reasoning fragments are keyed by `data.ordinal`, tool input by `data.id`.
- `resolveDeltaCoalesceWindowMs(env)`: reads `OPENCHAMBER_EVENT_DELTA_COALESCE_MS`. Unset means 50ms, `0` turns coalescing off, and anything that is not a whole number from 0 to 1000 keeps the default with a warning.

### Upstream reader helpers
- `DEFAULT_UPSTREAM_STALL_TIMEOUT_MS`: default idle timeout before an attached upstream SSE fetch is aborted for reconnect.
- `DEFAULT_UPSTREAM_RECONNECT_DELAY_MS`: default delay between upstream reconnect attempts.
- `createUpstreamSseReader(...)`: creates a start/stop reader for OpenCode SSE streams. The reader parses SSE blocks, tracks the latest `Last-Event-ID`, reconnects after closed or stalled upstream streams, and reports events through callbacks.

## Runtime behavior
- Browser clients connect to the WS endpoints above.
- OpenChamber still fetches OpenCode upstream event streams over SSE, now from `/api/event`.
- OpenCode 2.x sends no `id:` SSE lines: the event id is `payload.id` and the directory is `payload.location.directory`. Replay and per-directory routing read both out of the payload.
- Browser clients receive the RAW wire payload and translate it themselves. Server-side subscribers read `event.translated()` instead, so the translation happens once per event and only when something listens.
- v2 emits no `session.status` and no `session.idle` of its own: live status is synthesized from `session.execution.started|succeeded|interrupted|failed`. A user abort arrives as `session.idle` with `aborted: true`, not as an assistant message carrying `MessageAbortedError`. A `session.execution.interrupted` with `reason: "shutdown"` translates to nothing: OpenCode keeps the execution claim across a shutdown and resumes the turn after restart, so the session stays busy for server consumers (goal, queue, notifications) until the real terminal event arrives.
- The web server creates one shared global message-stream hub. OpenCode watcher side effects and global WS clients subscribe to that hub, so there is one upstream `/global/event` SSE reader for both server-side processing and browser fan-out.
- The global hub keeps a bounded replay buffer keyed by SSE `eventId` so reconnecting browser clients can receive buffered events after their requested `Last-Event-ID`.
- Replay retains at most 2,048 events and 8 MiB of UTF-8 wire frames. It stores encoded frames rather than retaining parsed payloads as well. Encoding is shared with live WS fanout. An oversized event still reaches live clients in full, but clears the retained suffix so replay cannot cross its gap. A missing replay cursor returns `null`, distinct from a complete empty tail; the bridge sends `ready` with `replayReset: true` and no partial replay. The client retires its cursor and requests authoritative repair, including during the early-boot reconnect grace period. A stopped hub retains its bounded suffix for clients reconnecting after the last socket closed.
- The hub numbers every event that arrives without an SSE id (`oc-<process>-<sequence>`). OpenCode 1.18 sends no ids at all, and an event without an id used to skip the replay buffer, so reconnecting clients had no cursor and lost whatever fell into the gap. The process prefix makes a cursor from before a server restart miss, which reports `replayReset`, instead of matching an unrelated sequence number.
- Directory WS clients still attach one upstream `/event?directory=...` SSE reader per connection because directory streams are scoped.
- If an upstream SSE stream stalls after the browser WS is already ready, the reader aborts that upstream fetch and reconnects upstream with `Last-Event-ID`, keeping the browser WS alive when recovery is fast.
- When the shared global upstream reconnects after it was previously ready, the global WS bridge sends a fresh `ready` frame to already-ready browser clients. The browser treats this as a reconnect edge and can run scoped state repair without requiring the browser WS to close.
- Health checks are reserved for initial upstream connect failures and explicit upstream-unavailable responses, not for ordinary stall recovery on an already-established stream.
- Global synthetic events such as `openchamber:session-status`, `openchamber:session-activity`, `openchamber:notification`, and `openchamber:heartbeat` are preserved on the WS path, but heartbeat frames are emitted only while an upstream SSE stream is actively attached.
- Global UI broadcasts are fan-out capable across both SSE and WS clients.
- Global UI broadcasts serialize once per wire format, irrespective of client count. The SSE writer accepts an optional pre-serialized payload; isolated callers keep the two-argument contract. Failed or backpressured clients cannot block delivery to healthy clients.
- The reusable upstream reader centralizes SSE fetch/parsing/reconnect behavior for the WS runtime and OpenCode watcher. Additional event consumers should move to it only with parity tests for their lifecycle and error semantics.
- Browser transport concerns live in the WS bridge modules; server-side global stream ownership lives in `global-hub.js`.

## Delta coalescing
OpenCode publishes one `message.part.delta` per token fragment. A 5.7 KB answer measured 3,402 delta events of 1.7 characters each, 97% of all frames and 1.3 MB on the wire. The hub merges them before replay and fan-out, which cut that stream to 483 frames and 197 KB with identical text. Replay holds merged frames too, so its 2,048 entries cover about seven times more streaming time.

Merging is lossless because of three rules. Change one only with the randomized test in `delta-coalescer.test.js` still passing.

- Every event that is not a well-formed delta is a barrier. All pending text is emitted before it, so a delta never crosses a part snapshot or a status change.
- Deltas of different part fields commute, so several stay pending at once. They are emitted in the order their latest fragment arrived, which keeps event ids in upstream order.
- A merged event carries the id of its last fragment. A client cursor is the id of the last frame it received, so it always names a boundary between merged events.

Pending text is bounded by time (the 50ms window), by size (64 KiB), and by part fields (64). Reaching a bound emits early. Nothing is dropped. The first delta after a quiet spell is emitted at once, so time to first text does not grow.

The hub commits pending text when it stops, so it reaches the retained replay suffix, and the global bridge commits it before it marks a socket ready. A client readied later therefore receives exactly the events that arrived after it was ready, as it did before coalescing, and a reconnecting client receives the committed text through replay.

Verified against a live server by dropping the socket every 150ms to 3s during a stream and resuming from the cursor: the reconstructed text matched byte for byte with no duplicate ids. Server-side hub subscribers receive merged events as well. None of them reads individual deltas.

The directory WS bridge and the SSE proxy (`/api/global/event`, used by Capacitor) still forward unmerged events.

## Notes for contributors
- Keep protocol helpers pure and small so they can be unit tested without spinning up a server.
- Keep `runtime.js` focused on WebSocket upgrade and endpoint dispatch. Put global browser-client lifecycle in `global-ws-bridge.js`, directory stream lifecycle in `directory-ws-bridge.js`, and upstream stream sharing in `global-hub.js`.
- Do not change upstream OpenCode transport assumptions here; OpenCode remains SSE-based.
- Keep global replay bounded; do not turn it into an unbounded event log.

## Testing
- Run `bunx vitest run server/lib/event-stream` from `packages/web` for the whole module, including `delta-coalescer.test.js` and the resume-from-any-cursor cases in `global-hub.test.js`.
- Run `bun test packages/web/server/lib/event-stream/protocol.test.js`
- Run `bun test packages/web/server/lib/event-stream/translate-v2.test.js`
- Run `bun test packages/web/server/lib/event-stream/upstream-reader.test.js`
- Run `bun test packages/web/server/lib/event-stream/runtime.test.js`
- Run repo validation before finalizing: `bun run type-check`, `bun run lint`, `bun run build`
