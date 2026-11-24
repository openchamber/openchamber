# Terminal Subsystem

## Ownership

`runtime.ts` owns terminal identity, PTY processes, launch mode, session purpose, ordered output, bounded scrollback, WebSocket attachments, and lifecycle routes. `shutdown.ts` owns bounded runtime-wide process cleanup. `shells.ts` discovers executable shell families, resolves the persisted shell ID, and builds the per-shell argv for interactive versus command launches. Clients own tab arrangement. Interactive terminals use stable IDs; project actions keep a stable UI tab and allocate a fresh terminal ID for each command execution. Electron uses this same runtime in-process; VS Code returns an explicit unsupported error.

## Protocol

`/api/terminal/ws` is the only terminal data transport. It uses v3 binary JSON control frames and is opened through `openRuntimeWebSocket`, preserving direct, Electron proxy, URL-token authentication, and private-relay routing.

- `attach` registers a connection for one terminal. One socket may attach to many terminals.
- Every attach and reconnect begins with an authoritative `snapshot` containing bounded history, the current sequence, and the PTY `cols`/`rows` the history was drawn for. The client replays the history at that size before fitting its viewport; replaying shell output at another width leaves stray fragments that the shell's own SIGWINCH redraw never clears. An attach sent with `z: 1` gets that snapshot as a `0x02` frame, the same JSON gzipped, when it is 4 KiB or more; every other frame stays `0x01` JSON. The client asks only where `DecompressionStream` exists, applies frames in arrival order while one is being gunzipped, and after a failed gunzip reconnects and attaches without `z`.
- A current socket that closes or errors before its initial `open` invalidates its URL-scoped auth token before retrying, so retries mint a fresh token instead of backing off against a rejected upgrade. Hidden or offline clients wait 60 seconds and wake promptly on visibility/online recovery.
- `output`, `exit`, and `restarted` carry monotonically increasing per-terminal sequences. PTY output arriving within 12 ms is joined into one output frame; reaching 32,768 UTF-16 code units flushes the batch immediately. The first output after a quiet spell flushes without waiting, so a keystroke echo is not held by the batch window, and the window reopens for as long as a burst continues. Output carries the unchanged raw stream plus replay-safe text with terminal query exchanges removed. Pending output flushes before exit, restart, close, force-kill, and attach snapshots, so the snapshot sequence covers its history. A socket is terminated when its next frame would exceed 4 MiB of queued data. Reconnect starts with a fresh snapshot of the latest 512 KiB; output older than that may be unavailable to the disconnected client.
- Attach registers before capturing the snapshot, buffers concurrent events, drops events represented by the snapshot sequence, then enters live delivery.
- `write` always includes the terminal ID; sockets never have mutable single-terminal binding state.
- `detach` removes only that attachment.
- Creation carries the active UI appearance. The PTY sets `COLORFGBG` and answers OSC 10, OSC 11, Mode 2031, and primary-device-attribute queries immediately, including queries emitted before a WebSocket attachment exists. The DA1 fallback prevents Fish from waiting ten seconds for a renderer that cannot observe or answer its startup query. Subscribed TUIs receive a Mode 2031 notification when the appearance changes.

HTTP remains the authenticated command plane for create, resize, appearance updates, restart, close, and force-kill. There is no SSE output or HTTP input compatibility path.

`GET /api/terminal/sessions` enumerates live sessions (optionally filtered by resolved `cwd`) so clients can adopt terminals their local tab projection does not know about — another device, a new browser tab, or cleared storage. Listings include the effective launch mode and the normalized purpose, but never the command text. `POST /api/terminal/touch` refreshes `lastActivity` for the listed session ids; open clients call it periodically so background tabs, which hold no WebSocket attachment, are not idle-reaped while a client still shows them.

