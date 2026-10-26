# Diagnostic timeline

Ctrl/Cmd+Shift+L, the command palette's "Show diagnostic timeline" item and the link under a failed turn (`SessionErrorNotice`) all call `showOpenCodeStatus()` in `../openCodeStatus.ts`, which opens `OpenCodeStatusDialog` with the text `buildDiagnosticLog()` produces. The dialog copies it or downloads it as a `.log` file. The file is meant to be attached to a bug report, so nothing private may enter it: no session or message IDs, titles, paths, URLs, prompts, raw log lines, console arguments, stacks or response bodies. The full status report with paths and stderr stays available in the console as `__opencodeDebug.statusReport()`.

The server half, including the fixed vocabulary for routes and error messages, is in `packages/web/server/lib/diagnostics/DOCUMENTATION.md`.

## What the file contains

1. A header: OpenChamber version and runtime, `navigator.userAgent`, the OpenCode version read from `/api/info`, where the OpenCode binary was found (`opencodeBinarySource`) and its launch wrapper, and the kind of the last startup error. `classifyStartError()` in `capture.ts` turns the error text into a label such as `exited before serving (code 1)` or `binary not found`; the text itself, which carries paths and OpenCode's stderr, stays on the startup screen.
2. One current health summary from `/health`, or an explicit unavailable line when the request fails or the response lacks the running/ready fields. Under it, `OpenCode load`: how many directories OpenCode has loaded and how many processes it started, with their memory, from `GET /api/diagnostics/opencode-load`. Each loaded directory runs its own copy of the user's local MCP servers, so these numbers answer most "OpenChamber uses N GB" reports. Counts and sizes only; an unknown count says so and never reads as zero.
3. `Sources`: what was read, what was missing, filtered or truncated, and what is never read. A missing or filtered source is listed here; it never looks like an empty success.
4. Events from every source, sorted by time.

## Where events come from

- `capture.ts`: `startDiagnosticCapture()` runs once from `App` and keeps an in-memory buffer of at most 1,500 events or 24 hours (`timeline.ts`). It records changes to connection, event-stream, session-selection and directory-selection state, renderer exceptions and unhandled rejections, CSP violations, and console calls that carry a known `[tag]` or are warnings or errors. Console capture wraps `console.*`, so it runs only in production builds; a Vite dev build leaves the console alone and DevTools keeps the real call sites. Console arguments are discarded. An error keeps only an allowlisted type and an exact known message or a fixed template such as `Cannot read properties of undefined (reading [property])`; an uncaught exception also keeps its line and column in a same-origin built JS asset. Server health is sampled at startup, on a runtime switch and on export; there is no polling.
- `export.ts`: on export it probes `/api/info`, `/api/provider` and `/api/session/active` once (status, content class, elapsed time), adds the recent turn errors and rejected sends from `@/sync/session-error-log` and `@/sync/send-failure-log`, and fetches the server's file and journal events. A turn error keeps its OpenCode failure class (`provider.auth`, `tool.execution`) and never its message.
- Sessions, directories and messages appear as `session-1`, `directory-2`, `message-1`. `diagnosticIdentity()` keeps the map from real IDs to labels in memory only, capped at 5,000 entries.

Events from the server cross a process boundary, so `parseFileDiagnostics()` validates each record again against the same fixed vocabulary the server uses. Invalid records are dropped one by one and counted under `Sources`; valid ones around them stay.

## Runtimes

- Web and desktop on the local instance: capture and export as above. Web reads server events from `GET /api/diagnostics/local-files`; desktop reads them, plus the SSH manager's classified history, over the `desktop_collect_local_diagnostics` IPC.
- Web or desktop connected to a remote runtime (another machine's server, an SSH host): capture records nothing, the `OpenCode load` line says it was not read, and the export reads only the active server through the runtime API. `readServerHealth()` samples its `/health` into a list built for that export (repeating the server's last health failure, launch and restart every time), and the three OpenCode probes run against it, so the header, current health and probe results describe the remote OpenCode. Local files, the server journal, the SSH manager and the UI buffer, turn errors and rejected sends are skipped and `Sources` says so. A failed health request or probe appears as `unavailable` or a `probe failed` event. A runtime switch while either export is collecting returns an "Export interrupted" file instead of mixing two runtimes; a switch also clears the buffer and the label map.
- VS Code, hosted mobile (the phone layout served by the web build) and the Capacitor app render their own roots without `MainLayout`, so the dialog is not mounted. `SessionErrorNotice` reads `DiagnosticDialogAvailableContext` (`dialog-availability.ts`, provided by `MainLayout`) and hides its status link there.

Everything is process-local: reloading the UI empties the renderer buffer, restarting the server empties the journal.

## OpenCode memory snapshot

Under the timeline the dialog has "Save OpenCode memory snapshot" (`components/ui/OpenCodeHeapSnapshot.tsx`). It calls `opencodeClient.writeHeapSnapshot()`, OpenCode's `POST /api/debug/heap-dump` (2.1.4), which writes a V8 heap snapshot of the OpenCode server into OpenCode's log directory and answers with the path. The route takes no location, so it starts no MCP servers; OpenCode pauses while the heap serializes. Against an older OpenCode the route answers 404 and the row says which version it needs.

The snapshot stays a file on the OpenCode machine and never enters the diagnostic log or any upload: it can hold API keys, prompts and file contents, which is what the row's hint tells the user before they share it. On the local desktop the row offers "Show in folder" (`revealDesktopPath`); in a browser, or connected to another machine, the path may not be on this computer, so it offers "Copy path".
