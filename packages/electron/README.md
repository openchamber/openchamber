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
Window state is saved only while the main window is not minimized, so transient
minimized bounds cannot replace the last normal size or maximized state.

Login-shell environment discovery starts as soon as `main.mjs` runs and
proceeds asynchronously, so shell startup files run while the window comes up.
Startup callers share one probe and await its result before reading
shell-provided server flags or importing the backend. The probe tries
interactive login, then login-only on failure, with a five-second timeout per
attempt. Text that shell startup files print to stdout before the environment
is discarded, so a banner never fuses with the first variable. Failure
preserves the inherited process environment. Confirmed quit cancels an
in-flight probe and waits for its process to exit.

Packaged builds turn on Node's on-disk V8 code cache in `entry.mjs`, under
`<userData>/v8-compile-cache`, so later launches compile `main.mjs` and the
server's module graph from cached bytecode (`compile-cache.mjs`). The entry's
own static imports compile before it runs and stay outside the cache.
Development and AppImage launches skip it (an AppImage mounts at a new path
every launch, and entries are keyed by path). `NODE_COMPILE_CACHE` is kept out
of the environment, so OpenCode, terminals and git hooks never write into the
app profile. Five seconds after startup main flushes the cache and removes the
subdirectories of other Node versions left by an Electron upgrade. Removal is
confined to `<userData>/v8-compile-cache`, a root computed from userData and
never from the directory Node reports; when Node's active directory is not a
direct child of that root, nothing is removed.

On a plain local launch with packaged UI (no `OPENCHAMBER_SERVER_URL`, no
remote or SSH default instance, local server not skipped) main navigates the
splash to the application as soon as the login-shell probe has resolved,
before the local server is imported, and the renderer parses, fetches and
compiles the application while the server starts. The runtime values the
application needs before any request (local origin, API base, client token)
do not exist yet, so that document ends with a parser-blocking
`<script src="/__runtime-config.js">` instead of the inline values; main
answers it once `activateMainWindow` has the resolved runtime
(`packaged-runtime-config.mjs`). The script carries the client token, and a
classic `<script src>` ignores CORS, so each pending document gets its own
single-use nonce in the script URL; a request without an issued, unclaimed
nonce, or whose fetch metadata is not a same-origin script load, gets 404. A
sandboxed preview or plugin frame cannot read the document, so it cannot
learn the nonce. Module scripts run only after parsing ends,
so no application code runs before the values are set. Remote, SSH,
environment-target, HMR and background launches keep the previous order:
resolve, then navigate, with the splash reporting the connection attempt.

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

Additional windows keep their own per-window runtime bootstrap instead of being overwritten by the main window. Child pages (extension iframes, the browser panel) never receive this runtime state.

The packaged UI protocol rejects relative `/api`, `/auth`, and `/health` requests with JSON `503`; runtime calls must use the per-window HTTP base and never fall back to the app shell.

Extension frames load from `/api/guest-files/<grant>/…`, or `/api/guests/<id>/…` on a server without grants; the desktop navigation guard treats both prefixes as the extension's own pages.

The HTML file preview runs in a sandboxed iframe without `allow-same-origin`, so it has an opaque origin like an extension frame. The desktop navigation guard lets the main app frame load `/api/fs/preview/<grant>/…` into an empty direct child, or reload a preview child with a new grant after the file is saved, and lets the preview follow its own links between pages of the same grant. A preview cannot reach another grant or any other route, and loaded extension frames and their children cannot navigate to a preview.

For a saved host, the guard treats both its `url` and its `apiUrl` as the app's own origin. When a relay host's LAN address changes, the candidate refresh in `packages/ui/src/lib/desktopRelayRestore.ts` rewrites only `apiUrl`, and the window then loads extension pages from that address.

PDF iframes also start with an opaque origin under the packaged UI protocol. The guard lets the main app frame load the HTTP `/api/fs/raw` route into an empty direct child, including under a host path prefix. This does not let loaded extensions, HTML previews, or nested frames navigate to raw files. Isolated-space raw routes are not part of this exception.

