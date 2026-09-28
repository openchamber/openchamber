# OpenChamber Desktop

Electron desktop runtime for OpenChamber on macOS, Windows, and Linux.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and OpenChamber server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How It Runs

Desktop starts the OpenChamber web server in the same Electron main process. There is no separate sidecar subprocess for the OpenChamber server.

`main.mjs` imports `@openchamber/web/server/index.js` and calls `startWebUiServer()`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

Electron loads `entry.mjs`, not `main.mjs`. Electron holds `ready` until the
entry module's import graph has evaluated, and importing the server module
graph blocks the main thread for a few hundred milliseconds, so the entry
stays small: the configuration that must precede `ready`, the single-instance
lock, and the first window. On `ready` it creates the main window on the HTML
splash through `early-startup.mjs`, waits (bounded) until the splash is on
screen, and only then imports `main.mjs`, which adopts that window through
`takeEarlyWindow()` and attaches its listeners. With packaged UI the splash is
served as `openchamber-ui://app/__splash` by the same scheme handler as the
application, so the navigation to the application stays on one origin and
Chromium keeps the splash frame until the application has painted; a splash on
a `data:` URL is another origin and the process swap shows an empty frame. Deep links and second launches
that arrive before `main.mjs` is loaded are buffered by the entry and replayed
once startup has resolved. The frame colour, window state, splash markup and
window options live in `early-startup.mjs` so the early window and any later
main window are built from one definition; both bundles import that module at
runtime rather than inlining it, or the handoff would see two copies.

Login-shell environment discovery starts as soon as `main.mjs` runs and
proceeds asynchronously, so shell startup files run while the window comes up.
Startup callers share one probe and await its result before reading
shell-provided server flags or importing the backend. The probe tries
interactive login, then login-only on failure, with a five-second timeout per
attempt. Failure preserves the inherited process environment. Confirmed quit
cancels an in-flight probe and waits for its process to exit.

`bun run profile:startup` measures a packaged build's launch in an isolated
profile; see `scripts/perf/DOCUMENTATION.md`.

Quit, relaunch, and update installation await the in-process server's `stop()`
before exiting Electron. This lets the backend release its terminals, managed
OpenCode process, and guest services. `server-shutdown.mjs` bounds the server
wait to 35 seconds, allowing the terminal runtime's 20-second grace plus the
remaining backend cleanup. It uses the detached OpenCode killer only if normal
shutdown fails or times out. An external OpenCode server remains externally
owned. Closing to the tray does not stop the backend.

Update installation bounds the full background-service shutdown, including SSH,
to 40 seconds. This outer deadline leaves the backend's 35-second wait intact;
its timer is cleared when shutdown finishes.

