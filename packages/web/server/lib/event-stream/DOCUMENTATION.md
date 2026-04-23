# Event Stream Module Documentation

## Purpose
This module contains the OpenChamber message-stream WebSocket protocol and runtime bridge. It keeps the browser-facing WebSocket transport separate from the upstream OpenCode SSE transport.

## Entrypoints and structure
- `packages/web/server/lib/event-stream/index.js`: public entrypoint re-exporting protocol and runtime helpers.
- `packages/web/server/lib/event-stream/protocol.js`: path constants, SSE envelope parsing, and WebSocket frame serialization helpers.
- `packages/web/server/lib/event-stream/runtime.js`: WebSocket server runtime, upgrade handling, SSE-to-WS bridging, and global event broadcasting.
- `packages/web/server/lib/event-stream/protocol.test.js`: unit tests for protocol helpers.
- `packages/web/server/lib/event-stream/runtime.test.js`: unit tests for runtime-side broadcaster behavior.

## Public exports

### Protocol helpers
- `MESSAGE_STREAM_GLOBAL_WS_PATH`: `/api/global/event/ws`
- `MESSAGE_STREAM_DIRECTORY_WS_PATH`: `/api/event/ws`
- `MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS`: heartbeat interval for browser-facing WS connections.
- `parseSseEventEnvelope(block)`: parses an SSE block into `{ eventId, directory, payload }`.
- `sendMessageStreamWsFrame(socket, payload)`: serializes and sends a JSON WS frame.
- `sendMessageStreamWsEvent(socket, payload, options)`: sends an event frame with optional `eventId` and `directory`.

### Runtime helpers
- `createGlobalUiEventBroadcaster({ sseClients, wsClients, writeSseEvent })`: returns a broadcaster that fans out the same synthetic UI event to SSE and WS clients.
- `createMessageStreamWsRuntime(...)`: mounts the message-stream WS server, upgrade handler, and SSE-to-WS bridge onto the web HTTP server.

## Runtime behavior
- Browser clients connect to the WS endpoints above.
- OpenChamber still fetches OpenCode upstream event streams over SSE.
- Each WS connection proxies one upstream SSE stream.
- If an upstream SSE stream stalls after the browser WS is already ready, the runtime aborts that upstream fetch and reconnects upstream with `Last-Event-ID`, keeping the browser WS alive when recovery is fast.
- Health checks are reserved for initial upstream connect failures and explicit upstream-unavailable responses, not for ordinary stall recovery on an already-established stream.
- Global synthetic events such as `openchamber:session-status`, `openchamber:session-activity`, `openchamber:notification`, and `openchamber:heartbeat` are preserved on the WS path, but heartbeat frames are emitted only while an upstream SSE stream is actively attached.
- Global UI broadcasts are fan-out capable across both SSE and WS clients.

## Notes for contributors
- Keep protocol helpers pure and small so they can be unit tested without spinning up a server.
- Keep runtime wiring in this module instead of `packages/web/server/index.js` unless the logic is strictly route-local glue.
- Do not change upstream OpenCode transport assumptions here; OpenCode remains SSE-based.
- If replay support is added later, add it here rather than growing `index.js`.

## Testing
- Run `bun test packages/web/server/lib/event-stream/protocol.test.js`
- Run `bun test packages/web/server/lib/event-stream/runtime.test.js`
- Run repo validation before finalizing: `bun run type-check`, `bun run lint`, `bun run build`
