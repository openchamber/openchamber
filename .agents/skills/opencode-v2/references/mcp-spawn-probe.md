# Counting MCP starts per directory on a cold launch

Answers "which directories does a launch start, and which request started
each". Done when every started directory is matched to the request and call
stack that started it.

1. **Fake MCP.** A Python stdio server that appends
   `start <name> pid=<pid> cwd=<cwd>` to a log, then answers `initialize`,
   `tools/list`, `prompts/list` and `resources/list`. Declare it three times in
   a scratch `XDG_CONFIG_HOME/opencode/opencode.json`:
   `{"mcp":{"servers":{"alpha":{"type":"local","command":["python3","<script>","alpha"]}}}}`.
2. **Workspace.** Several scratch git projects plus worktrees, listed in a
   scratch `OPENCHAMBER_DATA_DIR/settings.json` `projects` array with
   `lastDirectory`. Create sessions with `POST /api/session` and body
   `{"location":{"directory":...}}`; that starts no location. Use the same
   path spelling the UI will (on macOS `/tmp` resolves to `/private/tmp`,
   and two spellings start two locations).
3. **Server with a request log.** Run the API server and vite directly under
   `env -i` with scratch `XDG_*` dirs, `OPENCHAMBER_DATA_DIR`,
   `OPENCHAMBER_PORT`, `OPENCHAMBER_RELAY_HOST=off` and
   `OPENCODE_BINARY` (the installed app's bundled CLI): in `packages/web`,
   `bun --preload <fetch-log.mjs> server/index.js --port <api>` and
   `bun x vite --port <ui>`. `BUN_OPTIONS` breaks `bun run dev`, so the
   preload only works this way. The preload wraps `globalThis.fetch` and logs
   each server-to-OpenCode `/api/*` call with its `x-opencode-directory` and
   stack.
4. **Browser with a request log.** Headless Chrome through
   `scripts/perf/cdp.mjs`; `Page.addScriptToEvaluateOnNewDocument` wraps
   `window.fetch` and records `new Error().stack` per `/api/*` call. Leave the
   Debugger domain off: async stack depth stalls the vite dev page. Open the UI
   once with `?session=<id>` and once without; without a session it lands on a
   chat draft, whose directory starts too.
5. **Correlate.** OpenCode's log at `XDG_DATA_HOME/opencode/log/opencode.log`
   prints `location services booted directory=...` with a timestamp; match it
   to the request logged just before it.

Restart the whole stack between runs. OpenCode keeps locations running, and a
fan-out triggered by the catalog events of a fresh start only shows cold.
Stop only the processes you started.
