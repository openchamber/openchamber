---
name: desktop-shell
description: Use when changing Electron main/preload code, desktop IPC, native windows, menus, dialogs, notifications, updater behavior, deep links, SSH or tunnels, child processes, packaged startup, or Windows process spawning.
---

# Desktop Shell

## Read First

Read `packages/electron/README.md` and nearby `packages/electron` code before editing.

## Runtime Boundary

- Electron boots `@openchamber/web` in the same Node process and loads the UI over loopback. Do not introduce a sidecar server process.
- Keep OpenCode feature backends and shared domain logic in web/server or runtime APIs.
- Keep Electron focused on inherently native behavior: windows, menus, dialogs, notifications, updater, deep links, runtime host switching, privileged IPC, SSH, and tunnel lifecycle.
- Shared renderer-facing contracts belong in `packages/ui`; shared server behavior belongs in `packages/web`.
- Electron is the desktop release target.

## IPC And Security

1. Add a preload bridge shape only when renderer-facing capability changes.
2. Handle the native operation in `main.mjs`.
3. Gate privileged commands in the main process; renderer checks are not security boundaries.
4. Expose the narrowest payload and never expose filesystem, shell, tokens, or host secrets to remote pages.
5. Do not import Electron from shared UI code.

Remote runtime pages must not gain local desktop privileges. Treat deep links, host imports, stored credentials, and runtime switching as trust-boundary operations.

## Windows Background Processes

Non-user-visible child processes must never flash a console window.

- Spawn the target executable directly with `windowsHide: true`.
- Use `stdio: 'ignore'` for detached/background helpers and call `unref()` when they must outlive Electron.
- Avoid `cmd.exe /c`, batch shims, `taskkill`, `ping` delays, and pipelines that create console grandchildren. `windowsHide` reliably controls only the directly spawned process.
- Prefer native Node/Electron APIs when available.
- For delayed work that must survive app exit, spawn one first-level hidden helper, such as `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ...`; perform delay and work inside that process with cmdlets.
- Omit hidden-process behavior only for intentionally user-visible terminals or applications.

## Packaging And Lifecycle

- Keep native/external modules configured according to `packages/electron/README.md` and `bundle-main.mjs`.
- Preserve startup, quit, updater, notification, and deep-link behavior across development and packaged builds.
- Ensure cleanup tolerates partial startup and repeated shutdown signals.
- Do not infer readiness from stdout when an in-process callback or returned server handle exists.

## Validation

Run the Electron package type-check/lint commands from `package.json` and focused tests. For startup, preload, routing, or packaging changes, test both HMR development and bundled UI mode. For Windows process work, inspect the complete process tree and verify no console flash; a successful command alone is insufficient.
