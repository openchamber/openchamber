# Event Stream Module Documentation

## Purpose
This module contains the OpenChamber message-stream WebSocket protocol and runtime bridge. It keeps the browser-facing WebSocket transport separate from the upstream OpenCode SSE transport.

## Entrypoints and structure
- `packages/web/server/lib/event-stream/index.ts`: public entrypoint re-exporting protocol and runtime helpers.
- `packages/web/server/lib/event-stream/global-hub.ts`: shared global upstream SSE hub for server-side subscribers and browser WS fan-out.
- `packages/web/server/lib/event-stream/delta-coalescer.ts`: merges consecutive delta events before replay and fan-out. Pure, with injectable clock and timers.
- `packages/web/server/lib/event-stream/global-ws-bridge.ts`: browser-facing global WS bridge that subscribes clients to the shared global hub.
- `packages/web/server/lib/event-stream/directory-ws-bridge.ts`: browser-facing per-directory WS bridge that owns one scoped upstream reader per connection.
- `packages/web/server/lib/event-stream/protocol.ts`: path constants, SSE envelope parsing, and WebSocket frame serialization helpers.
- `packages/web/server/lib/event-stream/translate-v2.ts`: the single place that maps OpenCode 2.x wire events onto the server's own event vocabulary.
- `packages/web/server/lib/event-stream/upstream-reader.ts`: reusable upstream SSE reader with event-id tracking, stall recovery, and reconnect handling.
- `packages/web/server/lib/event-stream/runtime.ts`: thin WebSocket server runtime for upgrade handling and path dispatch to the global/directory bridges.
- `packages/web/server/lib/event-stream/sse-cursor.js`: SSE block parsing and the versioned OpenChamber cursor (`occ1.<stream>.<position>.<upstream>`).
- `packages/web/server/lib/event-stream/replay-store.js`: the bounded, append-only durable store for the global stream's local frames, head and retention watermarks.
- `packages/web/server/lib/event-stream/protocol.test.js`: unit tests for protocol helpers.
- `packages/web/server/lib/event-stream/upstream-reader.test.js`: unit tests for upstream SSE reader behavior.
- `packages/web/server/lib/event-stream/runtime.test.js`: unit tests for runtime-side broadcaster behavior.
- `packages/web/server/lib/event-stream/replay-store.test.js`: round-trip, torn-record, reset and compaction tests for the durable store.

## Public exports

### Protocol helpers
- `MESSAGE_STREAM_GLOBAL_WS_PATH`: `/api/global/event/ws`
- `MESSAGE_STREAM_DIRECTORY_WS_PATH`: `/api/event/ws`
- `MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS`: heartbeat interval for browser-facing WS connections.
- `MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES`: 64 KiB per-message inbound payload cap passed as `maxPayload` to the WS server and checked again by the connection's `message` handler. Node's `ws` enforces `maxPayload` while parsing. Bun may not, so the handler closes over-cap messages with 1009 after assembly, preventing the connection from sending repeated oversized messages. The handler cannot prevent the first over-cap allocation under Bun. The stream is receive-only, so accepted inbound frames are discarded.

- `MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES`: 16 MiB of pending outbound bytes per client. A healthy client stays near 0, and the limit trips only when a client is far behind, which is what the value measures. Bursts in long agent sessions need the headroom.
- `MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES`: 12 MiB, where the server sends one `backpressure` frame so the client can shed low-priority updates before the hard disconnect. The flag keeps the warning one-shot because repeated warnings would grow the buffer they warn about, and it resets once the buffer drains below the threshold.
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
- `resolveDeltaCoalesceWindowMs(env)`: reads `OPENCHAMBER_EVENT_DELTA_COALESCE_MS`. Unset means 50ms, `0` turns coalescing off, and anything that is not a whole number from 0 to 1000 keeps the default with a warning. The `0` setting is the switch for a misbehaving client and the way to measure the unmerged stream on the same build.

