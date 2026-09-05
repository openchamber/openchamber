# Terminal Subsystem

## Ownership

`runtime.js` owns terminal identity, PTY processes, launch mode, session purpose, ordered output, bounded scrollback, WebSocket attachments, and lifecycle routes. `shells.js` discovers executable shell families, resolves the persisted shell ID, and builds the per-shell argv for interactive versus command launches. Clients own tab arrangement. Interactive terminals use stable IDs; project actions keep a stable UI tab and allocate a fresh terminal ID for each command execution. Electron uses this same runtime in-process; VS Code returns an explicit unsupported error.

## Protocol

`/api/terminal/ws` is the only terminal data transport. It uses v3 binary JSON control frames and is opened through `openRuntimeWebSocket`, preserving direct, Electron proxy, URL-token authentication, and private-relay routing.

- `attach` registers a connection for one terminal. One socket may attach to many terminals.
- Every attach and reconnect begins with an authoritative `snapshot` containing bounded history and the current sequence.
- A current socket that closes or errors before its initial `open` invalidates its URL-scoped auth token before retrying, so retries mint a fresh token instead of backing off against a rejected upgrade. Hidden or offline clients wait 60 seconds and wake promptly on visibility/online recovery.
- `output`, `exit`, and `restarted` carry monotonically increasing per-terminal sequences. Output carries raw live bytes plus replay-safe bytes with terminal query exchanges removed.
- Attach registers before capturing the snapshot, buffers concurrent events, drops events represented by the snapshot sequence, then enters live delivery.
- `write` always includes the terminal ID; sockets never have mutable single-terminal binding state.
- `detach` removes only that attachment.
- Creation carries the active UI appearance. The PTY sets `COLORFGBG` and answers OSC 10, OSC 11, Mode 2031, and primary-device-attribute queries immediately, including queries emitted before a WebSocket attachment exists. The DA1 fallback prevents Fish from waiting ten seconds for a renderer that cannot observe or answer its startup query. Subscribed TUIs receive a Mode 2031 notification when the appearance changes.

HTTP remains the authenticated command plane for create, resize, appearance updates, restart, close, and force-kill. There is no SSE output or HTTP input compatibility path.

`GET /api/terminal/sessions` enumerates live sessions (optionally filtered by resolved `cwd`) so clients can adopt terminals their local tab projection does not know about — another device, a new browser tab, or cleared storage. Listings include the effective launch mode and the normalized purpose, but never the command text. `POST /api/terminal/touch` refreshes `lastActivity` for the listed session ids; open clients call it periodically so background tabs, which hold no WebSocket attachment, are not idle-reaped while a client still shows them.

## PTY Lifecycle

