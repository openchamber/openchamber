# Browser Surface

## Ownership

`runtime.js` owns the authoritative browser session model: a single managed
Chrome/Chromium process (launched lazily), its per-tab targets, viewport
emulation, live cursor state, screencast streaming, screenshots, and recording
lifecycle. `chrome.js` discovers an executable and launches headless Chrome with
a DevTools endpoint. `cdp.js` is a minimal Chrome DevTools Protocol client over
the browser-level WebSocket using flat session mode. `input.js` maps key combos
to CDP key events; `urls.js` normalizes and safety-checks navigation targets;
`agent-actions.js` defines the agent-facing action allowlist. `routes.js`
registers the HTTP command plane. Clients own tab arrangement and choose which
tab to watch.

The browser is optional: when no Chrome-compatible executable is found (and
`OPENCHAMBER_BROWSER_PATH` is unset), `state().supported` is `false` and the UI
renders an explicit unsupported state instead of failing silently.

## Protocol

`/api/browser/ws` is the live preview and interactive transport. It uses the
same tagged binary JSON control frames as the terminal, is opened through
`openRuntimeWebSocket`, and is gated by UI-session auth, origin, URL-token
(`isUrlAuthWebSocketPath`), and relay (`ALLOWED_WS_PATHS`) exactly like the
terminal socket. On connect the server sends a `snapshot` with full state.
Thereafter it broadcasts `state`, `tab`, `cursor`, `frame` (JPEG screencast for
watched tabs), `console`, `recording`, and `artifact` messages. Clients send
`watch`/`unwatch` (screencast is started only while a tab is watched or being
recorded) and `input` (any runtime action, so the user drives the same surface
the agent uses).

HTTP is the authenticated command plane. Every mutating action (`navigate`,
`click`, `type`, `key`, `scroll`, `evaluate`, `wait`, `viewport`,
`screenshot`, `recording.*`, `tab.*`) routes through the runtime's single
`executeAction` dispatch, so HTTP, the WebSocket input channel, and the agent
tool share one validation and state-mutation path. `GET /api/browser/state`
and `GET /api/browser/artifacts[/:id]` are read paths; artifacts are fetched
with the bearer token via `runtimeFetch` and rendered as object URLs.

## Control ownership

`state().control` reports who currently drives the shared browser:

- `actor: "agent"` with `sessionId` after an `openchamber_browser` tool call
- `actor: "user"` after the user takes over or sends an allowed user action
- `actor: null` before anyone has claimed the surface

User HTTP/WS mutations while an agent holds control require an explicit
`takeover: true` body field (or `POST /api/browser/takeover`). Otherwise the
server returns `409` with `code: "BROWSER_AGENT_CONTROLLING"` and the owning
`sessionId`. The Agent Browser UI confirms before takeover when that session is
busy/retrying, aborts the owning session, then claims user control and retries
the pending input.

## Safety

- Only `http`/`https` targets are navigable. `file:`, `chrome:`, `javascript:`,
  and `data:` URLs are rejected in `urls.js`, not merely hidden in the UI. Bare
  `host:port` and `:port` shorthands resolve against the server host where local
  dev servers live; private hosts default to `http`, public hosts to `https`.
- Artifact reads validate the id against a strict pattern and confine reads to
  the artifacts directory (no traversal).
- Recording is explicit: it has a visible lifecycle (`recording.start` /
  `recording.stop`), is bounded by frame count and bytes, and produces an
  inspectable artifact. The live recording status is broadcast to every client.

## Lifecycle

- The Chrome process starts on the first action that needs it and stops after
  an idle period with no tabs and no connected clients, or on graceful
  shutdown. If Chrome exits unexpectedly the model is cleared and broadcast.
- Screencast runs only while a tab is watched or recorded, and restarts when the
  viewport changes so frame bounds match the emulated device.

## Setup / Installation

