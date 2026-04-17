# Terminal Module Documentation

## Purpose
This module provides WebSocket transport utilities for terminal input and output in the web server runtime, including message normalization, control frame parsing, rate limiting, pathname resolution, and short-lived output replay buffering for terminal WebSocket connections.

## Entrypoints and structure
- `packages/web/server/lib/terminal/`: Terminal module directory.
- `index.js`: Stable module entrypoint that re-exports protocol helpers and replay-buffer helpers.
- `runtime.js`: Runtime module that owns terminal session state, WS server setup, and `/api/terminal/*` route registration.
- `session.js`: PTY session factory and shell preference resolution helpers.
- `terminal-ws-protocol.js`: Single-file module containing terminal WebSocket protocol utilities.
- `output-replay-buffer.js`: Helper module for buffering recent terminal output so late subscribers can receive startup prompt data.
- `session.test.js`: Test file for shell preference resolution and PTY session creation behavior.
- `packages/web/server/lib/terminal/terminal-ws-protocol.test.js`: Test file for protocol utilities.
- `packages/web/server/lib/terminal/output-replay-buffer.test.js`: Test file for replay buffer helpers.

Public API entry point: imported by `packages/web/server/index.js` from `./lib/terminal/index.js`.

## Public exports

### Constants
- `TERMINAL_WS_PATH`: Primary WebSocket endpoint path (`/api/terminal/ws`).
- `TERMINAL_WS_CONTROL_TAG_JSON`: Control frame tag byte (`0x01`) indicating JSON payload.
- `TERMINAL_WS_MAX_PAYLOAD_BYTES`: Maximum inbound WebSocket payload size (64KB).
- `TERMINAL_OUTPUT_REPLAY_MAX_BYTES`: Maximum buffered terminal output retained for replay (64KB).

### Request Parsing
- `parseRequestPathname(requestUrl)`: Extracts pathname from request URL string. Returns empty string for invalid inputs.
- `isTerminalWsPathname(pathname)`: Returns whether a pathname matches a supported terminal WebSocket route.

### Message Normalization
- `normalizeTerminalWsMessageToBuffer(rawData)`: Normalizes various data types (Buffer, Uint8Array, ArrayBuffer, string, chunk arrays) to a single Buffer.
- `normalizeTerminalWsMessageToText(rawData)`: Normalizes data to UTF-8 text string.

### Control Frame Handling
- `readTerminalWsControlFrame(rawData)`: Parses WebSocket message as control frame. Returns parsed JSON object or null if invalid or malformed.
- `createTerminalWsControlFrame(payload)`: Creates a control frame with JSON payload and prepends the control tag byte.

### Replay Buffer Helpers
- `createTerminalOutputReplayBuffer()`: Creates mutable state for recent terminal output replay.
- `appendTerminalOutputReplayChunk(bufferState, data, maxBytes?)`: Appends a chunk, trimming older buffered data to stay within the configured byte budget.
- `listTerminalOutputReplayChunksSince(bufferState, lastSeenId)`: Returns buffered chunks newer than the provided replay cursor.
- `getLatestTerminalOutputReplayChunkId(bufferState)`: Returns the latest chunk id in the replay buffer, or `0` when empty.

### Rate Limiting
- `pruneRebindTimestamps(timestamps, now, windowMs)`: Filters timestamps to keep only those within the active time window.
- `isRebindRateLimited(timestamps, maxPerWindow)`: Checks if rebind operations have exceeded the configured threshold.

## Usage in web server
The terminal helpers are used by `packages/web/server/index.js` for:
- WebSocket endpoint path definition and matching
- Message normalization for terminal input payloads
- Control frame parsing for session binding, keepalive, and exit signaling
- Rate limiting for session rebind operations
- Request pathname parsing for WebSocket routing
- Replaying startup output such as shell prompts when the client binds after the PTY already emitted data

The web server combines these utilities with `bun-pty` or `node-pty` to drive full-duplex PTY sessions.

Project-specific terminal abstraction rules live in `openchamber-src/docs/Platform_Abstractions.md` under **Terminal Abstractions**.

## Notes for contributors
- Keep control frames backward-compatible when possible; use explicit `v` values for protocol changes.
- Always normalize incoming WebSocket messages before processing them.
- Keep replay buffering small and memory-only; it exists to cover startup races, not to implement persistent scrollback.
- Add tests for new control frame types, websocket path changes, malformed payload handling, and replay trimming semantics.
- Keep HTTP input and SSE output fallbacks functional unless the rollout explicitly removes them.

## Verification notes
### Manual verification
1. Start the web server and create a terminal session via `/api/terminal/create`.
2. Wait briefly before binding the client to ensure the shell emits its prompt first.
3. Connect to `/api/terminal/ws` WebSocket and bind to the session.
4. Verify the startup prompt and early shell output are replayed before interactive input begins.
5. Verify `/api/terminal/input-ws` is rejected with `404 Not Found` and `/api/terminal/:sessionId/stream` still works as a fallback path.

### Automated verification
- Run `bun test packages/web/server/lib/terminal/terminal-ws-protocol.test.js`
- Run `bun test packages/web/server/lib/terminal/output-replay-buffer.test.js`
- Run `bun test packages/web/server/lib/terminal/session.test.js`
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
