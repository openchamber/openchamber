# Browser Control Module

Agent-driven automation of OpenChamber's **existing** embedded browser (the
`IframeBrowserPane` on web/VS Code, the Electron `<webview>` `DesktopBrowserPane` on
desktop — both in `packages/ui/src/components/layout/ContextPanel.tsx`). Lets the
model running inside the OpenCode server navigate, snapshot, click, type, read
console/network, screenshot, and run test loops against the running app.

## Architecture

```
model (OpenCode subprocess)
  → MCP tools/call  →  /openchamber-browser-mcp  (loopback + bearer; OUTSIDE /api)
  → dispatch()      →  command-router (capability + consent gate; CORE policy)
  → reverse-RPC over /api/browser/ws  →  renderer executor (iframe / webview)
  → result back up the same path
```

The server is **platform-agnostic**: it relays every op to whichever renderer
executor registered as a controller over the control WS, and correlates the reply
by `cid`. The renderer executes the op in the page — `iframe.contentWindow.eval`
(same-origin proxied content only) on web, `webview.executeJavaScript` (any origin)
on desktop. Screenshots reuse `html-to-image` (web) and the existing
`desktop_browser_capture_page` IPC (desktop). **No new dependencies, no
Playwright/Chromium, no Electron-shell automation logic.**

## Files

- `command-router.js` — PURE policy core: op catalog + capability matrix
  (backend × origin) + tiered consent gate + arg validation + error taxonomy.
  Enforced before any backend is touched. Fully unit-tested.
- `snapshot.js` — ref-addressable a11y/DOM snapshot model: builds the in-page
  script (tags `data-oc-ref`, epoch-scoped) and the ref helpers (STALE_REF).
- `op-scripts.js` — per-op in-page script generators (click/fill/snapshot/...).
  Args are JSON-injected so model values can't break out of the script.
- `browser-ws-protocol.js` — JSON frame helpers + path constants for `/api/browser/ws`.
- `runtime.js` — orchestrator: WS broker (terminal-style auth gate), reverse-RPC
  with per-command deadline + cancel, op→primitive mapping, lifecycle ops
  (open/close/status/list_panes), wait_for, controller selection. Returns
  `{ dispatch, shutdown }`. Mounts the MCP endpoint.
- `tool-catalog.js` — MCP tool definitions (`browser_*`) for `tools/list`.
- `mcp-endpoint.js` — hand-rolled MCP JSON-RPC over HTTP at
  `/openchamber-browser-mcp` (no `@modelcontextprotocol/sdk`). Loopback-only +
  constant-time bearer. Pure transport → forwards `tools/call` to `dispatch`.
- `ensure-mcp-registration.js` — idempotent, direct (non-route) registration of the
  managed `openchamber-browser` MCP entry; writes only on drift.

## Policy / consent (enforced in `command-router.js`)

- **Off by default.** No MCP entry, no tools, until enabled. The **Settings →
  Behavior → "Agent browser control"** section (`BehaviorPage.tsx`) writes
  `settings.browserAutomation.{enabled, advancedEnabled, allowExternal}`;
  `OPENCHAMBER_BROWSER_AUTOMATION=1` / `OPENCHAMBER_BROWSER_ADVANCED=1` /
  `OPENCHAMBER_BROWSER_LOCALHOST_ONLY=1` are env overrides. Toggling in Settings
  re-applies the MCP registration live (`reapplyBrowserMcpRegistration` in `index.js`).
- **Tiers:** read/observe and interaction auto-allowed once enabled;
  `evaluate` / cookie+storage writes / `file_upload` are **advanced** (default OFF,
  require `advancedEnabled`). **External (non-localhost) targets are allowed by
  default** (`allowExternal`, default true) and can be restricted to localhost via the
  "Allow agents on any website" toggle (`allowExternal:false`); reads stay allowed.
  When `allowExternal:false`, the restriction gates the **navigation target** too —
  `navigate` (in `evaluateConsent`) and the lifecycle `open` (via
  `isExternalNavigationBlocked`) are denied for external URLs even from a localhost
  page, so navigation can't be used to escape the localhost-only confinement. The
  capability layer still limits what a cross-origin web iframe can actually do
  (desktop webview drives any origin fully).
