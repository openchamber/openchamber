# Server diagnostics

Server side of the diagnostic timeline that the UI exports from Ctrl/Cmd+Shift+L. The UI half, and the format of the exported file, is in `packages/ui/src/lib/diagnostics/DOCUMENTATION.md`.

Every module here follows one rule: free-form text never enters the timeline. A writer maps what it saw onto a fixed vocabulary, and a reader admits only values from that vocabulary. A line that does not match is counted under the export's `Sources`, never copied.

## Invariants

- The implementation is TypeScript; callers keep `.js` import specifiers.
  Shared event, coverage, journal, SSH buffer and process-summary types are
  exported once from `contracts.ts`. External JSON remains validated at the
  read boundary, and failed reads remain unknown.

- Known free-form log messages match as whole messages; neighboring text can
  contain private data. A timestamp without a timezone is local wall time,
  including bracketed Electron log timestamps, so UTC interpretation cannot
  shift the exported timeline.

## Modules

Module names below are the stable `.js` import specifiers; their implementations
and the shared contracts are `.ts` files.

- `vocabulary.js`: the fixed values. `diagnosticApiRoute()` maps a request path to a route template such as `/api/session/:sessionID/message`, so session, message and provider IDs never leave the process; unknown paths become `/api/other` or `/other`. `diagnosticErrorMessage()` keeps a transport error message only when it is one of a few known forms, with addresses and host names replaced. `packages/ui/src/lib/diagnostics/export.ts` re-validates the same vocabulary on its side of the transport; a route or message added here must be added there too.
- `server-journal.js`: a process-local ring of at most 4,000 events or 24 hours. `lifecycle.js` records OpenCode transitions (launch, ready, exit, restart, health failure and recovery, external connect, bootstrap result) as fixed actions with an attempt number or failure class. `registerHttpResponseDiagnostics()` in `../server-frame/core-routes.js` runs before every route and records completed 4xx/5xx responses as method, route template and status, grouping adjacent identical responses for up to ten minutes. A 404 is an observed response; it does not establish an upstream cause. The journal never holds stderr, paths, URLs or error text, and a restart of the server empties it.
- `local-files.js`: reads the fixed application log locations (the desktop `main.log` family, `openchamber-<port>.log` for the current web port, the macOS startup logs and `update-install.log`), the last 512 KB and 4,000 lines of each. It never accepts a path from the caller, refuses symlinks and other non-regular files, and does not read OpenCode's own log directory. `classifyLogLine()` maps known messages to fixed categories: managed launch and startup failure, health check failures with their attempt and class, updater errors, relay key generation, IPC rejections, the message-stream and `PushWatcher` reports of `/api/event` failures, and proxy errors. Failed HTTP access lines keep method, route template and status, grouped in ten-minute bursts. The desktop SSH manager's in-memory history is classified by `classifySshLogLine()` inside the Electron main process, so host names, remote stderr and commands never reach the renderer.

- `opencode-load.js`: the `OpenCode load` line of the export. It counts the locations OpenCode has loaded (`GET /api/debug/location`, which does not start one) and walks the process tree under the pid `/api/info` reports, from one `ps` call. Only counts and megabytes leave it: no paths, names or commands. Processes are not counted on Windows, which has no `ps`, or when that pid is not an OpenCode process on this machine (OpenCode on another host or inside WSL); the result says `null` for that part, never zero. The check against a reused pid accepts a command naming `opencode`, or a direct child of this server: the desktop's bundled OpenCode runs as the app's own executable (or Node in development), whose command does not name it.
- `startup-performance.js`: opt-in startup phase diagnostics with fixed labels and numeric metadata allowlists.

## Proxy error lines

`../opencode/proxy.js` logs upstream failures as `[proxy] OpenCode proxy error: method=… route=… function=… class=… message="…"`, using the vocabulary above. The `function` field names the handler (`forwardSseRequest`, `forwardSanitizedSessionListRequest`, `forwardSessionGetRequest`, `forwardMessageListRequest`, `onApiProxyError`). Lines written by older versions in the `[proxy] OpenCode <label> proxy error: fetch failed` form keep their known route and handler; any other old proxy line is counted as filtered.

## Access

Web reads come through `GET /api/diagnostics/local-files`, registered in `../server-frame/core-routes.js`, and both web and desktop read the OpenCode load through `GET /api/diagnostics/opencode-load` beside it. The routes answer only a loopback socket whose tunnel scope is local, after UI auth. Tunnel clients and requests the private relay forwards (both reach the server through loopback) are refused. Desktop reads come through the local-page-gated `desktop_collect_local_diagnostics` IPC, which is not in `COMMANDS_SAFE_FOR_REMOTE`.