The preload bridge exposes desktop-only APIs to the web UI through `window.__OPENCHAMBER_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI.

Confirmed chat application links use the local-page-gated `desktop_open_external_url`
command and the OS protocol handler. `external-url-policy.mjs` validates schemes
again in main, with the same exclusions as the shared UI classifier. Native
opening failures do not fall back to a browser window for application links.

Native menu actions reach the renderer as one DOM event per click. Main must not also send them over IPC: preload turns every IPC emit into a call to its bridge listeners and a DOM event, so the action would run again. Update-check notifications go over IPC only, for the same reason.

Native Copy link uses `context-menu-clipboard.mjs` to write URL text and bookmark
metadata together through Electron's `ClipboardItem` API. `electron-context-menu`
4.1.2 still uses the old object-shaped clipboard write. Inside its `prepend` hook,
`defaultActions.copyLink()` returns the existing item, so replacing that item's
handler preserves menu order, visibility and live translations. Copy failures are
logged without clipboard data.

Linux exposes a second clipboard, PRIMARY, that the web Clipboard API cannot
reach. The local-page preload bridge publishes `clipboard.selection` only on
Linux, with `readText` and `writeText` for terminal selection and middle-click
paste. Both commands stay out of `COMMANDS_SAFE_FOR_REMOTE`; remote pages never
receive the bridge.

`scripts/smoke-context-menu.mjs`, run with Electron on an isolated display and
clipboard, checks the real dependency's menu identity, translations and native
clipboard writes. On Linux, run it inside a disposable container with its own Xvfb
display; it writes synthetic data to that display's clipboard and selection.
The fixture clicks the built menu item programmatically. A live right-click,
menu selection and paste in the app still need a separate interaction check.

From the repository root inside that disposable container:

```bash
xvfb-run -a packages/electron/node_modules/.bin/electron --no-sandbox packages/electron/scripts/smoke-context-menu.mjs
```

The local diagnostics IPC combines the desktop log with the SSH manager's in-memory history. `main.mjs` classifies SSH messages in the native process before returning them; host names, stderr and other raw SSH output never cross to the renderer. Remote SSH files are not read.

A window whose renderer crashes is reloaded (`renderer-recovery.mjs`). A crash
counts as one in a row when it comes within two minutes of the previous one.
The first two in a row reload as they are. The third reloads once in a safe
start: preload asks main over sync IPC before any page script runs and exposes
`window.__OPENCHAMBER_SAFE_START__`. The shared UI then forgets expanded
folders, open files and open panels before the first render, saves that, and
says so in a toast. A fourth crash in a row leaves the window alone; View >
Reload is still there. A quiet spell of two minutes starts the count again.

### Why a safe start and not a fixed reload budget

Issue 4907: a restored expanded folder with 28,000 files crashed the window
about 25 seconds after every load. The earlier budget of three reloads per
minute never ran out at that pace, and every reload restored the same folder,
so the window crashed for hours. Counting crashes in a row stops any such
loop, and dropping the saved layout removes the trigger seen so far. Settings
and the open chat stay; a crash they cause still stops at the fourth crash.

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
| `compile-cache.mjs` | Node's V8 code cache for the packaged main process: enabling it under userData, keeping it out of child environments, flushing and pruning after startup |
| `packaged-runtime-config.mjs` | Runtime values for packaged application documents: inline injection, and the blocking script and gate used while the first navigation runs ahead of the local server |
| `early-startup.mjs` | Settings and window-state reading, splash markup, main-window options, the early window handoff and buffered app events; shared by both bundles. Its window icon in an unpackaged Windows run is `dev-icon.ico`, the Windows icon behind construction tape (source `resources/icons/dev-icon-win.svg`), so the taskbar tells a dev copy apart; Linux keeps the usual icon, because GNOME takes the dock icon from the installed app's `.desktop` entry |
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `electron-host-probe.mjs` | Chromium direct-host probes, identity checks, attempt deadlines, and response cleanup |
| `host-probe-policy.mjs` | Selector fast attempt and unreachable-only retry policy |
| `startup-url-selection.mjs` | Pure bundled/HMR startup probe and loopback connection-limit policy |
| `app-cache.mjs` | Help > Clear Cache: drops the HTTP cache only, keeps site storage (device settings, pinned sessions, login cookies), reloads windows |
| `pairing-deep-link.mjs` | Validates an `openchamber://connect` pairing link for the confirmation prompt. After the user confirms, the main window's renderer redeems it (`desktop_take_pending_host_actions`) with the same code as Import Link, so relay-only links pair over the E2EE tunnel. `openchamber://host/<id>` for a host with a relay leg goes through the same queue |
| `remote-page-policy.mjs` | What remote-safe IPC accepts from and returns to another server's page: splash colour parsing, host list without credentials |
| `shell-environment.mjs` | Asynchronous login-shell environment discovery and shared one-shot probe |
| `windows-app-discovery.mjs` | Windows "Open in": which apps are installed, their icons, and launch candidates. Every `where.exe` and PowerShell lookup is awaited, because a synchronous spawn per candidate froze the window for the whole scan |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `startup-ssh.mjs` | Opening the default SSH instance's tunnel during startup, bounded, with teardown so a failed attempt boots Local (`sshStartupFallbackHostId` in the boot outcome) |
| `dev-dock-identity.mjs` | Unpackaged macOS runs only: the dev icon, the app icon behind construction tape, in the Dock and the issue or PR number from the checked-out branch on its badge, so copies from several worktrees can be told apart. On a numbered branch the number keeps the badge over the unread-chats count; without a number the count works as in the packaged app |
| `dev-window-tape.mjs` | Unpackaged runs only, every platform: a 5px strip of the same construction tape along the top edge of the main and mini chat windows, so a dev window can be told apart on screen. It ignores the pointer, so clicks and window dragging pass through |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/ensure-electron.mjs` | Verifies the installed Electron binary is complete and repairs it via the postinstall under Bun |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `scripts/prepare-opencode-cli.mjs` | Downloads and stages the pinned OpenCode CLI into `resources/opencode-cli` |
| `scripts/windows-executable.mjs` | Reads the CPU architecture of a Windows executable from its PE header |
| `scripts/opencode-cli-version.mjs` | Reads the pinned OpenCode CLI version and parses `opencode --version` output |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/{entry,main,early-startup}.mjs` for packaging |
| `scripts/rebuild-native.mjs` | Rebuilds native modules against the Electron runtime |
| `scripts/package.mjs` | Runs `electron-builder`, with unsigned Windows builds when signing env is missing |
| `scripts/windows-signpath.mjs` | Two-pass Windows build for SignPath signing, and the electron-builder sign hook it uses (see *Windows signing through SignPath*) |
| `resources/` | Packaged web assets, icons, macOS entitlements, and the NSIS include for the Windows installer. Every file in `resources/icons` is written by `bun run brand:generate` (`scripts/brand`); do not edit them by hand |

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