The runtime also exposes `listTerminals({ directory })` and `readTerminal(sessionId, { maxBytes })` to in-process callers such as a server-side agent tool; the sessions route is built from `listTerminals`, so HTTP and in-process listings cannot drift. Both read the same sanitized replay text the `attach` snapshot sends — never raw bytes and never a new HTTP surface. `readTerminal` returns it as plain text (`plain-text.js`): the replay keeps colours, titles, hyperlinks and cursor controls for the panel to redraw, and the read drops every escape and control sequence, applying only carriage return, backspace and erase-in-line so a progress line reads as it finally showed. The conversion happens before the byte cap, so the cap counts readable text. A surrogate pair occupies one cell, so a carriage return overwrite cannot split it. The replay is bounded to 512 KiB per terminal, and a caller's byte cap defaults to 32 KiB and never exceeds 256 KiB; `retainedBytes` is the replay size, controls included. `truncated` reports that retained output may have been dropped: the first clear of the original UTF-16 state and a byte cap below the retained history both count, which can over-report when a trim removed nothing and never under-reports a dropped byte. When the cap starts the read mid-line, the read resumes at the next full line, and a single unterminated line is returned as it is. A read only copies in-memory state: it never starts, writes, resizes, or restarts a PTY, never changes `lastActivity`, and never publishes a WebSocket frame, so an attached client's stream is untouched. Exited terminals that are still in the map remain readable.

`createSession(fields, agentSessionId)` and `closeTerminal(sessionId)` are the in-process create and close the project actions agent tool uses (`../openchamber-control/project-actions.js`). The create is the one behind `POST /api/terminal/create` and answers the terminal id it settled on, so for an action already running in that folder it answers that run's id and nothing spawns; the close is the `DELETE` route's.

## PTY Lifecycle