- **Audit:** every op is logged `[BrowserControl] ALLOW|DENY|FAIL tool=… controller=… origin=…`
  (`audit` in `runtime.js`), with an optional `onBrowserAudit` sink.

## Capability boundary

- Desktop `<webview>`: full automation of **any** origin. `file_upload` uses the desktop
  CDP command `desktop_browser_set_input_files` (`electron/main.mjs`, home-dir contained).
- Web proxied-localhost iframe: full DOM automation (same-origin via the preview proxy);
  `file_upload` is `UNSUPPORTED_ON_SURFACE` (a page cannot set file inputs).
- Web external (cross-origin) iframe: navigate + screenshot only → DOM ops return
  `CROSS_ORIGIN_BLOCKED`. This is the same-origin sandbox limit, surfaced honestly.
- **VS Code:** unsupported (like `terminal`) — the webview cannot open the control WS;
  `RuntimeAPIs.browser` is left undefined so panes skip registration cleanly.
- **Auto-open:** `browser_open` with no pane broadcasts an `openchamber:browser-open-request`
  global UI event; the UI opens a Browser context-panel tab in the active project.

## Registration & restart-churn

`ensure-mcp-registration.js` writes config via the mcp.js helpers DIRECTLY (not the
`/api/config/mcp` route, which always restarts OpenCode). It runs after listen
(active port known), compares the desired entry to disk, and writes only on drift;
the caller triggers exactly one `refreshOpenCodeAfterConfigChange` only when something
changed. Stable reboots are a pure no-op (no restart).

## Auth

- `/api/browser/ws`: terminal-identical upgrade gate (`uiAuthController` +
  `isRequestOriginAllowed` + `rejectWebSocketUpgrade`); URL carries the short-TTL
  `oc_url_token` (allowlisted in `ui-auth.js`).
- `/openchamber-browser-mcp`: loopback-bound + persisted per-install bearer
  (constant-time compare). Mounted outside `/api` to bypass the UI-session guard
  (the OpenCode subprocess has no cookie).

## Wiring

- Server: instantiated in `lib/opencode/startup-pipeline-runtime.js` beside the
  terminal runtime; threaded from `index.js` (policy/token/mcp helpers); shutdown via
  `lib/opencode/shutdown-runtime.js`.
- UI: `packages/ui/src/lib/browserControlApi.ts` (client), `.../lib/browser/executor.ts`
  (primitive mapper), `.../components/layout/useBrowserController.ts` (pane hook, fires
  `onCommand` for the activity indicator), registered by both panes in `ContextPanel.tsx`.
  Web factory: `packages/web/src/api/browser.ts` → `RuntimeAPIs.browser`.
- UI controls: `.../components/layout/BrowserAgentControlBar.tsx` renders the live status
  pill (idle "shared" vs pulsing "controlling" + last op), the hand-off/stop toggle
  (owns the controller registration; stopping unregisters = emergency stop), and a
  pop-out button. Panes ring the content while the agent is acting.
- Pop-out (true detach): `.../lib/browser/popout.ts` opens the browser in a separate
  OS window — desktop via Electron (`desktop_open_browser_popout_window` →
  `createBrowserPopoutWindow` in `electron/main.mjs`), web via `window.open`. The panel
  tab swaps to `BrowserDetachedPlaceholder` (Bring back / Focus window) while detached,
  so only the pop-out window renders the pane — reusing the SAME controller id. Detach
  state + cross-window coordination live in `stores/useBrowserPopoutStore.ts` over a
  BroadcastChannel (pop-out posts `closed` on unload → panel re-attaches; panel posts
  `dock` → pop-out closes). The pane hands off the controller across windows race-free
  because the runtime's `bye`/close handling is socket-scoped (a stale panel socket
  can't delete the controller the pop-out re-registered on a new socket).

## Diagnostics (console / network / page errors)

Pull-based and uniform across surfaces: the op preamble idempotently installs
capture hooks in the page (overriding `console.*`, `window.onerror`/`unhandledrejection`,
`fetch`, and `XMLHttpRequest` into a capped `window.__ocDiag` ring). The
`browser_console_messages` / `browser_network_requests` / `browser_page_errors` ops
are page-eval "drains" that return entries since a `cursor`. Capture arms on the
first op after each load; the buffer resets naturally on navigation (new document).