`/api/version` must advertise `api.runtime-url.v1` and report an
`openchamberVersion` of 2 or later, or the host is Incompatible and the app asks
to update OpenChamber on the server. A server before 2.0 runs OpenCode 1.x with
the same API version and capabilities, so its own version is the only thing that
tells it apart. A version that does not parse does not block.

The Incompatible recovery screen can ask the host to update itself
(`desktop_host_update_server`, local pages only, `remote-host-update.mjs`). The
command takes only a saved host id and reads the address, client token, and
request headers from the hosts file, so a page cannot aim the token at another
address. It posts to the host's `/api/openchamber/update-install`, the route
every server since 1.9 serves to its own web UI, and reports `started`, `auth`,
or `failed` with the host's reason. The renderer then probes the host until it
answers compatible and restarts the app to boot against it again.

Every exit aborts the attempt's requests and cancels unused response bodies before
clearing the deadline timer. This includes early HTTP classifications and a
successful session response whose body is not needed. TLS verification remains
enabled. These rules do not change relay probing or the preload/IPC contract.

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/entry.mjs`. An in-app restart under this script skips `app.relaunch()`: Electron exits with the code the script passes in `OPENCHAMBER_ELECTRON_DEV_RELAUNCH_EXIT_CODE`, and the script starts Electron again while the HMR server keeps running. On Windows, the HMR launcher resolves npm's `bun.cmd` shim to the underlying `bun.exe` before spawning Bun child processes.

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
3. `prepare:ripgrep` to download/cache the target architecture's ripgrep and copy it into `packages/electron/resources/ripgrep`.
4. `bundle:main` to create `packages/electron/dist-bundle/{entry,main,early-startup}.mjs`.
5. `rebuild:native` to rebuild native modules for Electron.
6. `package.mjs` to run `electron-builder`; its `afterPack` hook stages the compiled macOS icon asset catalog and gives the macOS main executable its own UUID.

Build output goes to `packages/electron/dist`.

Electron Builder copies the `@openchamber/web` workspace package whole, ignoring its `files` field, so `build.files` in `package.json` excludes what the packaged runtime never loads: the web package's `dist` (packaged builds serve `Resources/web-dist` through `OPENCHAMBER_DIST_DIR`), its `src`, configs, tests and stray tarballs; TypeScript sources, source maps and Markdown other than licenses from every dependency; `bun-pty`, which only the Bun runtime imports; luxon builds other than `build/node` (CommonJS, for cron-parser) and `build/es6` (ESM, for the server); and `node-pty` prebuilds other than `${platform}-${arch}` (the Electron-rebuilt `build/Release` binary loads first; `${platform}` is the build host, which matches the target because `rebuild:native` already builds for the host OS). Keep these exclusions in the top-level `files`: Electron Builder treats a platform-level `files` list as its own file set, and one holding only exclusions copies the whole package directory into the archive. The `afterPack` hook then reads the `app.asar` header (`scripts/packaged-app-contents.cjs`) and fails the build when anything outside `node_modules` other than the bundled main files, `preload.mjs` and `package.json` is packed, when the web `dist` is packed, or when the bundled main files, the web server entry and manifest, or the unpacked git helpers are missing.

Windows voice-model installation uses the native decoder from `7zip-bin`, a runtime dependency of the web backend. Its executable stays in `app.asar.unpacked` so the server can spawn it directly with a hidden window. Windows packaging keeps only the target decoder architecture; macOS and Linux packaging exclude all decoder binaries. The `afterPack` check requires the target Windows decoder in both the ASAR header and the unpacked directory, including ARM64 builds on x64 hosts. Extraction and staging remain owned by the [dictation module](../web/server/lib/dictation/DOCUMENTATION.md).

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage, a `.deb` and an `.rpm` for the native x64 or arm64 host; the `.rpm` needs `rpmbuild` on the build host.

### Why the macOS executable gets its own UUID

macOS Local Network privacy identifies an app by its main executable's Mach-O `LC_UUID` (Apple TN3179). Electron ships one prebuilt executable per version and architecture, so every app on the same Electron release shares that UUID, and macOS applies the Local Network answer of whichever of those apps it met first. OpenChamber then never gets its own prompt: its terminals and the managed OpenCode get `No route to host` for LAN addresses when the other app was denied or never asked, and the prompt, when one shows, names the other app. The `afterPack` hook (`scripts/macos-executable-uuid.cjs`) writes a UUID derived from the `appId` before electron-builder signs, so it stays the same across releases and the user's answer survives updates; the first update to such a build asks once. The hook then signs the executable ad hoc, so a build that skips signing still launches on arm64. Only the small launcher changes; `Electron Framework.framework` and the helper apps keep Electron's binaries. A thin executable is required, so a `--universal` build fails here.

Making terminals and OpenCode their own responsible process (a private `responsibility_spawnattrs_setdisclaim` launcher) also gets them LAN access, but it moves every other privacy prompt they raise, such as Documents or Desktop, away from OpenChamber. With the UUID fix they stay attributed to OpenChamber.

### Windows signing through SignPath

`.github/workflows/windows-signed-build.yml` builds and signs the Windows app; the signing policy, organization and project are the `env` block at its top. Two workflows call it: the desktop smoke workflow (`sign_windows` input) and `release-windows.yml`, run from a release tag. Releases still come unsigned from `release.yml` until the SignPath Foundation certificate is issued; then `release.yml` stops building Windows and publishing, and `release-windows.yml` adds the signed files to the draft and publishes it. `scripts/windows-signpath.mjs` drives the build in two passes, each followed by one signing request that holds both architectures, so a build needs two approvals in SignPath:

1. `build-app` builds the app and stages `OpenChamber.exe` and the NSIS uninstaller. The request uses the `windows-app` artifact configuration.
2. `build-installer` puts the signed `OpenChamber.exe` into the same unpacked app and builds the installer from it (`--prepackaged`), with the signed uninstaller in place. The request uses `windows-installer`.
3. `finalize` regenerates the blockmap and `latest.yml`, which electron-builder computed from the unsigned installer.

Only those executables are ours. Electron's DLLs, `elevate.exe`, the bundled OpenCode CLI, ripgrep and node-pty's binaries come from upstream projects, and SignPath Foundation's terms forbid signing them with our certificate; they ship unsigned inside the signed installer.

#### Why Windows releases get their own workflow

SignPath refuses a signing request from a run where any job ran on a runner other than GitHub-hosted, including jobs that never touched the Windows files. `release.yml` runs npm, macOS and Linux on Blacksmith runners, so signing inside it fails. `release-windows.yml` builds and signs in a run of its own. Re-signing the installers `release.yml` built is ruled out: SignPath vouches that a file was built from the source in the run that asks for the signature.

#### Why the second pass reuses the unpacked app instead of building again

`OpenChamber.exe` carries the hash of `app.asar` in its resources. A fresh pack writes a new `app.asar`, and the signed executable from the first pass would no longer match it.

#### Why the uninstaller is swapped in a sign hook

electron-builder compiles the uninstaller and embeds it in the installer within one NSIS step, and SignPath signs only files a workflow step uploads. The `win.signtoolOptions.sign` hook is the one point between those two: in the first pass it copies the uninstaller out, in the second it replaces the freshly compiled uninstaller with the signed copy. Both come from the same NSIS script and version.

## Platform Notes

macOS packaging needs Xcode/build tools for notarized builds and icon asset compilation.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer. `build.nsis.include` adds `resources/installer.nsh`, which declares the installer and uninstaller DPI-aware; without it Windows scales their windows as a bitmap and they look blurred at a display scale above 100% (#5010). Windows updates use `latest.yml` for x64 and the `latest-arm64.yml` channel for ARM64 so each installation resolves an architecture-matching installer.

Linux packages must be built natively. Set `OPENCHAMBER_TARGET_ARCH=x64` or `OPENCHAMBER_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the bundled OpenCode CLI, native Electron rebuild, and Electron Builder architecture. Linux identity is stable across architectures: executable `openchamber`, desktop file `openchamber.desktop`, icon `openchamber`, and `StartupWMClass=openchamber`.

