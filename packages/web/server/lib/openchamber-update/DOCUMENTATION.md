# OpenChamber Update Module

## Purpose

This module owns web package self-update transactions and the startup maintenance marker shared with the CLI. It replaces detached shell programs with an observable helper process that survives replacement of the installed `@openchamber/web` package.

Electron Desktop does not use this module. Packaged desktop updates remain owned by `electron-updater` in `packages/electron/main.mjs`.

## Files

- `runtime.js`: prepares transaction files outside the package directory, copies and launches the helper, waits for the helper startup marker, and reads sanitized status.
- `helper.mjs`: standalone built-in-only process that waits for the old server, installs an exact target version, verifies `package.json`, restarts or waits for the service manager, and verifies exact-version health.
- `maintenance.js`: reads the standard update marker used by CLI startup to defer supervisor/watchdog restarts while package files are being replaced.

## Transaction Files

Transactions live under `<openchamber-data>/updates/<transaction-id>/`:

- `request.json`: mode-0600 one-shot helper input. It contains the inherited runtime environment needed by independently managed helpers and is deleted immediately after the helper reads it.
- `status.json`: sanitized durable state consumed by `/api/openchamber/update-status/:transactionId`.
- `update.log`: package-manager and helper diagnostics. Restart environment values are never printed.
- `helper.mjs`: copied outside the package directory before replacement begins.

The active maintenance marker is atomically published at `<openchamber-data>/run/openchamber-update.lock/marker.json`. `openchamber serve` refuses to start while this marker points at a live helper. During replacement verification, only the transaction-tagged daemon or a foreground service restart can pass the gate. A helper that dies before package mutation begins is cleaned up automatically. A helper that dies during or after mutation leaves a durable recovery gate; `openchamber update` must successfully reinstall the pinned target before startup is allowed again.

## States

`prepared`, `waiting-for-server-exit`, `installing`, `verifying`, `rolling-back`, `restarting`, `awaiting-service-restart`, `checking-health`, `healthy`, `recovered-old-version`, and `failed`.

Only `healthy` means `/health` reported the exact requested target version. A healthy restored old server is `recovered-old-version`, never success.

If installation partially replaces the package or the exact target cannot restart, the helper blocks supervisors again, stops the replacement, reinstalls the exact previous version, and verifies previous-version health before reporting recovery.

If automatic recovery fails or the helper is interrupted after mutation begins, the maintenance marker remains in recovery-required state. This prevents systemd, launchd, Scheduled Tasks, watchdogs, and manual starts from executing an unverified package tree. A successful `openchamber update` repairs the pinned target and clears the marker; a failed repair leaves it intact.

## Platform Contract

The transaction state machine is shared by Windows, macOS, and Linux. Platform differences are limited to package-manager process resolution in `packages/web/server/lib/package-manager.js`.

Foreground systemd and launchd servers start the helper in an independent transient manager job so it is not killed with the old server cgroup/job. The built-in Windows Scheduled Task is retried until exact-version health confirms that the new task instance started.

Windows `.cmd` package-manager shims are resolved to their underlying Node entrypoint and launched with argument arrays. The updater fails before server shutdown when a shim cannot be resolved safely. It never passes multiline programs to `cmd.exe /c`.

## Tests

`helper.integration.test.js` creates two local `@openchamber/web` fixture tarballs, installs version A under an isolated global npm prefix containing spaces, replaces it with version B, launches B's fixture health server, and verifies exact target health. It also verifies failed-install recovery and secret redaction.

The suite also covers passive service-manager restart, Windows Scheduled Task retry behavior, request-file deletion failure, and durable interruption recovery gating.

The same integration test runs on Windows, macOS, and Linux CI without publishing a real release or modifying the machine's normal global npm prefix.
