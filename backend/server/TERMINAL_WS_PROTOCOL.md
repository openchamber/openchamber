# Terminal WebSocket Transport Protocol

## Goal
Use a single persistent WebSocket for terminal input and output, while keeping the legacy SSE output route and HTTP input route as compatibility fallbacks.

## Scope
- Primary full-duplex path: WebSocket (`/api/terminal/ws`)
- Legacy output fallback: SSE (`/api/terminal/:sessionId/stream`)
- HTTP input fallback remains: `POST /api/terminal/:sessionId/input`

## Framing
- Text frame:
  - client -> server: terminal keystroke payload
  - server -> client: raw PTY output chunk
- Binary frame: control envelope
  - Byte 0: tag (`0x01` = JSON control)
  - Bytes 1..N: UTF-8 JSON payload

## Control Messages
- Bind active socket to terminal session:
  - client -> server: `{"t":"b","s":"<sessionId>","v":2}`
- Keepalive ping:
  - client -> server: `{"t":"p","v":2}`
  - server -> client: `{"t":"po","v":2}`
- Server control responses:
  - ready: `{"t":"ok","v":2}`
  - bind ok: `{"t":"bok","s":"<sessionId>","runtime":"node|bun","ptyBackend":"...","v":2}`
  - exit: `{"t":"x","s":"<sessionId>","exitCode":0,"signal":null}`
  - error: `{"t":"e","c":"<code>","f":true|false}`

## Multiplexing Model
- Single shared socket per client runtime.
- Socket has one mutable bound session.
- Client sends a bind control when the active terminal changes.
- Text frames always apply to the currently bound session.
- PTY output is pushed back over the same socket as text frames.
- Client keeps the socket primed so both stream subscription and input reuse the same transport.

## Security
- UI auth session required when UI password is enabled.
- Origin validation enforced for cookie-authenticated browser upgrades.
- Invalid or malformed frames are rate-limited and may close the socket.

## Fallback Behavior
- New clients prefer `capabilities.stream.ws` and reuse the same socket for input.
- If stream WebSocket capability is unavailable, clients fall back to SSE output.
- If terminal input cannot be sent over WebSocket, clients fall back to HTTP input.
- The removed `/api/terminal/input-ws` path should fail with `404 Not Found`.