The Linux icon is the 512×512 `resources/icons/app-icon.png`, which the AppImage carries at `usr/share/icons/hicolor/512x512/apps/openchamber.png`. Keep it a PNG of at most 512×512: electron-builder's default AppImage path puts an SVG at `hicolor/scalable/` without the `apps/` directory, and the hicolor theme declares no size above 512, so in both cases launchers cannot resolve `Icon=openchamber` (#4766, #2934).

GNOME 46+ shows a window's icon only through a `.desktop` file that matches its app id (`openchamber`); a window without one gets the generic executable icon on Wayland and XWayland alike. So a packaged AppImage started directly, with no integration tool, writes its own launcher entry at startup (`linux-desktop-entry.mjs`): `$XDG_DATA_HOME/applications/openchamber.desktop`, marked `X-OpenChamber-Managed=true`, with the image's 512×512 icon copied to `$XDG_DATA_HOME/icons/hicolor/512x512/apps/openchamber.png`. Each start rewrites `Exec` and `TryExec` if the AppImage moved; `TryExec` hides the entry once the file is deleted. The app never touches an entry without that marker, and it withdraws its own once another integration exists: a launch with `DESKTOPINTEGRATION` set (Gear Lever), or another entry in `$XDG_DATA_HOME/applications`, where those tools write theirs, that is named `openchamber.desktop`, claims `StartupWMClass=openchamber`, or starts this AppImage. An entry the user hid with a menu editor (`NoDisplay=true` or `Hidden=true`) is left as it is. GNOME re-matches open windows when the entry appears, so the first launch gets its icon a few seconds after start. The `.deb` and `.rpm` install their own `openchamber.desktop` under `/usr/share/applications`, which a user entry of the same name would hide. So while a system data directory holds `openchamber.desktop`, a packaged start that is not an AppImage removes the marked user entry and an AppImage start writes none. An extracted AppImage, which also runs without `APPIMAGE`, leaves the entry alone when no package is installed.