### Upstream reader helpers
- `DEFAULT_UPSTREAM_STALL_TIMEOUT_MS`: default idle timeout before an attached upstream SSE fetch is aborted for reconnect (20 s). `UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS` is the window while more than one session is active (40 s). The stall window must stay above `OPENCODE_SSE_HEARTBEAT_INTERVAL_MS` (15 s), the gap between the `: heartbeat` comments OpenCode 2.x writes on an idle stream; at or below it, every idle stream is torn down and reopened on each window (dezren39/nix#668).
- `timeouts.js`: the three windows and their environment overrides. `OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_MS` sets the stall window, `OPENCHAMBER_UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS` the concurrent one and `OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS` the resume idle bound (10 s). Each is read once at startup, as whole milliseconds from 1,000 to 600,000; a value outside that, or not a whole number, logs a warning and keeps its default.
- `DEFAULT_UPSTREAM_RECONNECT_DELAY_MS`: default delay between upstream reconnect attempts.
- `createUpstreamSseReader(...)`: creates a start/stop reader for OpenCode SSE streams. The reader parses SSE blocks, tracks the latest `Last-Event-ID`, reconnects after closed or stalled upstream streams, and reports events through callbacks.
- `UPSTREAM_SSE_MAX_BUFFERED_CHARS` (4 MiB): cap on the reader's retained partial (separator-less) block, and `SSE_CURSOR_MAX_PENDING_CHARS` (4 MiB): the same cap for `createSseCursor`'s pending block in `sse-cursor.js`. Complete blocks may be larger; only text retained waiting for a `\n\n` separator is bounded.

### Cursor helpers
- `isOpenCodeEventId(id)`: true for OpenCode's `<instance>:<sequence>` form, the only id OpenCode can replay from.
- `encodeOpenChamberCursor({ stream, position, upstream })`, `decodeOpenChamberCursor(cursor)`, `isOpenChamberCursor(cursor)`: the versioned OpenChamber cursor `occ1.<stream>.<position>.<upstream>`. The `occ1.` prefix cannot collide with an OpenCode id; the stream token and position are validated before a replay.

### Durable store
- `createReplayStore({ filePath, ... })`: a bounded append-only store for the global stream's local frames, its head position and upstream cursor, and its retention watermarks. Without a `filePath` it keeps the same records in memory.
- Loading accepts regular files up to 32 MiB; a larger or non-regular file, or an unexpected read failure, disables persistence for that store instance and leaves the file untouched. A missing file starts an ordinary new store.
- A malformed tail or a final record without a newline is repaired with an atomic snapshot before another record is appended; if repair fails, the append is not persisted.
- `resolveGlobalReplayFilePath(env, home)`: the global stream's file under `OPENCHAMBER_DATA_DIR`, or `~/.config/openchamber` when unset.

- `reconnectDelayMs` takes a number or a function. A number is the base of the reader's exponential backoff, and the failure counter increments before the delay is computed, so the first failure waits the base delay. A function belongs to a caller that keeps its own backoff.

## Runtime behavior
- Browser clients connect to the WS endpoints above.
- A message-stream upgrade whose URL repeats `directory` or `lastEventId` is ambiguous and is refused with an error frame and a 1008 close instead of silently streaming under the first value (issue #2315); single-value and absent params are unchanged. This mirrors the directory-scoped HTTP surfaces, which reject a repeated `directory` with a 400.
- OpenChamber still fetches OpenCode upstream event streams over SSE, now from `/api/event`.
- OpenCode 2.x sends no `id:` SSE lines: the event id is `payload.id` and the directory is `payload.location.directory`. Replay and per-directory routing read both out of the payload.
- Browser clients receive the RAW wire payload and translate it themselves. Server-side subscribers read `event.translated()` instead, so the translation happens once per event and only when something listens.
- `session.archived` and `session.unarchived` translate to events of their own. Extension session events announce the first as `session-archived`; session work waits for the second to open a session a message reached while it was archived. Neither is folded into `session.updated`, whose consumers (goal mode kickoff, lineage, notifications) would read an archive or a restore as an edit of the record.
- `session.forked` translates its `data.sessionID` and `data.parentID` into the fork and source ids in `properties`. Permission inheritance consumes this translated event; OpenCode emits no `session.created` for the fork. Tests of server fork behavior must pass the wire event through this translator.
- v2 emits no `session.status` and no `session.idle` of its own: live status is synthesized from `session.execution.started|succeeded|interrupted|failed`, plus `session.retry.scheduled` (status `retry` while a provider error waits for the next attempt) and `session.step.started` (back to `busy`, which clears `retry` once the attempt begins). Only the status from `session.execution.started` carries `turnStartedAt` (the event's `created`): it is the one event that marks where a turn begins, and the synthetic `openchamber:session-status` frames forward that start, or the session runtime's, beside a busy or retry status. A user abort arrives as `session.idle` with `aborted: true`, not as an assistant message carrying `MessageAbortedError`. A `session.execution.interrupted` with `reason: "shutdown"` translates to nothing: OpenCode keeps the execution claim across a shutdown and resumes the turn after restart, so the session stays busy for server consumers (goal, queue, notifications) until the real terminal event arrives.
- The web server creates one shared global message-stream hub. OpenCode watcher side effects and global WS clients subscribe to that hub, so there is one upstream `/global/event` SSE reader for both server-side processing and browser fan-out.
- The global hub keeps a bounded replay buffer keyed by SSE `eventId` so reconnecting browser clients can receive buffered events after their requested `Last-Event-ID`.
- Replay retains at most 2,048 events and 8 MiB of UTF-8 wire frames. It stores encoded frames rather than retaining parsed payloads as well. Encoding is shared with live WS fanout. An oversized event still reaches live clients in full, but clears the retained suffix so replay cannot cross its gap. A missing replay cursor returns `null`, distinct from a complete empty tail; the bridge sends `ready` with `replayReset: true` and no partial replay. The client retires its cursor and requests authoritative repair, including during the early-boot reconnect grace period. The suffix never crosses a gap in the hub's own reading: when the upstream reader connects again, after a drop or after the hub was stopped, the buffer is emptied and a cursor from before then reports `replayReset`. 2,048 events and 8 MiB cover a brief disconnect in a long agent session, where events accumulate quickly. An event enters the replay buffer in the same step that delivers it, so a client's cursor always names a frame the buffer can find.
- A `ready` frame says how the client stands. `replayed: true` means the cursor was found and every event after it follows, so the client missed nothing. Every other `ready` carries `cursor`, the point the stream continues from: the latest event, or the start of the current suffix when it holds none. A client that receives no event before its next reconnect resumes from that cursor. The `ready` sent to connected clients after an upstream reconnect carries the new cursor and no `replayed`, so those clients repair.
- The hub numbers every event that arrives without an SSE id (`oc-<process>-<sequence>`). OpenCode 1.18 sends no ids at all, and an event without an id used to skip the replay buffer, so reconnecting clients had no cursor and lost whatever fell into the gap. The process prefix makes a cursor from before a server restart miss, which reports `replayReset`, instead of matching an unrelated sequence number.
- Events of sessions OpenChamber runs for itself stop at the hub entrance, before replay, fan-out and every subscriber. The directory bridges read their own upstream and apply the same filter through the hub's exposed `isHiddenPayload`.
- A turn start or end (`session.execution.started|succeeded|failed|interrupted`) whose `durable.seq` is not newer than the newest durable event the hub has seen for its session stops at the hub entrance too, for upstream and injected events alike (`turn-boundary-order.ts`). OpenCode numbers a session's durable events in one sequence it stores, so such an event is a resent copy or an earlier turn's end; letting it through made the synthetic `openchamber:session-status` say idle and server consumers (queue, goal, notifications) treat the running turn as ended (#6837). The record lives as long as the hub, across upstream reconnects, since a reconnect is when copies come; `session.deleted` drops a session's entry, because OpenCode drops its sequence then and an import can bring the same id back with lower numbers. An event counts only for the session its `data.sessionID` names and only when `durable.aggregateID` agrees, because space ownership is checked on `data.sessionID`: a space event must not move a host session's count. A deletion the hub never saw (an upstream outage during a delete and reimport of the same id) leaves the old count, and the reimported session's boundaries stay hidden until it passes it or the server restarts; resetting on `session.created` was rejected because a resent copy of it would reopen the hole. The browser pipeline applies the same rule for copies the hub cannot see (`packages/ui/src/sync/DOCUMENTATION.md`).
- `subscribeEvent(fn, { spaces: true })` also receives the events of isolated spaces, which carry `spaceId`; without the option a subscriber sees the host's events only, because a consumer that acts on the host's OpenCode by directory must never act on a space's directory. `injectEvent` enters an event from a space's own connection as if it arrived upstream, so it is numbered, coalesced, replayed and fanned out with the host's and a client keeps one cursor for everything. Browser clients receive those events too: each frame carries the space's directory, which is one more project directory to the UI.
- The translator is the single place that maps wire events onto the server vocabulary, so a server consumer never has to know which OpenCode shape produced its event. The browser translates raw payloads itself in `packages/ui/src/lib/opencode/events.ts`.
- A v2 turn is a sequence of steps. Each `session.step.ended` becomes an assistant `message.updated`, and only the last carries `finish: "stop"`, which is the signal v1 gave once per turn.
- Every translated event carries the source event id and its directory, because consumers deduplicate on the id and route their own OpenCode calls by directory. Execution events carry no location, so their directory is empty.
- v2 declares `session.status` and `session.idle` but a 2.0.2 server was observed never to emit them. Both are translated anyway, so a server that emits them stays correct. Retry state comes from `session.retry.scheduled` and is translated back onto the status vocabulary because the status chip still renders the attempt and its countdown.
- Every interruption except a shutdown ends the turn without failing it: it becomes `session.idle` with `aborted: true` and a `MessageAbortedError`. Consumers that treat `session.error` as a failure stay quiet, while the queue and goal runtimes still learn the turn was aborted.
- `session.compacted` is declared but never published; a finished compaction is announced only by `session.compaction.ended`.
- Structured errors carry both `name` and `type`, because consumers still read `name`.
- A shell command the user ran from the composer stays `session.shell.started`; it is not a user message.
- The global hub keeps a bounded replay buffer of every state frame committed in this process: OpenCode's own events and the local frames OpenCode cannot reconstruct. Each entry carries a stream position and the OpenCode id it sits after. A frame sent to a browser carries a versioned OpenChamber cursor (`occ1.global.<position>.<upstream>`); the browser stores the last applied frame's cursor and sends it back as `lastEventId`. A cursor is answered from the buffer when the buffer is contiguous from the frame it names, otherwise from durable local frames plus an upstream read, and otherwise with a reset. A raw OpenCode id is still accepted as a legacy cursor.
- Local frames (a synthetic announcement, an event with no OpenCode id) are written to the durable store before they are sent, together with the head position and upstream cursor. Upstream frames are not persisted: OpenCode replays them. The store is bounded by count, bytes and age; when a local frame is dropped, a cursor that would have replayed it gets `replayReset: true` and the browser refetches rather than skip it. A reset record does the same for a resync.
- A resume after an OpenChamber restart loads the persisted head, so the shared reader resumes from the last upstream cursor instead of starting at the tail, and replays the local frames the browser missed, interleaved with the upstream events they followed. A read that sees a local frame commit while it runs, or an upstream resync, resets the client.
- A frame is committed to the buffer and, for a local frame, to the durable store before it is sent, so a cursor never names a frame that cannot be replayed. Replay is duplicate-safe by position: a client receives exactly the frames after the position its cursor names, never one it already applied.
- Replay retains at most 2,048 events and 8 MiB of UTF-8 wire frames, and durable local frames at most 512 entries, 2 MiB and 24 hours. An oversized upstream event still reaches live clients in full, but clears the retained suffix so replay cannot cross its gap. A missing replay cursor returns `null`, distinct from a complete empty tail.
- The hub numbers every event that arrives without an SSE id (`oc-<process>-<sequence>`) so fan-out has an id; that id never reaches a browser. `server.connected` is OpenCode's greeting to one upstream connection, sent outside its feed. A greeting with an OpenCode id line is an ordinary upstream event; an id-less one goes live without a cursor and is never replayed, because the UI answers a greeting by re-reading the stores it shows and the background command lists. Subscribers receive an id-less greeting only when the connection may have lost events. A connection that resumed from an OpenCode cursor holds its greeting until its next event: a `server.resync` (the cursor aged out, or OpenCode restarted) passes it on, ahead of the resync and the `ready` `replayReset` that follows; a replayed or live event drops it, since OpenCode honoured the cursor and nothing was missed. This applies to the shared stream and to a client's own resume read. A connection without a cursor passes its greeting on at once (`global-resume.test.js`, "a reconnect that resumed from a cursor" and "a browser resumed on a read of its own"). When the shared stream's resync ends a client's own read first, that client gets the `ready` `replayReset` without the greeting, and the UI re-reads on that alone. Server-side subscribers, such as session warming's re-check after a gap, see the same stream.
- A client whose cursor the buffer cannot answer is resumed on a read of its own (see `openUpstreamAfter`). That read ends at the first event the buffer holds, and the client goes live after the buffer's tail from there. Or, when a connected read delivers nothing for the resume idle bound (10 s, `OPENCHAMBER_RESUME_IDLE_TIMEOUT_MS`), the read ends and the client goes live with nothing to replay, since OpenCode had nothing after the cursor. The bound is its own value, not derived from the stall window; it is meant to outlast a reader's reconnect, so a connection that went quiet is reconnected by its own reader before the read gives up on it. A read that never connected, or is down when the bound passes, refetches instead. `resumeIdleTimeoutMs` overrides the bound for a hub built in code.
- Directory WS clients still attach one upstream `/event?directory=...` SSE reader per connection because directory streams are scoped.
- If an upstream SSE stream stalls after the browser WS is already ready, the reader aborts that upstream fetch and reconnects upstream with `Last-Event-ID`, keeping the browser WS alive when recovery is fast.
- When the shared global upstream reconnects after it was previously ready, the global WS bridge sends a fresh `ready` frame to already-ready browser clients. The browser treats this as a reconnect edge and can run scoped state repair without requiring the browser WS to close.
- Health checks are reserved for initial upstream connect failures and explicit upstream-unavailable responses, not for ordinary stall recovery on an already-established stream.
- Global synthetic events such as `openchamber:session-status`, `openchamber:session-activity`, `openchamber:notification`, and `openchamber:heartbeat` are preserved on the WS path, but heartbeat frames are emitted only while an upstream SSE stream is actively attached.
- Global UI broadcasts are fan-out capable across both SSE and WS clients.
- Global UI broadcasts serialize once per wire format, irrespective of client count. The SSE writer accepts an optional pre-serialized payload; isolated callers keep the two-argument contract. Failed or backpressured clients cannot block delivery to healthy clients.
- The reusable upstream reader centralizes SSE fetch/parsing/reconnect behavior for the WS runtime and OpenCode watcher. Additional event consumers should move to it only with parity tests for their lifecycle and error semantics.
- Browser transport concerns live in the WS bridge modules; server-side global stream ownership lives in `global-hub.js`.

## Durable cursors and the delivery guarantee

The practical guarantee is replay with deduplication, not exactly-once delivery and not exactly-once side effects. A browser receives every frame after the position its cursor names, at most once per reconnect, and refetches when the server cannot honour the cursor. Server-side consumers that act on events (goals, notifications, queue) must still treat their own effects as idempotent: a frame can be delivered more than once across independent recovery paths, and a local frame can be replayed after a restart.

A cursor is invalid, expired or upstream-unhonourable when its stream token is not `global`, its position is beyond the head, a local frame it would need was dropped by retention, or OpenCode answers its upstream id with a resync. Each of these produces the existing `replayReset: true` ready frame and a refetch; none of them skips data.

Directory-scoped streams keep raw OpenCode ids and have no durable local frames: they are scoped to one directory and one reader per connection.

## Delta coalescing
OpenCode publishes one `message.part.delta` per token fragment. A 5.7 KB answer measured 3,402 delta events of 1.7 characters each, 97% of all frames and 1.3 MB on the wire. The hub merges them before replay and fan-out, which cut that stream to 483 frames and 197 KB with identical text. Replay holds merged frames too, so its 2,048 entries cover about seven times more streaming time.

Merging is lossless because of three rules. Change one only with the randomized test in `delta-coalescer.test.js` still passing.

- Every event that is not a well-formed delta is a barrier. All pending text is emitted before it, so a delta never crosses a part snapshot or a status change.
- Deltas of different part fields commute, so several stay pending at once. They are emitted in the order their latest fragment arrived, which keeps event ids in upstream order.
- A merged event carries the id of its last fragment. A client cursor is the id of the last frame it received, so it always names a boundary between merged events.

An event that is a delta type but does not match the schema is forwarded untouched as a barrier. Merged events are built from the original objects, so fields the schema does not name, including the reader's `eventId` and `directory`, survive. The type check runs before the schema, so events of other types never pay for parsing.

Pending text is bounded by time (the 50ms window), by size (64 KiB), and by part fields (64). Reaching a bound emits early. Nothing is dropped. The first delta after a quiet spell is emitted at once, so time to first text does not grow.

The hub commits pending text when it stops, so it reaches the retained replay suffix, and the global bridge commits it before it marks a socket ready. A client readied later therefore receives exactly the events that arrived after it was ready, as it did before coalescing, and a reconnecting client receives the committed text through replay.

Verified against a live server by dropping the socket every 150ms to 3s during a stream and resuming from the cursor: the reconstructed text matched byte for byte with no duplicate ids. Server-side hub subscribers receive merged events as well. None of them reads individual deltas.

The directory WS bridge and the SSE proxy (`/api/global/event`, used by Capacitor) still forward unmerged events.

## Decisions

### Why a versioned cursor and not a raw OpenCode id

OpenCode cannot replay an OpenChamber local frame, and a raw OpenCode id carries no OpenChamber position, so after a restart it can resume past a local frame the browser missed. The versioned cursor carries both the stream position and the upstream id; the `occ1.` prefix keeps it from ever being mistaken for an OpenCode id. Raw OpenCode ids remain accepted as a legacy cursor, and only while no local frame is known.

### Why partial SSE buffers are capped, and overflow drops the partial block

A separator-less upstream stream otherwise grows the reader's and the proxy cursor's partial-block buffers without bound, and the stall watchdog cannot help because it resets on every chunk. Overflow in the reader is observable: it reports `upstream_buffer_overflow`, aborts, and reconnects from the last complete event id, with a backoff counter that survives the reconnect's successful-response reset and only clears when a complete event is delivered, so a repeatedly flooding upstream backs off instead of hot-looping. The cursor has no error channel and its state only advances on complete blocks, so it drops the oversized partial block and keeps discarding through that block's terminating separator — resuming parsing immediately would let the remainder of the same block pose as a new block and corrupt its id — then parses the next complete block fresh.

### Why local frames are persisted and upstream frames are not

Upstream frames are reconstructible from OpenCode, so persisting them would duplicate the chat stream on disk and grow the store with the conversation. A local frame exists nowhere else, so it is written to the store before it is sent; the head position and upstream cursor are written with it so the shared reader resumes where it stopped.

### Why the position is committed before the frame is sent

A cursor names a frame the browser may have applied. If the frame were sent before its position was recorded, a restart between the two would leave the browser holding a cursor the server cannot replay and would have to reset it. Committing first makes the cursor always resolvable within retention.

### Why a resume read refetches when a local frame overtakes it

A per-client upstream read cannot place a local frame committed mid-read among the upstream frames it forwards. Refetching is the one extra round trip that keeps the client's state ordered; the durable store then replays the frame it missed.

### Why the wire contract retains arbitrary JSON

The SSE parser accepts every valid JSON value, including primitives and arrays. The transport forwards opaque payload fields unchanged, and the translator validates only the fields it reads. `contracts.ts` describes these JSON values separately from parsed envelope metadata, replay entries, socket operations and upstream lifecycle results. The delta schema checks the original event without replacing it with Zod's stripped output, so unrecognized fields and object identity survive forwarding and merging.

### Why subscriber results keep a rejection-handler guard

JavaScript subscribers can return incidental values, such as the length returned by `Array.push`. Only a result with a callable `catch` receives the rejection handler; scalar results stay ignored. Subscriber failures remain isolated from other subscribers.

### Why WebSocket composition uses shared contracts

The runtime imports the `ws` constructor at runtime and its socket types from `shared/websocket-contracts.js`. The shared declaration includes disabled client tracking, so shutdown checks the client collection inside the existing catch boundary. An absent collection still skips server close and clears the broadcast clients. Request URLs retain a string guard at the HTTP boundary; internal routing options use their declared string-or-null contract. Broadcaster payloads remain generic because serialization also accepts caller-owned objects with `toJSON`.

### Why a managed restart rebinds readers and does not wait for them to notice
A managed OpenCode restart can land on a new port while the old process, or an orphaned survivor of it, still holds the previous one. An SSE reader stays pinned to the URL it connected to and a healthy stream never notices, so the UI would stop receiving events until the app restarts (#2638). `rebindUpstream` restarts the shared hub, which re-dials `buildOpenCodeUrl` and reads the current port on its next attempt, and closes the directory-scoped client sockets. Those clients reconnect with `Last-Event-ID` and establish the stream against the new port. The runtime tracks directory sockets because a per-connection reader otherwise keeps streaming from the orphaned process.

### Why the hub withholds a resumed connection's greeting and not the UI

The UI cannot tell a greeting after a lossless resume from one after a restart: on the SSE paths (OpenChamber's OpenCode proxy and the VS Code extension's proxy) the greeting is the only loss signal it gets. The hub can, because it knows whether the connection carried a cursor and sees OpenCode's next event, which is a `server.resync` exactly when the cursor was not honoured. Gating inside the hub also keeps server-side subscribers, such as session warming, from re-checking after a lossless resume. Without the gate, every upstream reconnect made every window mark history stale and re-read the stores it shows, the background command lists and the active statuses.

## Notes for contributors
- Keep protocol helpers pure and small so they can be unit tested without spinning up a server.
- Keep `runtime.ts` focused on WebSocket upgrade and endpoint dispatch. Put global browser-client lifecycle in `global-ws-bridge.js`, directory stream lifecycle in `directory-ws-bridge.js`, and upstream stream sharing in `global-hub.js`.
- Do not change upstream OpenCode transport assumptions here; OpenCode remains SSE-based.
- Keep global replay bounded; do not turn it into an unbounded event log.

## Testing
- Run `bunx vitest run server/lib/event-stream` from `packages/web` for the whole module, including `delta-coalescer.test.js` and the resume-from-any-cursor cases in `global-hub.test.js`.
- Run `bun test packages/web/server/lib/event-stream/protocol.test.js`
- Run `bun test packages/web/server/lib/event-stream/translate-v2.test.js`
- Run `bun test packages/web/server/lib/event-stream/upstream-reader.test.js`
- Run `bun test packages/web/server/lib/event-stream/runtime.test.js`
- Run repo validation before finalizing: `bun run type-check`, `bun run lint`, `bun run build`