See [process ownership and the #3589 investigation](./process-lifecycle.md)
for the launch paths, controlled reproductions, and Windows validation limits.

Same-origin session-chat iframes complete an authenticated parent-frame handshake before creating their SDK client. The parent supplies its active in-memory endpoint and credentials; when relay is active it also supplies the public relay descriptor without any pairing grant, because Electron preload and IPC are unavailable inside the iframe. The iframe establishes its own transport and rebinds its SDK before rendering. Additional windows retain their own per-window runtime bootstrap instead of being overwritten by the main window. Credentials are never placed in iframe URLs, and other child pages do not receive this runtime state.

The preload bridge exposes desktop-only APIs to the web UI through `window.__OPENCHAMBER_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI.

The compatibility gate can reuse the embedded managed OpenCode CLI preflight
through `desktop_managed_opencode_compatible`. Main matches the requested
API origin to the local backend and reads the lifecycle-owned preflight promise.
A pending check is shared; successful checks allow UI initialization before
server health becomes ready. Restart invalidates the result. This avoids a second
CLI version process during startup.
External OpenCode, remote instances, HMR backends without an embedded handle,
and unavailable IPC retain the HTTP compatibility check. The renderer discards
IPC results if its endpoint changes while the read is pending.

## Main Files

| File | Purpose |
|------|---------|
| `entry.mjs` | What Electron loads: pre-`ready` configuration, single-instance lock, the first window, then a dynamic import of `main.mjs` |
| `early-startup.mjs` | Settings and window-state reading, splash markup, main-window options, the early window handoff and buffered app events; shared by both bundles |
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `electron-host-probe.mjs` | Chromium direct-host probes, identity checks, attempt deadlines, and response cleanup |
| `host-probe-policy.mjs` | Selector fast attempt and unreachable-only retry policy |
| `startup-url-selection.mjs` | Pure bundled/HMR startup probe and loopback connection-limit policy |
| `shell-environment.mjs` | Asynchronous login-shell environment discovery and shared one-shot probe |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/ensure-electron.mjs` | Verifies the installed Electron binary is complete and repairs it via the postinstall under Bun |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `scripts/prepare-opencode-cli.mjs` | Downloads and stages the pinned OpenCode CLI into `resources/opencode-cli` |
| `scripts/opencode-cli-version.mjs` | Reads the pinned OpenCode CLI version and parses `opencode --version` output |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/{entry,main,early-startup}.mjs` for packaging |
| `scripts/rebuild-native.mjs` | Rebuilds native modules against the Electron runtime |
| `scripts/package.mjs` | Runs `electron-builder`, with unsigned Windows builds when signing env is missing |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

## Development

### Direct-host probe invariants

After app readiness, direct-host probes use Chromium `net.fetch`, not Node fetch.
Each attempt shares one deadline across optional `/health` identity verification,
`/api/version`, and `/auth/session`, including JSON body reads. The fast attempt
has a 2-second budget. The selector retries once with a 10-second budget only
after Unreachable. Reported latency is the final attempt's application-probe
duration, excluding an earlier failed attempt. It is not raw network ping.

Probes never follow redirects. A redirected identity check returns Wrong Service
before any bearer-bearing request. An explicit server ID mismatch also stops the
probe. Electron 43 reports a manual redirect as a rejected fetch rather than a
3xx response; the identity gate handles both forms. Identity requests carry
neither the client token nor custom headers;
version and session requests use sanitized custom headers and the client bearer
token. Older servers without identity metadata remain supported. HTTP 401 and
403 mean authentication is required, not that the instance is offline.

Every exit aborts the attempt's requests and cancels unused response bodies before
clearing the deadline timer. This includes early HTTP classifications and a
successful session response whose body is not needed. TLS verification remains
enabled. These rules do not change relay probing or the preload/IPC contract.

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/entry.mjs`. On Windows, the HMR launcher resolves npm's `bun.cmd` shim to the underlying `bun.exe` before spawning Bun child processes.

The Electron workspace package trusts Electron's install script so `bun install` downloads the platform runtime in fresh checkouts and worktrees.

Electron's postinstall (`node install.js`) is run by `bun install` with the system Node. Older Electron releases bundled `extract-zip@2.0.1`, which under Node 24 silently unpacked only the first entry of the Electron zip, leaving `dist/` without the binary and `path.txt` missing. Electron 43+ ships its own fixed extractor (`@electron-internal/extract-zip`), but to keep interrupted or wrong-architecture installs from blocking desktop work:

- The root `postinstall` runs `ensure-electron.mjs --best-effort`, which detects an incomplete Electron install (missing binary, stale `dist/version`/`path.txt`, or a binary of the wrong architecture) and repairs it by re-running the postinstall under Bun (which extracts correctly), falling back to Node.
- `electron-dev.mjs` runs the same check (fail-fast, not best-effort) before launching, so `bun run electron:dev` self-heals even when an install was interrupted. On Windows, the repair resolves npm's `bun.cmd` shim to the underlying `bun.exe` before spawning it from Node.
- The check can be run on demand with `bun run --cwd packages/electron ensure:electron`; set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to skip repair (e.g. CI without a network).
- Unit tests in `scripts/ensure-electron.test.mjs` (run via `bun run --cwd packages/electron test:architecture`) cover healthy/missing/stale installs, wrong-architecture binaries, repair fallback, and `--best-effort`.

Useful variants:

```bash
bun run electron:dev:bundled
bun run --cwd packages/electron ensure:electron
bun run type-check:electron
bun run lint:electron
```

`electron:dev:bundled` builds and uses packaged web assets instead of the HMR server. Use it when testing behavior closer to a packaged app.

Both dev variants run the staged OpenCode CLI from `resources/opencode-cli` (the one `prepare:opencode-cli` stages and packaged builds ship), not the `opencode` on PATH. `electron-dev.mjs` passes the directory to the backend as `OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR`; when the binary is missing it warns and falls back to PATH.

## Packaging

Built-in SDK extensions are built by the web build into `@openchamber/web/server/built-in-extensions`. Electron Builder unpacks that directory from ASAR, and `main.mjs` supplies its physical path to the backend. This keeps both iframe assets and future Node service entries usable. Sources and the registry live in `packages/extensions`; user data remains in the instance data directory.

From the repo root:

```bash
bun run electron:build
```

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `prepare:opencode-cli` to download/cache the pinned OpenCode CLI and copy it into `packages/electron/resources/opencode-cli`.
3. `bundle:main` to create `packages/electron/dist-bundle/{entry,main,early-startup}.mjs`.
4. `rebuild:native` to rebuild native modules for Electron.
5. `package.mjs` to run `electron-builder`; its `afterPack` hook stages the compiled macOS icon asset catalog.

Build output goes to `packages/electron/dist`.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

## Platform Notes

macOS packaging needs Xcode/build tools for notarized builds and icon asset compilation.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer. Windows updates use `latest.yml` for x64 and the `latest-arm64.yml` channel for ARM64 so each installation resolves an architecture-matching installer.

Linux AppImages must be built natively. Set `OPENCHAMBER_TARGET_ARCH=x64` or `OPENCHAMBER_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the bundled OpenCode CLI, native Electron rebuild, and Electron Builder architecture. Linux identity is stable across architectures: executable `openchamber`, desktop file `openchamber.desktop`, icon `openchamber`, and `StartupWMClass=openchamber`.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, pinned OpenCode CLI version and architecture, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Desktop clears AppImage `ARGV0` from `process.env` before probing the login shell and starting the in-process server. Leaving it set makes zsh rewrite argv[0] for integrated-terminal and managed-OpenCode child commands to the AppImage path.

Linux updates are supported only when the packaged app is running from a writable AppImage. Update checks, downloads, and installation report an actionable error when `APPIMAGE` is missing, invalid, or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. Authenticated Web clients connected to the embedded Desktop Host use this same `electron-updater` check, download, and restart flow rather than a package-manager command. macOS and Windows updater behavior is unchanged. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate and validate each manifest against its AppImage before upload. Linux AppImages download full updates (no `.blockmap` differential channel yet).

`desktop_restart` does not answer the renderer before the install is decided. On the apply-update path it calls `quitAndInstall()` and keeps the IPC call open until the app quits or `autoUpdater` emits `error`, which the platform installers do asynchronously (a rejected code signature, or a Squirrel session disabled by an earlier failure). A failed install rejects the IPC call so the update dialog can show it, and the quit/install flags are rolled back because the app is staying up. A still-running app after the grace period resolves the call. The installer grace period starts after backend cleanup, so a slow terminal shutdown cannot remove the error listener before installation begins.

### Updater End-to-End Fixture

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](./scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls, auto-update, system tray (right-click Show / Hide / Close), and launch-at-login (XDG autostart). Opening files in installed apps, installed-app discovery, and FreeDesktop icon lookup (including the default file manager) work on macOS, Windows, and Linux.

On Windows and Linux, the General setting persisted as `desktopMinimizeToTrayEnabled` keeps the app running in the tray when the main window is **closed**. Minimize — the in-app control, the native title-bar button, and the taskbar — always performs a normal window minimize, so the taskbar entry stays available.

The macOS menu bar item is enabled by default and can be disabled in General settings. The setting applies after restart. While disabled, Desktop skips the native tray controller, tray-specific subscriptions, polling, and quota refresh. Dock badges remain independent: unread activity, session membership, and badge preferences still update the Dock through the shared IPC command. Turning off the Dock badge clears its count without enabling the menu bar item.

## Bundled OpenCode CLI

Packaged Desktop builds include the official OpenCode CLI release pinned by `opencodeCli.version` in `packages/electron/package.json` (OpenChamber requires OpenCode 2.x). OpenCode 2.x ships on npm rather than as GitHub release assets, so `prepare:opencode-cli` downloads the platform package tarball (`@opencode/cli-<os>-<arch>`, the same one OpenCode's own installer uses), caches it under `packages/electron/.cache/opencode-cli`, stages `opencode` or `opencode.exe` into `resources/opencode-cli`, and verifies `opencode --version` before packaging. Re-running the step is fast when the staged binary already matches the pinned version.

Managed local Desktop startup prefers OpenCode binaries in this order:

1. `settings.opencodeBinary`.
2. Environment overrides: `OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`, or `OPENCHAMBER_OPENCODE_BIN`.
3. The bundled Desktop CLI in `process.resourcesPath/opencode-cli`.
4. System installs discovered from PATH.
5. Known npm/Bun/Homebrew/Scoop/Chocolatey and other standard install locations.
6. Platform discovery through `where opencode` on Windows or a login shell on macOS/Linux.

Use an explicit override when testing a different OpenCode CLI build or when a user needs to point Desktop at a custom binary. The configured path must point to the standalone CLI, not the OpenCode Desktop app executable.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `OPENCHAMBER_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `OPENCHAMBER_SKIP_LOCAL_SERVER=1` | Skips the in-process local OpenChamber server and uses the configured default remote instance; Desktop imports this from the user's login-shell environment, and packaged/bundled UI remains available for connection recovery |
| `OPENCHAMBER_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `OPENCHAMBER_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `OPENCHAMBER_RUNTIME=desktop` | Set by Electron before starting the web server |
| `OPENCHAMBER_OPENCODE_CLI_VERSION` | Optional packaging override for the bundled OpenCode CLI version; defaults to `opencodeCli.version` in `packages/electron/package.json` |
| `OPENCHAMBER_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `OPENCHAMBER_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `OPENCHAMBER_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCHAMBER_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in Desktop/server logs; disabled by default |
| `OPENCHAMBER_DESKTOP_USER_DATA_DIR` | Test hook used by `profile:startup`: moves the Electron profile (single-instance lock, Chromium caches) so a measured launch does not share it with the installed app |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

## Native Features Owned Here

- Floating Mini Chat windows.
- Mini Chat loads from the resolved local UI origin in HMR development, not the
  API server origin. Bundled mode keeps `openchamber-ui://` assets. Native zoom
  targets the focused window directly; composer focus adjusts interface scale,
  while terminal and file-editor focus adjust their own font sizes.
- New Mini Chat windows default to the managed Chats target. Explicit project/worktree drafts retain their target, existing managed chat sessions reopen in their own directory, and the compact header omits project/branch metadata for Chats. Opening a managed draft back in the main window preserves that target.
- Multiple native windows.
- Native notifications.
- User-confirmed local folder selection. The shared UI supplies the requested directory as the picker `defaultPath`; confirmation is required before filesystem access is retried.
- Theme-file selection uses the local `~/.vscode/extensions` directory when present.
  The local-page-gated `desktop_pick_theme_file` command returns only the selected
  filename, bounded text, and byte size. Its host stays local when the renderer
  connects to a remote API server; remote pages receive no native picker privileges.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding.
- SSH uses OpenSSH ControlMaster on macOS/Linux. Windows uses independent hidden OpenSSH processes for setup commands and each long-lived forward because Win32 OpenSSH does not support ControlMaster reliably.
- A managed SSH instance runs one server per remote host. The server outlives the SSH session by default (`keepRunning`), so every connect first asks the remote CLI (`openchamber status --json`) what is already running and reuses a server that fits the instance's password. `/api/system/info` is public, so an answer proves nothing about the password: the server has to accept it on `/auth/session`, or have none when the instance has none. Among the servers that fit, a CLI-started daemon of another app version, or one whose bind address no longer matches the instance's network setting, is stopped and replaced. A registered server that is passed over gets a line in the connect log saying why. Foreground servers and servers with another password are neither reused nor stopped. With `keepRunning` off, disconnecting stops an adopted daemon the same way it stops one this session started. The server is shared by every client that fits it, so that stop also ends it for any other client still connected. Starting a server without this lookup leaks one server plus its opencode per reconnect.
- Tunnel lifecycle integration through the web server runtime.
- Remote dev-server previews use a direct WebSocket tunnel when the instance has an HTTP address. Relay-only instances keep the encrypted relay transport in the renderer and bridge its raw bytes to the browser panel through a local Electron listener.
- Auto-update checks, downloads, and restart/apply flow.
- The browser panel's own session (`persist:openchamber-browser`): its storage is
  cleared only through the scoped clear-data command, and camera, microphone,
  location, and device-picker requests from pages shown there are denied. Electron
  grants permission requests by default when no handler is set, and the panel
  loads whatever address the user types. Tab favicons are fetched in this
  session too, so icons behind the page's own login resolve and the app's origin
  never requests anything from a third-party host. Self-signed loopback HTTPS
  pages may use an untrusted certificate authority; certificate failures for
  external hosts and all other certificate errors remain blocked.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `openchamber:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Logs And Data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. In packaged apps, logs are written through the platform log path for the `OpenChamber` app name.

Development builds use a separate user data directory named `OpenChamber Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Do not move OpenCode feature backend logic into Electron.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@openchamber/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup. Keep `early-startup.mjs` external too: the entry and main bundles must share its one instance.
- Keep `entry.mjs` small. Anything imported there delays Electron's `ready`; everything else belongs behind the `main.mjs` import.
- Rebuild native modules after dependency or Electron version changes.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick Checks

```bash
bun run type-check:electron
bun run lint:electron
bun run electron:dev:bundled
```

For full repo validation before shipping:

```bash
bun run type-check
bun run lint
```