The `.deb` and `.rpm` install to `/opt/OpenChamber` and use their own `resources/linux/after-install.tpl` and `after-remove.tpl`: electron-builder's scripts minus the `/usr/bin/openchamber` link, because `openchamber` on `PATH` is the CLI of `@openchamber/web` and the link would replace it. The menu entry starts `/opt/OpenChamber/openchamber`. The package `Maintainer` and `Homepage` come from `linux.maintainer` and `homepage` in `package.json`; `fpm` refuses to build a `.deb` without them.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, theme icon and `.DirIcon`, Electron executable, pinned OpenCode CLI version and architecture, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Desktop clears AppImage `ARGV0` from `process.env` before probing the login shell and starting the in-process server. Leaving it set makes zsh rewrite argv[0] for integrated-terminal and managed-OpenCode child commands to the AppImage path.

The variables Desktop sets for the in-process server (`OPENCHAMBER_RUNTIME`, `OPENCHAMBER_HOST`, the UI password, and the rest in `main.mjs`) go through `assignInjectedEnv` (`packages/web/server/lib/injected-env.js`), which records their names in `OPENCHAMBER_INJECTED_ENV`. The integrated terminal and agent shells inherit the record, so `openchamber startup enable` run from them keeps Desktop's configuration out of the startup service (#4604). Add a new variable the same way; a bare `process.env.X = ...` would leak into the service again.

The AppImage launcher also prepends its own directories to `PATH`, `LD_LIBRARY_PATH`, `GSETTINGS_SCHEMA_DIR` and `XDG_DATA_DIRS`, leaving a trailing `:` when a variable was unset. Desktop keeps them in its own process and removes them only from the integrated terminal, the managed OpenCode server, and the git environment the server builds (`stripAppImageLauncherEnv` in `packages/web/server/lib/inherited-env.js`), so user tools, agent commands and git hooks started from those paths see the user's values (#4177). `XDG_DATA_DIRS` keeps the standard system directories the launcher adds around the user's value.

Linux updates are supported when the packaged app runs from a writable AppImage or from an installed `.deb` or `.rpm`. electron-updater picks its installer from `resources/package-type`, which electron-builder writes into the packages: the AppImage is replaced in place by electron-updater. A package is downloaded by electron-updater but installed by `linux-package-install.mjs`: one `pkexec` call running `apt install` for a `.deb`, or the first of `zypper`/`dnf`/`yum`/`rpm` for an `.rpm`, so the system asks for the administrator password once. It runs asynchronously because electron-updater's installers use `spawnSync`, which freezes every window through the prompt and the install, and because its dpkg path retries a cancelled `dpkg -i` with `apt-get install -f`, a second prompt. Package installs relaunch through `linux-relaunch.mjs` instead of `app.relaunch()`: Chromium starts the relaunched process with `no_new_privs`, which every later `pkexec` refuses ("must be setuid root"), so the next update would fail without a prompt. A failed install after the backend stopped, a cancelled prompt included, relaunches the current version on every platform. Update checks, downloads, and installation report an actionable error when neither an AppImage nor a package type is found, or the AppImage is invalid or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. Authenticated Web clients connected to the embedded Desktop Host use this same `electron-updater` check, download, and restart flow rather than a package-manager command, except on a `.deb` or `.rpm` host: its password prompt would appear only on the host's screen while its server is down, so the check reports `installBlocked: 'desktop-host'` and the install route refuses with 409, and clients tell the user to update on that computer. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate; each lists that architecture's AppImage, `.deb` and `.rpm`, each updater takes the file of its own format, and `verify-update-manifest.mjs` checks every listed file against its bytes before upload. Linux updates download full files (no `.blockmap` differential channel yet).

`desktop_restart` does not answer the renderer before the install is decided. On the apply-update path it calls `quitAndInstall()` and keeps the IPC call open until the app quits or `autoUpdater` emits `error`, which the platform installers do asynchronously (a rejected code signature, or a Squirrel session disabled by an earlier failure). A failed install rejects the IPC call and rolls back the quit/install flags. A failure before backend shutdown leaves the app running; one after it relaunches the current version, because the in-process server does not restart in place. A Linux package install runs its own async install in place of `quitAndInstall()` and detaches the `error` listener first, so an unrelated update-check error during the password prompt cannot relaunch the app under a running install. A still-running app after the grace period resolves the call. The installer grace period starts after backend cleanup, so a slow terminal shutdown cannot remove the error listener before installation begins.

