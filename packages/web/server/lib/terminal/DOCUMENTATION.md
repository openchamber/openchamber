# Terminal Module Documentation

## Purpose
This module provides WebSocket protocol utilities for terminal input handling in the web server runtime, including message normalization, control frame parsing, rate limiting, and pathname resolution for terminal WebSocket connections.

## Entrypoints and structure
- `packages/web/server/lib/terminal/`: Terminal module directory.
  - `index.js`: Stable module entrypoint that re-exports protocol helpers/constants.
  - `input-ws-protocol.js`: Single-file module containing all terminal input WebSocket protocol utilities.
- `packages/web/server/lib/terminal/input-ws-protocol.test.js`: Test file for protocol utilities.

Public API entry point: imported by `packages/web/server/index.js` from `./lib/terminal/index.js`.

## Public exports

### Constants
- `TERMINAL_INPUT_WS_PATH`: WebSocket endpoint path (`/api/terminal/input-ws`).
- `TERMINAL_INPUT_WS_CONTROL_TAG_JSON`: Control frame tag byte (0x01) indicating JSON payload.
- `TERMINAL_INPUT_WS_MAX_PAYLOAD_BYTES`: Maximum payload size (64KB).

### Request Parsing
- `parseRequestPathname(requestUrl)`: Extracts pathname from request URL string. Returns empty string for invalid inputs.

### Message Normalization
- `normalizeTerminalInputWsMessageToBuffer(rawData)`: Normalizes various data types (Buffer, Uint8Array, ArrayBuffer, string, chunk arrays) to a single Buffer.
- `normalizeTerminalInputWsMessageToText(rawData)`: Normalizes data to UTF-8 text string. Passes through strings directly, converts binary data to text.

### Control Frame Handling
- `readTerminalInputWsControlFrame(rawData)`: Parses WebSocket message as control frame. Returns parsed JSON object or null if invalid/malformed. Validates control tag prefix and JSON structure.
- `createTerminalInputWsControlFrame(payload)`: Creates a control frame with JSON payload. Prepends control tag byte.

### Rate Limiting
- `pruneRebindTimestamps(timestamps, now, windowMs)`: Filters timestamps to keep only those within the active time window.
- `isRebindRateLimited(timestamps, maxPerWindow)`: Checks if rebind operations have exceeded rate limit threshold.

## Response contracts

### Control Frame
Control frames use binary encoding:
- First byte: `TERMINAL_INPUT_WS_CONTROL_TAG_JSON` (0x01)
- Remaining bytes: UTF-8 encoded JSON object
- Parsed result: Object or null on parse failure

### Normalized Buffer
Input types are normalized to Buffer:
- `Buffer`: Returned as-is
- `Uint8Array`/`ArrayBuffer`: Converted to Buffer
- `String`: Converted to UTF-8 Buffer
- `Array<Buffer|string|Uint8Array>`: Concatenated to single Buffer

### Rate Limiting
Rate limiting uses timestamp arrays:
- `pruneRebindTimestamps`: Returns filtered array of active timestamps
- `isRebindRateLimited`: Returns boolean indicating if limit is reached

## Usage in web server

The terminal protocol utilities are used by `packages/web/server/index.js` for:
- WebSocket endpoint path definition (`TERMINAL_INPUT_WS_PATH`)
- Message normalization for input handling
- Control frame parsing for session binding
- Rate limiting for session rebind operations
- Request pathname parsing for WebSocket routing

The web server uses these utilities in combination with `bun-pty` or `node-pty` for PTY session management.

## Notes for contributors

### Adding New Control Frame Types
1. Define new control tag constants (e.g., `TERMINAL_INPUT_WS_CONTROL_TAG_CUSTOM = 0x02`)
2. Update `readTerminalInputWsControlFrame` to handle new tag type
3. Update `createTerminalInputWsControlFrame` or create new frame creation function
4. Add corresponding tests in `terminal-input-ws-protocol.test.js`

### Message Normalization
- Always normalize incoming WebSocket messages before processing
- Use `normalizeTerminalInputWsMessageToBuffer` for binary data
- Use `normalizeTerminalInputWsMessageToText` for text data (terminal escape sequences)
- Normalize chunked messages from WebSocket fragmentation handling

### Rate Limiting
- Rate limiting is time-window based: tracks timestamps within a rolling window
- Use `pruneRebindTimestamps` to clean up stale timestamps before rate limit checks
- Configure `maxPerWindow` based on operational requirements (prevent abuse)

### Error Handling
- `readTerminalInputWsControlFrame` returns null for invalid/malformed frames
- `parseRequestPathname` returns empty string for invalid URLs
- Callers should handle null/empty returns gracefully

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes
- Test edge cases: empty payloads, malformed JSON, chunked messages, rate limit boundaries
- Verify control frame roundtrip: create → read → validate payload equality
- Test pathname parsing with relative URLs, absolute URLs, and invalid inputs

## Verification notes

### Manual verification
1. Start web server and create terminal session via `/api/terminal/create`
2. Connect to `/api/terminal/input-ws` WebSocket
3. Send control frames with valid/invalid payloads to verify parsing
4. Test message normalization with various data types
5. Verify rate limiting by issuing rapid rebind requests

### Automated verification
- Run test file: `bun test packages/web/server/lib/terminal/input-ws-protocol.test.js`
- Protocol tests should pass covering:
  - WebSocket path constant
  - Control frame encoding/decoding
  - Payload validation
  - Message normalization (all data types)
  - Pathname parsing
  - Rate limiting logic
