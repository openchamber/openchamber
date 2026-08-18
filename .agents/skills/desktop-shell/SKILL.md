---
name: desktop-shell
description: Use when changing Electron main/preload code, desktop IPC, native windows, menus, dialogs, notifications, updater behavior, deep links, SSH or tunnels, child processes, packaged startup, or Windows process spawning.
---

# Desktop Shell

## Required Context

Read `packages/electron/README.md` and nearby `packages/electron` code before editing. Context gathering is complete when each changed behavior is assigned to main, preload, renderer/shared UI, or web/runtime ownership.

Load `ui-api-decoupling` when a native change adds or alters a renderer-facing capability, `RuntimeAPIs`, runtime auth/URL behavior, or shared bridge contract. This skill owns the Electron privilege boundary; `ui-api-decoupling` owns the shared UI/runtime contract.

## Runtime Boundary

- Electron boots `@openchamber/web` in the same Node process and loads the UI over loopback. Do not introduce a sidecar server process.
- Keep renderer contracts and domain logic in `packages/ui`, server behavior in `packages/web`, and Electron focused on inherently native behavior: windows, menus, dialogs, notifications, updater, deep links, runtime host switching, privileged IPC, SSH, and tunnel lifecycle.
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

Run focused Electron tests and package checks. For startup, preload, routing, or packaging changes, completion requires both HMR development and bundled UI validation. For Windows process work, completion requires inspection of the complete process tree with no console flash; command success alone is insufficient.