- IDs are client-provided or generated with `randomUUID()`.
- Create defaults to interactive mode. Command mode requires a non-empty trimmed command no longer than the terminal input limit and launches the shell so the PTY exits when that command exits. Each session also carries a normalized purpose. Omitted purpose means `{ type: 'terminal' }`. Project actions use `{ type: 'project-action', actionId, executionId }`, and the server validates both IDs as non-empty bounded strings. A run an agent started through the agent tool also carries `agentSessionId`, the OpenCode session it belongs to; only the in-process `createSession` sets it, and an HTTP create that sends one has it dropped, so no client can pass its run off as an agent's. Create responses, listings and attach snapshots echo the effective mode and purpose.
- Concurrent creates for one ID are single-flight only when working directory, shell preference, login mode, launch mode, and session purpose match. Command-mode creates must also match the command text, unless the purpose is a project action that is already running for the same resolved `(cwd, actionId)` pair. In that case the runtime returns the existing session and its existing execution identity, even when another client requested a different session ID. Existing IDs cannot be reused for another working directory or another purpose.
- Dimensions are bounded to 1-1000 columns and 1-500 rows; input is capped at 64 KiB.
- A client may create before its renderer has mounted. It derives an initial size from the container and font metrics (falling back to 80x24 when unavailable), then sends a resize once Ghostty reports its final dimensions. This allows shell startup and renderer initialization to overlap.
- PTY children never inherit `NODE_CHANNEL_FD`; daemon IPC descriptors are host-private and invalid after PTY descriptor cleanup, and an inherited value (even empty) makes Node CLIs such as opencode print `Failed to parse IPC channel number` on exit.
- PTY children get the user's and the project's environment variables from Settings for their working directory (`environmentRuntime.applyToDirectory`, see `../environment`) under the terminal's own `TERM`/`COLORTERM`/`COLORFGBG` and before the host-private removals below, so a project variable cannot bring those back. Project actions run through the terminal and get the same. Create and restart refresh the project's environment command because opening a terminal or running a project action is the user's own act.
- PTY children also strip AppImage `ARGV0` (and other host-private shell vars such as `ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, `BASH_XTRACEFD`). An exported `ARGV0` makes zsh rewrite argv[0] for every external command, which breaks Python venv detection and other argv[0]/$0 consumers while leaving `/proc/self/exe` correct. On POSIX, PTY spawn is wrapped with `env -u ARGV0 -u NODE_CHANNEL_FD` (`resolvePosixPtyLaunch`) because a PTY backend that merges the native OS environ (`bun-pty` did before 0.5) would otherwise reintroduce both after a JS-only delete; with bun-pty 0.5 the child gets exactly the `env` passed, and the wrapper stays as the guard.
- Inside a Linux AppImage (`APPDIR` set), PTY children, the managed OpenCode server and the server's git environment (`buildGitEnv`) also lose what the AppImage launcher added to `PATH`, `LD_LIBRARY_PATH`, `GSETTINGS_SCHEMA_DIR` and `XDG_DATA_DIRS` (`stripAppImageLauncherEnv`): the mount's `usr/lib`, `usr/share` and `usr/sbin`, the mount root, the relative `./share/`, and the empty entries the launcher leaves when a variable was unset. Otherwise user tools load the app's bundled libraries, and an empty `LD_LIBRARY_PATH` entry makes the dynamic linker search the current directory (#4177). The user's own entries and the bundled OpenCode CLI directory stay. No `env -u` is needed: only Electron runs from an AppImage, and its `node-pty` uses the given env as is.
- `GET /api/terminal/shells` reports shell IDs available on the active server using the same augmented PATH provided to spawned PTYs, plus whether each executable has a supported login-mode argument. `auto` preserves environment/platform fallback order; an explicit unavailable shell fails creation instead of silently running a different shell. Login mode is opt-in and uses only built-in arguments for known shells. Interactive shells still launch as before. Command-mode launches reuse the same environment and login support, but switch argv by shell family: POSIX and Fish use interactive `-c`, Nushell uses `-c`, PowerShell uses `-Command`, and cmd uses `/d /s /c`. Preference changes affect new sessions and explicit restarts, not running PTYs.
- PTY data and exit callbacks enter one FIFO queue. The runtime wires those listeners in the same synchronous turn that receives the PTY object. `node-pty` and `bun-pty` both expose the PTY before dispatching registered callbacks. If a backend emitted exit before listener registration, this layer could not recover it, so the wiring stays adjacent to PTY creation.
- Scrollback is retained in 8 KiB byte and UTF-16 segments on the server and capped at 512 KiB with UTF-8-safe trimming. An oversized PTY callback retains only copied suffix segments, so the whole callback allocation can be released. Snapshot assembly happens on attach, not on each PTY callback. Before the first trim, the queue preserves original UTF-16 text, including surrogate pairs split across callbacks. The client also retains byte-counted projection history and assembles its text for a late subscriber. Device-status, device-attribute, cursor-position reply, and color-query exchanges are removed from replay history; live output remains byte-for-byte unchanged.
- Replay parsing scans each new PTY chunk without rescanning carried control text. Incomplete sequences retain copied UTF-16 fragments totaling at most 8,192 code units, including introducers and terminators. Larger sequences are omitted from replay even when they complete in one callback. After overflow, the parser discards payload through BEL, C1 ST, or ESC ST for string controls, or the final byte for CSI and ESC controls. A trailing ESC remains recognizable across callbacks. Replay parsing recognizes all six control introducers, ESC, DCS, CSI, OSC, PM and APC, each as ESC plus a following byte and as its own C1 code point; one missing from the set leaks a query byte into replay text. Process exit, create, and restart clear pending replay and theme-query state.
- Exited sessions remain attachable until explicit close, idle cleanup, or a successful replacement of the same project action. Creating a replacement retires only exited records for the same resolved directory and action, after the new PTY starts. Failed creation preserves the old record and output. These replaced records do not exhaust the terminal capacity limit.
- Deduplicated create responses may describe another client's execution. Cancellation cleanup closes only the terminal ID allocated for the cancelled request; it never closes an adopted peer execution.
- Create and restart validate the working directory with a real `stat` and answer HTTP 400 `Invalid working directory` when it is not a directory. When the path does not exist at all (`ENOENT`/`ENOTDIR`, a worktree deleted outside OpenChamber) the body also carries `code: "TERMINAL_CWD_MISSING"`. The client shows the failure without moving the session, and the code is named because this is the one rejection the client can act on by moving the session to its project; every other rejection stays generic. The string is mirrored by `TERMINAL_CWD_MISSING_CODE` in `packages/ui/src/lib/terminalApi.ts`, and both change together. The runtime never substitutes a parent directory on its own.
- Restarts are serialized per terminal. Each restart spawns and wires the replacement before terminating the old process, retaining the terminal ID. Command-mode sessions reject restart with HTTP 400 instead of silently turning into interactive shells with stale action metadata.
- A restart rechecks session ownership before and after PTY creation. Close, force-kill, idle removal, or shutdown can invalidate it while spawn is pending. A late replacement is terminated instead of being attached to a retired session.
- A delete that arrives while create is still pending leaves a cancellation tombstone. When the PTY arrives, the runtime terminates it immediately, never inserts the session into the live map, and returns a create error while the delete still succeeds.
- Close uses SIGTERM with bounded SIGKILL escalation. Force-kill and idle cleanup terminate process groups immediately where supported. Idle cleanup skips a running agent action run: it ends when the agent stops it, its session is archived or deleted, or the server stops. Removal explicitly sends a fatal scoped closure and evicts client projections even when a PTY backend fails to emit `onExit`; attached terminals are not considered idle.
- Shutdown is single-flight, rejects new creates, cancels pending creates, and waits for pending creates and restarts before clearing live sessions. A PTY that arrives during shutdown follows the same cancellation cleanup as a pending create that was explicitly closed.
- On POSIX, shutdown disconnects input and gives terminal workloads a shared 20-second SIGTERM grace. Process-table snapshots retain descendant ownership across shell exit and separate job-control groups; PID start times guard against reused PIDs. Linux reads `/proc` directly so minimal containers do not need `ps`. Shells remain open until the workloads exit, then receive SIGHUP. An exec'ed server receives SIGTERM and the full grace even though it occupies the shell PID. Remaining processes receive SIGKILL at the deadline. A process-table failure warns and forces known owned processes closed. Windows retains ConPTY-owned teardown because it has no POSIX signal protocol.

## TypeScript boundaries

Create passes unchecked `cwd` to the injected `node:path.resolve` before
validating the directory. The terminal's platform declarations expose the
single-argument native validation call. Node returns a resolved string for a
string argument and throws `ERR_INVALID_ARG_TYPE` for other values. The create
route returns that native message and code. Restart still validates the
directory first.

The helpers own their exported shell, replay-parser, appearance, shutdown and
frame contracts. Relative import specifiers keep `.js`. The `ws` constructors,
frames and events use `../shared/websocket-contracts.js` through the shared
package declaration. The terminal's platform declarations also expose the
optional Bun version global for the Node-only server check.

Shell preferences and appearance colours arrive unchecked from HTTP. The shell
resolver checks the preference and keeps its PATH and platform fallbacks when
`/etc/shells` cannot be read. Create and restart retain the raw colours. The
theme parser checks each colour before use, and the appearance route updates a
colour only when its input is a string.

The frame reader accepts every non-null JSON object, including arrays. It does
not establish a v3 message shape; `runtime.ts` checks the version, kind, session
id and input after decoding. URL and text-message string guards remain at their
HTTP and WebSocket boundaries. ArrayBuffer and Uint8Array inputs call separate
`Buffer.from` overloads with the same runtime semantics: ArrayBuffer storage is
shared, Uint8Array storage is copied, and an existing Buffer passes through.

Shutdown checks error codes from native filesystem and process operations before
ignoring an absent process. A missing `ps` status field still throws a TypeError
and enters the existing warning and forced-cleanup path. Pending replay state
keeps the original empty-string sentinel and bounded mutable fragments.

## Decisions

### Why PowerShell aliases need a launch probe

Windows Store execution aliases can reject `stat` with `EACCES` while remaining launchable. Shell discovery probes those PowerShell candidates, and only ones inside a `WindowsApps` directory or one of its package folders, with a bounded, profile-free command in PATH order; other executables keep the normal file check. Auto resolves fallback shells as the PTY needs them, so a PowerShell probe cannot delay an earlier usable shell. Explicit selection only probes candidates for that shell. A bare `pwsh` with no PATH match still falls back to the plain executable check.

### Why events and not polling

The runtime broadcasts `openchamber:terminal-sessions-changed` after creation,
exit, restart and removal, including idle cleanup, replacement and shutdown.
The event carries no terminal data or command text. The existing OpenChamber
control broadcaster reaches global WebSocket and control SSE clients, including
relay and mobile clients. Consumers coalesce invalidations into authoritative
list reads and read again on connection and visibility recovery. The old
five-second loop generated idle requests whenever the header was mounted.

### Why idle cleanup leaves an agent's action runs alone

An agent typically starts a dev server, then works for a while without a client attached to that terminal and without the server printing anything. Idle cleanup exists for terminals a client forgot; it would kill such a server after 30 minutes while the agent still relies on it. Agent runs have their own end instead: `actions.stop`, the session's archive or deletion, and shutdown.

### Why the snapshot is gzipped in the frame and not by the socket

A 512 KiB history is a 450 to 620 KiB JSON frame and gzips to 45 to 155 KiB in a few milliseconds. `permessage-deflate` on the socket would cover direct connections only: the relay host reads the terminal socket over loopback and forwards each message encrypted, and encrypted frames do not compress. Gzip inside the frame crosses every transport. Only the snapshot is compressed, on request, so an older client or server keeps exchanging plain frames and live output is never held back.

### Why a failed terminal upgrade is logged and not answered

`handleUpgrade` throws only after it has taken the socket: the handshake may already have written its `101`, either because the same socket was upgraded twice or because the connection callback threw. The connection is no longer HTTP then, so a status line would append an HTTP response to a switched-protocol socket. The handler logs the failure and destroys the socket.

### Why older Bun uses node-pty

bun-pty 0.6.0 imports successfully on Bun below stable 1.4.0 but throws when spawning. Provider selection checks the Bun version before caching the provider, so older Bun, 1.4.0 prereleases, and Node use node-pty. Early 1.4.0 canaries lack the required FFI buffer_length type. node-pty under Bun spawns a shell that never delivers output, so a server on older Bun has no working terminal. `openchamber serve` therefore starts the server on Bun only when `bun --version` passes the same rule, `bunVersionRunsBunPty` in `bun-pty-support.js`, and on Node otherwise (#6322). The update restart reruns the CLI with the server's own runtime, so a CLI running on such a Bun starts the server with `node` from `PATH`. The bun-pty patch retains up to 512 KiB of UTF-8-safe output until the first data listener attaches; 0.6.0 does not yet include that upstream fix.

### Why replay parsing carries bounded fragments

A growing pending prefix made an unterminated control string copy and rescan all previous output on every callback. Bounded fragments let the parser scan only new input and assemble a retained sequence once at its terminator. UTF-16 copies preserve split surrogate pairs and prevent a short suffix from retaining a larger callback allocation.

### Why overflow waits for the terminator

Resetting the parser at the size limit would expose control payload as printable replay text. Discarding the whole oversized sequence through its terminator preserves the replay boundary while raw live output remains unchanged. The 8,192-code-unit limit bounds parser memory separately from the 512 KiB scrollback limit.

### Why reads reuse the replay text and not raw output

`readTerminal` could have kept a second buffer of the exact bytes the PTY emitted, but that would duplicate everything the user typed and every command's output in memory for a feature that only reads. It would also widen exposure: raw bytes still carry terminal query exchanges and control sequences that the replay sanitizer strips, so callers would receive text no client ever sees. Finally, a separate buffer would drift from the snapshot — trimming, restart clearing, and sanitizer changes would have to be mirrored exactly, and any mismatch would show a caller output different from what an attached client replays. Reading the one sanitized history keeps a single source of truth and a single 512 KiB bound; the plain-text pass is applied to the copy a read returns, so the panel's replay and live stream keep their controls.

## Security And Relay

`socket-upgrade.ts` admits host-terminal sockets. A socket from the hosted tunnel UI uses the same live tunnel session as terminal HTTP. Its origin must also match the active tunnel's public origin, even if the server allows a second origin for other UI clients. Expiry, tunnel revocation and replacement disconnect that socket without stopping the PTY. Local UI and paired clients keep their existing credentials; space upgrades have a separate owner.

The WebSocket path must remain in both `isUrlAuthWebSocketPath` and relay `ALLOWED_WS_PATHS`. The client uses the runtime resolver's `sameOriginCookieWebSocket()` for a confirmed hosted tunnel session and `websocket()` otherwise. Both paths use `openRuntimeWebSocket`; direct local URLs or raw browser WebSockets break relay and URL-token authentication.

## Verification

Terminal tests use Vitest through the web package script. Auth and relay tests
use Bun's test runner:

```sh
bun run --cwd packages/web test server/lib/terminal
bun test packages/web/server/lib/ui-auth/ui-auth.test.js
bun test packages/web/server/lib/relay/cross-compat.test.js
```

The #3389 macOS ARM64 reproduction used real Electron 43.7.0 PTYs and HTTP
servers with signal handlers that took 15 seconds to finish cleanup. On the
baseline, File > Restart and Quit sent SIGKILL to the exec'ed server within
3–4 ms; a foreground child in another process group received SIGHUP and outlived
Electron. After the fix, both workloads completed after SIGTERM before Electron
exited, in bundled and HMR runs. A noncooperative workload was killed after the
shared 20-second deadline.

Packaged test builds 1.24.90 and 1.24.91 exercised the real macOS Squirrel install
with a loopback feed, isolated app identity/profile, and a shared test signing
requirement. Both the normal update and closing the window during cleanup
installed and relaunched N+1 after the terminal workloads finished. The installed
ASAR matched N+1, and OpenCode remained bundled after its own restart. A rejected
signature also reached the installer error handler after the 15-second cleanup.
Linux ARM64 process regressions pass without `ps` installed. Native Windows
ConPTY and Linux Electron installer behavior were not exercised for this fix.
