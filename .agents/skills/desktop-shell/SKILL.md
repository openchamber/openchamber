---
name: desktop-shell
description: Use when changing Electron main/preload code, desktop IPC, native windows, menus, dialogs, notifications, updater behavior, deep links, SSH or tunnels, child processes, packaged startup, or Windows process spawning, and when driving or inspecting the desktop window (dev or installed) over CDP.
---

# Desktop Shell

## Required Context

Read `packages/electron/README.md` and nearby `packages/electron` code before editing. Context gathering is complete when each changed behavior is assigned to main, preload, renderer/shared UI, or web/runtime ownership.

Load `ui-api-decoupling` when a native change adds or alters a renderer-facing capability, `RuntimeAPIs`, runtime auth/URL behavior, or shared bridge contract. This skill owns the Electron privilege boundary; `ui-api-decoupling` owns the shared UI/runtime contract.

Before editing behavior a user can reach, write the surface list from `ui-api-decoupling`, *Name The Surfaces Before Editing*: one line per runtime, including the ones this change appears to leave alone. A native-looking change is the usual place this gets skipped: a shutdown order, an updater handoff, or a window lifecycle reads as desktop-only while the sequence around it is shared, and the platform guard that is correct on its own becomes a trap when the rest of the sequence does not account for it.

## Runtime Boundary

- Electron boots `@openchamber/web` in the same Node process and loads the UI over loopback. Do not introduce a sidecar server process.
- Keep renderer contracts and domain logic in `packages/ui`, server behavior in `packages/web`, and Electron focused on inherently native behavior: windows, menus, dialogs, notifications, updater, deep links, runtime host switching, privileged IPC, SSH, and tunnel lifecycle.
- Electron is the desktop release target.

## IPC And Security

Add a native capability the way `packages/electron/README.md`, *IPC Pattern*, orders it; the gate lives in main, never in the renderer. Shared UI code imports nothing from Electron.

Expose the narrowest payload and never expose filesystem, shell, tokens, or host secrets to remote pages.

Remote runtime pages must not gain local desktop privileges. Treat deep links, host imports, stored credentials, and runtime switching as trust-boundary operations that require explicit in-app confirmation before they change anything.

## Windows Background Processes

Non-user-visible child processes open no console window on Windows.

- Spawn the target executable directly with `windowsHide: true`.
- Use `stdio: 'ignore'` for detached/background helpers and call `unref()` when they must outlive Electron.
- Avoid `cmd.exe /c`, batch shims, `taskkill`, `ping` delays, and pipelines that create console grandchildren. `windowsHide` reliably controls only the directly spawned process.
- For delayed work that must survive app exit, spawn one first-level hidden helper, such as `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ...`; perform delay and work inside that process with cmdlets.
- Omit hidden-process behavior only for intentionally user-visible terminals or applications.

## Packaging And Lifecycle

- Keep native/external modules configured according to `packages/electron/README.md` and `bundle-main.mjs`.
- Preserve startup, quit, updater, notification, and deep-link behavior across development and packaged builds.
- Ensure cleanup tolerates partial startup and repeated shutdown signals.
- Every quit path goes through `prepareForQuit()` (`main.mjs`), which flushes renderer storage before `app.exit()`: that exit skips the pages' unload handlers, and unwritten localStorage would be lost.
- Do not infer readiness from stdout when an in-process callback or returned server handle exists.

## Validation

Before judging any change to the update or quit/install sequence, read `openchamber-change-discipline`'s `references/updater-testing.md`.

Auth and header bugs reproduce only in the installed app: only the packaged renderer (`openchamber-ui://app`) is cross-origin and attaches the client bearer (`Authorization: Bearer oc_client_…`); dev web and dev Electron run same-origin without it. To inspect the installed app, quit it and relaunch `/Applications/OpenChamber.app/Contents/MacOS/OpenChamber --remote-debugging-port=9222`, then talk CDP over the page's own `webSocketDebuggerUrl` from `http://127.0.0.1:9222/json/list` (a browser-level `connectOverCDP` times out). Its server answers on `desktopLocalPort` from `~/.config/openchamber/settings.json`; logs are in `~/Library/Logs/OpenChamber/main.log`.

To test the dev window the same way, start it with `OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT=9222 bun run electron:dev` (Electron drops a plain `--remote-debugging-port` passed through the dev script; packaged builds ignore the variable) and use the same CDP route. Every dev window shares the `OpenChamber Dev` profile and its single-instance lock, so a second one exits at once while another is open; give yours its own with `OPENCHAMBER_DESKTOP_USER_DATA_DIR="$(mktemp -d)"` and remove that folder when you stop it. Stop the window by the pid of `node ./packages/electron/scripts/electron-dev.mjs`: the `bash -c` that `bun run` wraps it in does not pass the signal on. `Runtime.evaluate` reads page and React state, and `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` go through Chromium's real input pipeline, so they exercise hit-testing and focus the way a user's click does; a scripted `element.click()` skips both.

Run focused Electron tests and package checks. For startup, preload, routing, or packaging changes, completion requires both HMR development and bundled UI validation. For Windows process work, completion requires inspection of the complete process tree with no console flash; command success alone is insufficient.