1. **Chrome/Chromium on the OpenChamber host** (required for the surface to be
   usable). Resolution order:
   - Settings → Agent Browser → **Browser executable** (`browserExecutablePath`)
   - `OPENCHAMBER_BROWSER_PATH`
   - Managed install under `<dataDir>/browser/install/` (Settings → **Install Chrome**)
   - OS discovery (`google-chrome-stable`, `chromium`, snap paths, app bundles, …)
2. **Headless / container hosts**: enable **Disable browser sandbox**
   (`browserNoSandbox`) or set `OPENCHAMBER_BROWSER_NO_SANDBOX=true`. OpenChamber
   also auto-enables `--no-sandbox` when running as root. Managed install turns
   the setting on automatically for root/Docker Linux hosts. Launch always uses
   `--headless=new`, `--disable-dev-shm-usage`, and `--disable-gpu`.
3. **arm64 Linux**: managed install downloads Google Chrome's official
   `arm64` `.deb` and extracts it without a system package install (`dpkg-deb`).
   x64 Linux uses the amd64 `.deb`; macOS/Windows use Chrome for Testing zips.
4. **Agent control enabled** (default). Settings → OpenCode CLI /
   `agentControlToolEnabled` must not be `false`, and OpenChamber must own the
   managed OpenCode process so `openchamber_browser` is injected.
5. **Start the OpenChamber server** (web CLI, desktop in-process, or hosted).
   On startup, `syncSystemSkills` installs/refreshes the managed
   `agent-browser` skill into `~/.config/opencode/skills/agent-browser/SKILL.md`
   (same path OpenCode scans for every project).
6. **Open Agent Browser** in the context rail to watch the live surface. Agents
   drive it with `openchamber_browser`; users can also send input over the same
   WebSocket.

When no Chrome-compatible executable is found, `state().supported` is `false`
and the UI shows an explicit unsupported state. Use Settings → Agent Browser →
Install Chrome, set a path, or set `OPENCHAMBER_BROWSER_PATH`, then Save (the
runtime reloads configuration without a full server restart).

Probe: `GET /api/browser/status`. Install: `POST /api/browser/install`.

## Agent Tool

The managed agent tool exposes a second OpenCode custom tool,
`openchamber_browser`, alongside `openchamber`. It posts to the same
authenticated loopback callback with `tool: "browser"` and is delegated to the
browser runtime through `executeBrowserAction`. It is injected only when
OpenChamber owns the OpenCode process, under the same per-child token and
loopback constraints as the `openchamber` tool.

## System Skill

`packages/web/server/lib/opencode/system-skills.js` ships a managed
`agent-browser` skill (`managed-by: openchamber`). It teaches agents when to
use the shared browser, the action workflow (`state` → open/navigate →
interact → capture → report), and the safety rules (http/https only, no
invented page content, explicit recording start/stop). Like other system
skills, it is refreshed on every server start; removing the `managed-by`
marker makes the file user-owned and skips further rewrites.

## Runtime Parity

- Web and Desktop (managed OpenCode, in-process server): full support.
- External OpenCode / skip-start: the browser surface still runs in the
  OpenChamber server; only the agent tool injection is skipped (OpenChamber does
  not control that process environment).
- VS Code: the extension owns its OpenCode lifecycle and does not inject the
  agent tool; the shared UI shows the browser surface as unsupported unless a
  supporting server is reachable.
- Hosted and Capacitor mobile clients use the server's managed browser when
  connected to such a server; no browser runs in the client runtime.

## Verification

```sh
bun test packages/web/server/lib/browser/urls.test.js packages/web/server/lib/browser/input.test.js
bun test packages/web/server/lib/browser/runtime.test.js   # requires a local Chrome/Chromium
bun test packages/web/server/lib/browser/routes.test.js
bun test packages/web/server/lib/agent-tool/runtime.test.js
bun test packages/web/server/lib/opencode/system-skills.test.js
# End-to-end setup + captures (Chrome + ffmpeg required):
bun packages/web/scripts/agent-browser-verify.mjs
```