- IDs are client-provided or generated with `randomUUID()`.
- Create defaults to interactive mode. Command mode requires a non-empty trimmed command no longer than the terminal input limit and launches the shell so the PTY exits when that command exits. Each session also carries a normalized purpose. Omitted purpose means `{ type: 'terminal' }`. Project actions use `{ type: 'project-action', actionId, executionId }`, and the server validates both IDs as non-empty bounded strings. Create responses and attach snapshots echo the effective mode and purpose.
- Concurrent creates for one ID are single-flight only when working directory, shell preference, login mode, launch mode, and session purpose match. Command-mode creates must also match the command text, unless the purpose is a project action that is already running for the same resolved `(cwd, actionId)` pair. In that case the runtime returns the existing session and its existing execution identity, even when another client requested a different session ID. Existing IDs cannot be reused for another working directory or another purpose.
- Dimensions are bounded to 1-1000 columns and 1-500 rows; input is capped at 64 KiB.
- A client may create before its renderer has mounted. It derives an initial size from the container and font metrics (falling back to 80x24 when unavailable), then sends a resize once Ghostty reports its final dimensions. This allows shell startup and renderer initialization to overlap.
- PTY children explicitly clear `NODE_CHANNEL_FD`; daemon IPC descriptors are host-private and invalid after PTY descriptor cleanup.
- PTY children also strip AppImage `ARGV0` (and other host-private shell vars such as `ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, `BASH_XTRACEFD`). An exported `ARGV0` makes zsh rewrite argv[0] for every external command, which breaks Python venv detection and other argv[0]/$0 consumers while leaving `/proc/self/exe` correct. On Linux, PTY spawn is wrapped with `env -u ARGV0` because `bun-pty` merges the native OS environ and would otherwise reintroduce `ARGV0` after a JS-only delete.
- `GET /api/terminal/shells` reports shell IDs available on the active server using the same augmented PATH provided to spawned PTYs, plus whether each executable has a supported login-mode argument. `auto` preserves environment/platform fallback order; an explicit unavailable shell fails creation instead of silently running a different shell. Login mode is opt-in and uses only built-in arguments for known shells. Interactive shells still launch as before. Command-mode launches reuse the same environment and login support, but switch argv by shell family: POSIX and Fish use interactive `-c`, Nushell uses `-c`, PowerShell uses `-Command`, and cmd uses `/d /s /c`. Preference changes affect new sessions and explicit restarts, not running PTYs.
- PTY data and exit callbacks enter one FIFO queue. The runtime wires those listeners in the same synchronous turn that receives the PTY object. `node-pty` and `bun-pty` both expose the PTY before dispatching registered callbacks. If a backend emitted exit before listener registration, this layer could not recover it, so the wiring stays adjacent to PTY creation.
- Scrollback is retained on the server and capped at 512 KiB with UTF-8-safe trimming. Device-status, device-attribute, cursor-position reply, and color-query exchanges are removed from replay history with incomplete control sequences carried across PTY chunks; live output remains byte-for-byte unchanged.
- Exited sessions remain attachable until explicit close, idle cleanup, or a successful replacement of the same project action. Creating a replacement retires only exited records for the same resolved directory and action, after the new PTY starts. Failed creation preserves the old record and output. These replaced records do not exhaust the terminal capacity limit.
- Deduplicated create responses may describe another client's execution. Cancellation cleanup closes only the terminal ID allocated for the cancelled request; it never closes an adopted peer execution.
- Create and restart validate the working directory with a real `stat` and answer HTTP 400 `Invalid working directory` when it is not a directory. When the path does not exist at all (`ENOENT`/`ENOTDIR`, a worktree deleted outside OpenChamber) the body also carries `code: "TERMINAL_CWD_MISSING"`. That is the one rejection the client can recover from: the session, not the terminal, is stranded, and the shared UI moves it to its project directory and starts a terminal there. Every other rejection stays generic; the runtime never substitutes a parent directory on its own.
- Restarts are serialized per terminal. Each restart spawns and wires the replacement before terminating the old process, retaining the terminal ID. Command-mode sessions reject restart with HTTP 400 instead of silently turning into interactive shells with stale action metadata.
- A delete that arrives while create is still pending leaves a cancellation tombstone. When the PTY arrives, the runtime terminates it immediately, never inserts the session into the live map, and returns a create error while the delete still succeeds.
- Close uses SIGTERM with bounded SIGKILL escalation. Force-kill, idle cleanup, and runtime shutdown terminate process groups immediately where supported. Removal explicitly sends a fatal scoped closure and evicts client projections even when a PTY backend fails to emit `onExit`; attached terminals are not considered idle.

## Security And Relay

The WebSocket path must remain in both `isUrlAuthWebSocketPath` and relay `ALLOWED_WS_PATHS`. The client must use `getRuntimeUrlResolver().websocket()` and `openRuntimeWebSocket`; direct local URLs or raw browser WebSockets break relay and URL-token authentication.

## Verification

Run:

```sh
bun test packages/web/server/lib/terminal/runtime.test.js packages/web/server/lib/terminal/terminal-ws-protocol.test.js
bun test packages/web/server/lib/ui-auth/ui-auth.test.js packages/web/server/lib/relay/cross-compat.test.js
```