### Updater End-to-End Fixture

Updater checks preserve downloaded payloads for the same version. Feed errors
preserve an existing pending record; a missing feed with no pending record
keeps the first-release "no update" behavior. An authoritative no-update
response clears the record. Downloads for the same version share one process-wide
promise until the payload is on disk, including cached downloads without an event.
A request for another version fails as busy until that promise settles. Both the
download event and promise completion mark readiness only for their own version,
so an intervening check for a newer release cannot attach the old installer to it.

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](./scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux builds include in-app window controls, auto-update, system tray (right-click Show / Hide / Close), and launch-at-login (XDG autostart). Opening files in installed apps, installed-app discovery, and FreeDesktop icon lookup (including the default file manager) work on macOS, Windows, and Linux.

On Windows and Linux, the General setting persisted as `desktopMinimizeToTrayEnabled` keeps the app running in the tray when the main window is **closed**. Minimize — the in-app control, the native title-bar button, and the taskbar — always performs a normal window minimize, so the taskbar entry stays available.

Every path that hides a window instead of closing it goes through `hideWindow` (`window-hide.mjs`). On macOS a native full-screen window leaves full screen before hiding so its empty Space does not leave the display black. Hide and toggle shortcuts restore full screen when shown again; closing returns a normal window. Explicit show paths use `showWindow` to cancel pending hiding before showing or focusing, even while the window is still visible during the native transition. A repeated hide shares the pending transition, and closing discards its full-screen restoration. Windows and Linux hide in place.

An exit requested during entry remains queued in Electron even after an explicit show. The hide helper keeps its exit listener until that exit completes so Hide can restore full screen. Early entry remains a known gap: Electron exposes no public entry-start event or transition-state getter, and `isFullScreen()` can still report false while entry is pending, allowing an immediate hide before entry completes.

The macOS menu bar item is enabled by default and can be disabled in General settings. The setting applies after restart. While disabled, Desktop skips the native tray controller, tray-specific subscriptions, polling, and quota refresh. Dock badges remain independent: unread activity, session membership, and badge preferences still update the Dock through the shared IPC command. Turning off the Dock badge clears its count without enabling the menu bar item.

## Bundled OpenCode CLI

Packaged Desktop builds include the official OpenCode CLI release pinned by `opencodeCli.version` in `packages/electron/package.json` (OpenChamber requires OpenCode 2.x). OpenCode 2.x ships on npm rather than as GitHub release assets, so `prepare:opencode-cli` downloads the platform package tarball (`@opencode/cli-<os>-<arch>`, the same one OpenCode's own installer uses), caches it under `packages/electron/.cache/opencode-cli`, stages `opencode` or `opencode.exe` into `resources/opencode-cli`, and verifies `opencode --version` before packaging. Re-running the step is fast when the staged binary already matches the pinned version. The target architecture comes from `OPENCHAMBER_TARGET_ARCH` or `ELECTRON_BUILDER_ARCH`, falling back to the build host. A Windows build for another architecture does not run the binary, because the arm64 release job runs on an x64 runner that cannot start it; there the step checks the version in the package's `package.json` instead; on Windows `verify:opencode-cli` and `verify:opencode-cli:packaged` also read the binary's PE header (`scripts/windows-executable.mjs`) and fail when it was built for another architecture.

Managed local Desktop startup prefers OpenCode binaries in this order:

0. `opencodeBinary` in the machine policy file, when an administrator pinned one. It has no fallback: an unusable pin stops startup instead of trying the entries below (see `packages/web/server/lib/enterprise-mode.js`).
1. `settings.opencodeBinary`.
2. Environment overrides: `OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`, or `OPENCHAMBER_OPENCODE_BIN`.
3. The bundled Desktop CLI in `process.resourcesPath/opencode-cli`.
4. System installs discovered from PATH.
5. Known npm/Bun/Homebrew/Scoop/Chocolatey and other standard install locations.
6. Platform discovery through `where opencode` on Windows or a login shell on macOS/Linux.

Use an explicit override when testing a different OpenCode CLI build or when a user needs to point Desktop at a custom binary. The configured path must point to the standalone CLI, not the OpenCode Desktop app executable.

## Bundled ripgrep

Find in files (the contents mode of the sidebar's file search) runs ripgrep, which `@openchamber/web` gets from `@vscode/ripgrep`. That package installs one platform package (`@vscode/ripgrep-<os>-<arch>`) for the machine running `bun install`, so a desktop build for the other architecture would ship the wrong binary. `prepare:ripgrep` downloads the target architecture's platform package tarball from npm at the version the lockfile pins, checks the tarball, downloaded or cached, against the sha512 that `bun.lock` records for that package, caches it under `packages/electron/.cache/ripgrep`, stages `rg` or `rg.exe` into `resources/ripgrep`, and runs `rg --version` on it. A Windows arm64 build runs on an x64 runner, so its workflow step passes `OPENCHAMBER_TARGET_ARCH` and the version run is skipped there. `extraResources` ships that directory as `Resources/ripgrep`, and `build.files` keeps every `@vscode/ripgrep-*` platform package out of the asar. The `afterPack` check fails the build when the staged binary is missing or a platform package was packed; the Linux AppImage verifier also checks the binary's ELF architecture.

The server (`packages/web/server/lib/fs/ripgrep.js`) looks for ripgrep in this order: `Resources/ripgrep` in a packaged build, the installed `@vscode/ripgrep` platform package (desktop development, web installs, Docker), then `rg` on the PATH. Without any of them the search route answers 501 and the file tree says the server cannot search contents.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `OPENCHAMBER_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `OPENCHAMBER_SKIP_LOCAL_SERVER=1` | Skips the in-process local OpenChamber server and uses the configured default remote instance; Desktop imports this from the user's login-shell environment, and packaged/bundled UI remains available for connection recovery. The host switcher then lists no Local entry and names the window's address as the current instance. Every start that skips the server, or opens `OPENCHAMBER_SERVER_URL`, says so in `main.log`, because a launcher that inherits these variables leaves no other trace |
| `OPENCHAMBER_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `OPENCHAMBER_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT` | Development only: opens Chromium's DevTools protocol on this loopback port so a debugger can attach to the dev window; ignored in packaged builds |
| `OPENCHAMBER_RUNTIME=desktop` | Set by Electron before starting the web server |
| `OPENCHAMBER_OPENCODE_CLI_VERSION` | Optional packaging override for the bundled OpenCode CLI version; defaults to `opencodeCli.version` in `packages/electron/package.json` |
| `OPENCHAMBER_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `OPENCHAMBER_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `OPENCHAMBER_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCHAMBER_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in Desktop/server logs; disabled by default |
| `OPENCHAMBER_DESKTOP_USER_DATA_DIR` | Test hook used by `profile:startup`: moves the Electron profile (single-instance lock, Chromium caches) so a measured launch does not share it with the installed app |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

## Native Features Owned Here

- Floating Mini Chat windows. Each new one opens pinned on top of other
  windows; its pin button unpins that window only, and nothing is persisted.
- Quake Mode (Windows Terminal-style): one configurable global hotkey
  (``Ctrl+` `` by default, deliberately without the Win key) toggles the existing
  main window between hidden and a top-attached dropdown on the display holding
  the cursor. Startup always opens a normal window; Quake geometry (fullscreen
  by default, adjustable down to 30%) applies only when the hotkey is pressed
  while Quake Mode is enabled. The window stays an ordinary window otherwise
  (taskbar, Alt+Tab, minimize/maximize all behave normally). Hiding never
  destroys the renderer or its sessions; showing never reloads it. The hotkey
  hides the window only when it is visible and focused; a window behind
  another app is brought forward instead. Closing the window hides it while
  Quake Mode is enabled and its hotkey is registered; without a registered
  hotkey close behaves as usual, since nothing could bring the window back.
  A shortcut given to another action is stored as `__unassigned__` and never
  falls back to the default. See `quake-mode.mjs` (pure
  settings/geometry/toggle helpers) and the `desktop_get/set_quake_mode*` IPC
  commands in `main.mjs`.
- Mini Chat loads from the resolved local UI origin in HMR development, not the
  API server origin. Bundled mode keeps `openchamber-ui://` assets. Native zoom
  targets the focused window directly; composer focus adjusts interface scale,
  while terminal and file-editor focus adjust their own font sizes.
- New Mini Chat windows default to the managed Chats target. Explicit project/worktree drafts retain their target, existing managed chat sessions reopen in their own directory, and the compact header omits project/branch metadata for Chats. Opening a managed draft back in the main window preserves that target.
- Multiple native windows.
- Native notifications. On macOS, viewing a session (the UI's
  `markSessionViewed`: opening it, or returning to the window while it is
  open) removes that session's delivered notifications from Notification
  Center through `desktop_clear_session_notifications`. Main removes only
  notifications it delivered in the current run. A click opens the session
  in the window that shows its instance and raises that window; the
  receiving window is brought forward first only when it already shows the
  same instance, so the local window does not jump in front of a remote one.
- User-confirmed local folder selection. The shared UI supplies the requested directory as the picker `defaultPath`; confirmation is required before filesystem access is retried.
- Theme-file selection uses the local `~/.vscode/extensions` directory when present.
  The local-page-gated `desktop_pick_theme_file` command returns only the selected
  filename, bounded text, and byte size. Its host stays local when the renderer
  connects to a remote API server; remote pages receive no native picker privileges.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling. The switcher lists Local only with the origin main reports for the local server, never with the page's own origin. A window can show another instance's own page, for example after a connect link redirects to that server. Such a page cannot switch to Local in place, because the local server answers only the app's own origins and the local token stays with local pages. The switcher asks main through the remote-safe `desktop_switch_to_local`, and main loads the Local UI into the main window the way `openchamber://host/local` does. The command acts only for the main window, because other windows keep the runtime they were opened with. Everywhere else it returns false and the switcher switches in place.
- Which instance a new window opens on. The main window and the menu New Window open the default instance: on launch the renderer reconnects a relay-capable default host (`restoreDesktopRelayRuntime` with no target). A window opened for a specific instance (the switcher's "Open in new window", a host deep link, Mini Chat) is marked with `--openchamber-explicit-runtime` and keeps that instance. A direct instance arrives as an injected endpoint and skips the restore; a relay-capable one arrives as `--openchamber-relay-host-id`, and the renderer connects it with `reconnectActive`, because boot already set that host's runtime key and a plain restore would treat the window as connected. Mini Chat passes the parent's runtime key, so main resolves a relay-capable parent to its host id. Windows opened for a configured host carry the host's id as a tag (`__ocHostWindowId`), and the renderer reports its live runtime key to main at boot and on every switch (`desktop_set_window_runtime_key`), so `openHostWindow` finds the window to reuse by the live key first and the tag second: a link or notification click for a host that is already open lands in that window instead of opening another.
- SSH host import, connections, logs, and port forwarding.
- SSH uses OpenSSH ControlMaster on macOS/Linux. Windows uses independent hidden OpenSSH processes for setup commands and each long-lived forward because Win32 OpenSSH does not support ControlMaster reliably.
- With ControlMaster, every forward, the main one included, is added with `ssh -O forward`: the master holds the listener, and that command's exit status is the answer. A `-N -L` client through the master would open a remote login shell and exit with that shell's status, which says nothing about the forward. The connection monitor then watches the local port and the master.
- A managed SSH instance runs one server per remote host. The server outlives the SSH session by default (`keepRunning`), so every connect first asks the remote CLI (`openchamber status --json`) what is already running and reuses a server that fits the instance's password. `/api/system/info` is public, so an answer proves nothing about the password: the server has to accept it on `/auth/session`, or have none when the instance has none. An instance without a password starts servers with the `OPENCHAMBER_UI_PASSWORD` the remote login shell sets, so a protected server is checked against that one; the probe pipes it to curl on the remote, so the desktop never asks for it and it stays out of command lines. Among the servers that fit, a CLI-started daemon of another app version, or one whose bind address no longer matches the instance's network setting, is stopped and replaced. A registered server that is passed over gets a line in the connect log saying why. Foreground servers and servers with another password are neither reused nor stopped. With `keepRunning` off, disconnecting stops an adopted daemon the same way it stops one this session started. The server is shared by every client that fits it, so that stop also ends it for any other client still connected. Starting a server without this lookup leaks one server plus its opencode per reconnect.
- Tunnel lifecycle integration through the web server runtime.
- Remote dev-server previews use a direct WebSocket tunnel when the instance has an HTTP address. Relay-only instances keep the encrypted relay transport in the renderer and bridge its raw bytes to the browser panel through a local Electron listener.
- Auto-update checks, downloads, and restart/apply flow.
- The browser panel's own session (`persist:openchamber-browser`): its storage is
  cleared only through the scoped clear-data command, and camera, microphone,
  location, and device-picker requests from pages shown there are denied. A focused
  page can write to the system clipboard, so its normal Copy controls and native
  paste work across tabs and local applications. Clipboard reads are limited to a
  focused page on the literal `localhost` hostname. External and tunnelled pages
  cannot read the system clipboard. Electron
  grants permission requests by default when no handler is set, and the panel
  loads whatever address the user types. Tab favicons are fetched in this
  session too, so icons behind the page's own login resolve and the app's origin
  never requests anything from a third-party host. Self-signed loopback HTTPS
  pages may use an untrusted certificate authority; certificate failures for
  external hosts and all other certificate errors remain blocked. Its cookies
  and storage are flushed to disk before quitting, because `app.exit()` skips
  Chromium's own shutdown write and a fresh sign-in would be lost. Electron
  drops session cookies (no expiry) on quit, and many sign-ins live in one, so
  before quitting they are rewritten with an expiry (`browser-panel-cookies.mjs`),
  as Chrome keeps them when it continues where you left off.
- `window.open` from a page in that session (`browserPanelWindowOpenTarget`): a
  scripted popup opens as a sandboxed child window of the app window, keeping
  `window.opener`, so a Google, GitHub or SSO sign-in can post its result back;
  the popup itself may open nothing further. Chromium reports `window.open(url)`
  without window features as a new tab, the same as a target=_blank link, so the
  session's preload (`browser-panel-preload.cjs`, exposes nothing) marks every
  `window.open` that keeps its opener as a popup. A link aimed at a new tab is
  noopener by default and becomes a panel tab
  (`openchamber:browser-panel-open-tab` to the renderer). Pages of an
  isolated space keep everything in place, so nothing leaves the space's session.
  Popups close with the window that opened them and do not count as app windows
  when closing the last one hides the app on macOS.

## IPC Pattern

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `openchamber:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities. A command added to `COMMANDS_SAFE_FOR_REMOTE` takes input from, and answers, another server's page: parse what it stores and strip credentials from what it returns (`remote-page-policy.mjs`). Splash colours, for example, end up in the trusted splash page, and `desktop_hosts_get` hands remote pages the host list without tokens or auth headers.
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
