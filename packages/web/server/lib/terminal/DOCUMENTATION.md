# Terminal Subsystem

## Ownership

`runtime.js` owns terminal identity, PTY processes, status, ordered output, bounded scrollback, WebSocket attachments, and lifecycle routes. `shells.js` discovers executable shell families and resolves the persisted shell ID without accepting command strings or arguments. Clients own tab arrangement and choose stable terminal IDs. Electron uses this same runtime in-process; VS Code returns an explicit unsupported error.

## Protocol

`/api/terminal/ws` is the only terminal data transport. It uses v3 binary JSON control frames and is opened through `openRuntimeWebSocket`, preserving direct, Electron proxy, URL-token authentication, and private-relay routing.

- `attach` registers a connection for one terminal. One socket may attach to many terminals.
- Every attach and reconnect begins with an authoritative `snapshot` containing bounded history and the current sequence.
- `output`, `exit`, and `restarted` carry monotonically increasing per-terminal sequences. Output carries raw live bytes plus replay-safe bytes with terminal query exchanges removed.
- Attach registers before capturing the snapshot, buffers concurrent events, drops events represented by the snapshot sequence, then enters live delivery.
- `write` always includes the terminal ID; sockets never have mutable single-terminal binding state.
- `detach` removes only that attachment.
- Creation carries the active UI appearance. The PTY sets `COLORFGBG` and answers OSC 10, OSC 11, and Mode 2031 queries immediately, including queries emitted before a WebSocket attachment exists. Subscribed TUIs receive a Mode 2031 notification when the appearance changes.

HTTP remains the authenticated command plane for create, resize, appearance updates, restart, close, and force-kill. There is no SSE output or HTTP input compatibility path.

## PTY Lifecycle

- IDs are client-provided or generated with `randomUUID()`.
- Concurrent creates for one ID are single-flight only when working directory and shell preference match. Existing IDs cannot be reused for another working directory.
- Dimensions are bounded to 1-1000 columns and 1-500 rows; input is capped at 64 KiB.
- PTY children explicitly clear `NODE_CHANNEL_FD`; daemon IPC descriptors are host-private and invalid after PTY descriptor cleanup.
- `GET /api/terminal/shells` reports shell IDs available on the active server using the same augmented PATH provided to spawned PTYs, plus whether each executable has a supported login-mode argument. `auto` preserves environment/platform fallback order; an explicit unavailable shell fails creation instead of silently running a different shell. Login mode is opt-in and uses only built-in arguments for known shells. Preference changes affect new sessions and explicit restarts, not running PTYs.
- PTY data and exit callbacks enter one FIFO queue. Stale callbacks from replaced processes are ignored.
- Scrollback is retained on the server and capped at 512 KiB with UTF-8-safe trimming. Device-status, device-attribute, cursor-position reply, and color-query exchanges are removed from replay history with incomplete control sequences carried across PTY chunks; live output remains byte-for-byte unchanged.
- Exited sessions remain attachable until explicit close or idle cleanup.
- Restarts are serialized per terminal. Each restart spawns and wires the replacement before terminating the old process, retaining the terminal ID.
- Close uses SIGTERM with bounded SIGKILL escalation. Force-kill, idle cleanup, and runtime shutdown terminate process groups immediately where supported. Removal explicitly sends a fatal scoped closure and evicts client projections even when a PTY backend fails to emit `onExit`; attached terminals are not considered idle.

## Security And Relay

The WebSocket path must remain in both `isUrlAuthWebSocketPath` and relay `ALLOWED_WS_PATHS`. The client must use `getRuntimeUrlResolver().websocket()` and `openRuntimeWebSocket`; direct local URLs or raw browser WebSockets break relay and URL-token authentication.

## Verification

Run:

```sh
bun test packages/web/server/lib/terminal/runtime.test.js packages/web/server/lib/terminal/terminal-ws-protocol.test.js
bun test packages/web/server/lib/ui-auth/ui-auth.test.js packages/web/server/lib/relay/cross-compat.test.js
```
