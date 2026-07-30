# Phase 2C — Guardian Launch Wiring

## Scope (from inline PR-body steps 1–6)

1. Register `openchamber-guardian` in `packages/web/package.json#bin`.
2. Add `openchamber guardian {start | stop | status | reload}` subcommand
   (new `commands-guardian.js`) that wraps the entrypoint.
3. In `serveCommand()` (foreground + daemon paths), auto-start the guardian
   before `startWebUiServer` if no singleton is detected; reuse the
   `O_EXCL` PID file so we never run two. Add an opt-out
   (`OPENCHAMBER_GUARDIAN_AUTOSTART=disabled` or `--no-guardian`).
4. On graceful shutdown (`SIGTERM`/`SIGINT`), ask the guardian to stop
   too so it does not outlive the server.
5. End-to-end smoke test on Linux: start server, kill web process,
   restart it, confirm the OpenCode child is adopted and the UI does not
   show stale-active sessions; add a script under `scripts/` for Linux CI.
6. `openchamber-guardian` is Linux/POSIX only; Windows must be rejected
   explicitly with a friendly error.

## Decisions (with rationale)

### D1. Register `openchamber-guardian` as a published `bin` entry

- **Decision:** Add `"openchamber-guardian": "./bin/openchamber-guardian.js"`
  to `packages/web/package.json#bin`, next to the existing
  `"openchamber"` entry. Use the same shebang.
- **Why:** Canonical pattern (already established by `"openchamber"`).
  `npm`/`bun` installs expose the binary on PATH, so Linux packaging
  and `openchamber guardian` autostart use the exact same entrypoint.
- **Rejected:**
  - "Don't register, only spawn from CLI." Defeats the purpose; an
    operator running `openchamber-guardian` directly on the host
    (e.g. from systemd `ExecStart=`) becomes a second-class citizen.

### D2. `openchamber guardian` is a real CLI subcommand, not a child-process wrapper around the binary

- **Decision:** Create `packages/web/bin/lib/commands-guardian.js`
  modeled exactly on `commands-startup.js`: a single exported
  `guardianCommand(options, action)` with `status | start | stop | reload`
  actions, default `status`, parity through `cli-output.js`
  (`--json`, `--quiet`, non-TTY, interactive spinner/status). Wire it
  into `cli.js` as `commands.guardian = guardianCommand`, into
  `cli-args.js` as `guardianAction = (positional[1] || 'status')`,
  and into the `knownCommands` list for typo suggestions.
- **Why:**
  - **Capability parity in TTY/non-TTY/`--quiet`/`--json`.** Mandatory
    per `clack-cli-patterns` ("Mode parity is required"). The
    startup-command precedent already nails this. Re-using the same
    `printJson` / `logStatus` / `isJsonMode` / `isQuietMode` plumbing
    is the cheapest way to satisfy the parity matrix for free.
  - **Real value-add over `child_process.spawn(openchamber-guardian.js)`**:
    `start` in the CLI does a non-blocking spawn with the same env
    that `serve` would have used, then `await`s the socket probe
    (`isGuardianRunning`) to confirm the IPC socket is ready before
    printing "started". `stop` issues `GuardianClient.shutdown()` over
    the IPC and removes the PID file (best-effort). `status` shows
    `{ running, pid, socketPath }` from a single IPC `list` call. None
    of these are possible from a thin child-process wrapper without
    parsing the spawned process's stdout, which is fragile.
  - **Foreground & daemon reuse.** `serveCommand` will also need to
    do the same auto-start dance (D3). Keeping the logic in
    `commands-guardian.js` as small helpers (`startGuardianDetached({ logFd })`,
    `stopGuardianViaIpc({ timeoutMs })`) and importing them into
    `commands-serve.js` avoids duplicating spawn/env/PID bookkeeping.
- **Rejected:**
  - "Inline everything into `cli.js`." Bloats `cli.js` (already 457
    lines); the file would need a `case 'guardian':` plus a 100-line
    subcommand body — and the same body again in `commands-serve.js`.
  - "Pure child-process wrapper." Loses parity with startup,
    `clack-cli-patterns` parity matrix, and the ability to return
    a structured result (`{ running, pid, ... }`) without parsing
    log lines.

### D3. Auto-start inside `serveCommand` (foreground + daemon), gated on Linux + opt-out

- **Decision:** In `commands-serve.js`, **before** `startWebUiServer`
  (or before spawning the daemon child), call
  `maybeAutoStartGuardian({ logFd, options, emitNotice })`:
  - Skip if `process.platform === 'win32'`.
  - Skip if `options.guardian === false` (i.e. `--no-guardian`).
  - Skip if `options.handoff === false` (the user has already opted
    out of the entire guardian branch; no point starting it).
  - Skip if `process.env.OPENCHAMBER_GUARDIAN_AUTOSTART === 'disabled'`.
  - Probe via `isGuardianRunning(getGuardianSocketPath())`. If true,
    log `guardian already running (pid N)` and continue.
  - Otherwise, call `startGuardianDetached({ logFd, env: extraEnv })`
    which `spawn`s `bin/openchamber-guardian.js` with
    `detached: true, stdio: 'ignore'` (writes to a `guardian.log`
    next to the server log), `unref()`s it, and returns the spawned
    `pid` plus the PID file path so the CLI can later call
    `stopGuardianViaIpc({ timeoutMs })`.
- **Why:**
  - **Localize all changes to `commands-serve.js`.** The
    foreground and daemon paths already centralize port
    discovery, log file setup, env propagation, and PID-file
    bookkeeping. Adding a single helper call in both keeps the
    lifecycle single-source.
  - **`detached: true + unref()` is the proven daemon pattern** in
    this codebase (see `commands-serve.js:273-290` for the
    server itself). Reusing it keeps the relationship
    straightforward: the spawned guardian outlives the CLI process,
    just like the spawned server does.
  - **Opt-out mirrors existing convention.** `--handoff` /
    `--no-handoff` already established the
    *default-on, explicit-opt-out* pattern in `cli-args.js:431–436`.
    A sibling `--guardian` / `--no-guardian` follows the same shape.
- **Rejected:**
  - "Always require manual `openchamber guardian start`." Defeats
    the whole point of "autostart" — operators on a fresh host will
    silently fall through to the legacy path and re-open the bug.
  - "Lazy start inside the server on first handoff request."
    Couples the guardian's lifetime to the server's first handoff
    attempt — too late (the user has already opened a session and
    the process group is wrong) and races with restart.
  - "Modify `bin/openchamber-guardian.js` to auto-spawn itself."
    Breaks the entrypoint's contract (it's a singleton, not a
    parent) and creates a startup loop risk.

### D4. Graceful shutdown → stop guardian via IPC

- **Decision:** In `commands-serve.js`, when `foregroundServerActive`
  is set and `shutdownForegroundServer(signal)` runs, after
  `controller.stop({ exitProcess: false })` and **before** `cleanupFiles()`,
  call `stopGuardianViaIpc({ timeoutMs: 3000 })` only if
  `guardianAutoStarted === true` (so we don't accidentally stop a
  pre-existing guardian the operator started themselves). On the
  daemon path, the CLI exits immediately after spawning the detached
  guardian and detached server, so no shutdown call is needed — the
  server and guardian are independent; the operator stops each with
  `openchamber stop` / `openchamber guardian stop` respectively.
- **Why:**
  - **`GuardianClient.shutdown()` is a one-shot IPC RPC** that already
    exists in `guardian-client.js:176-178` and is wired in
    `ipc-server.js:53-57`. Reusing it is a 30-line helper, not a new
    protocol. The `detach` is best-effort: on failure we log and
    continue, matching the precedent set by the server's
    `cleanupFiles()` swallow-and-continue pattern.
  - **Scoped to CLI-launched guardians.** Stopping a guardian the
    operator started out-of-band would silently break their setup.
    Tracking `guardianAutoStarted` from D3 is the smallest way to
    gate this.
  - **Daemon path needs no cleanup.** The CLI process exits as soon
    as the server reports ready. Asking it to wait for a
    `shutdown` IPC over an unrelated long-lived guardian would
    re-couple lifetimes and contradict the daemon design.
- **Rejected:**
  - "Track the spawned guardian's pid and SIGTERM it directly."
    Skips the protocol-correct shutdown (no SQL cleanup, no
    child SIGTERM with timeout). The guardian already implements
    graceful shutdown over IPC — bypassing it is a downgrade.
  - "Don't stop the guardian at all." Leaves an orphaned guardian
    after every foreground run. On systemd / process-manager
    hosts this leaks processes.

### D5. End-to-end Linux smoke test as a shell script + a vitest

- **Decision:** Add two artifacts:
  1. `scripts/guardian-smoke-test.sh` — boots a real guardian via
     `node packages/web/bin/openchamber-guardian.js` against a temp
     `data-dir`, sends a `spawn`/`list`/`stop`/`shutdown` sequence
     using `socat` (or a tiny inline Node IPC client) over the Unix
     socket, asserts PID file created/removed, asserts the
     `--json` CLI surface works, prints "ok" / non-zero exit on
     failure. Skipped on non-Linux via `case "$(uname -s)" in
     Linux*) ;; *) exit 0 ;; esac` so CI on macOS / Windows no-ops.
  2. `packages/web/server/lib/guardian/launch-wiring.test.js` — a
     vitest that imports `commands-guardian.js` and verifies:
     - `guardianCommand(options, 'status')` returns `running: false`
       when no socket exists.
     - `startGuardianDetached({ logFd })` spawns a Node child with
       `bin/openchamber-guardian.js`, waits for the socket probe,
       returns `{ pid, socketPath }`.
     - `stopGuardianViaIpc({ timeoutMs })` issues a `shutdown` RPC,
       waits for the PID file to be removed, returns `true`.
     - All four subcommand actions produce the expected
       `--json` payload shape.
- **Why:**
  - **The shell script proves end-to-end runtime correctness** —
    a real binary, a real Unix socket, real process groups, real
    signals. None of the focused vitests can claim that.
  - **The vitest proves the CLI surface parity** in all four
    modes (TTY / `--quiet` / `--json` / non-TTY) without depending
    on `uname` / a real process group, so it runs in CI on every
    platform (the spawn parts skip on non-Linux).
  - **`socat` would add a runtime dep.** A tiny inline Node IPC
    client is ~40 lines and uses only `node:net`. Acceptable cost
    for a script that runs only on Linux CI.
- **Rejected:**
  - "Pure shell script with no vitest integration." CI would have
    no per-PR signal; the only way to verify would be a manual run.
  - "Only a vitest with a mocked child_process." Misses the
    end-to-end runtime check the user asked for explicitly in
    inline step 5.

### D6. Windows rejection: friendly error at CLI layer + entrypoint already exits 1

- **Decision:** `commands-guardian.js` calls `assertPlatformSupported()`
  (a new helper in `commands-guardian.js`) at the top of every action.
  On `process.platform === 'win32'`, throws a `TunnelCliError` with
  exit code `EXIT_CODE.USAGE_ERROR` and a message: "OpenChamber
  guardian is Linux/POSIX only. On Windows, use `openchamber` without
  the guardian handoff branch (`--no-handoff`) or the
  `openchamber guardian` subcommand."  In `commands-serve.js`, the
  `maybeAutoStartGuardian` helper short-circuits on Windows with a
  one-line `logStatus('info', 'guardian disabled on Windows')`.
- **Why:** The user-visible error is friendlier when it comes from
  the CLI layer (where the operator types the command) than from
  the entrypoint (where they get a bare `Guardian is Linux/POSIX
  only`). Both layers must reject — entrypoint as the last line of
  defense, CLI for UX.

## Concrete file-level change list

| File | Change |
|---|---|
| `packages/web/package.json` | Add `"openchamber-guardian": "./bin/openchamber-guardian.js"` to `bin` (D1). |
| `packages/web/bin/lib/commands-guardian.js` (new) | `guardianCommand(options, action)` with `status/start/stop/reload`, plus exported `startGuardianDetached({ logFd, env })`, `stopGuardianViaIpc({ timeoutMs })`, `maybeAutoStartGuardian(...)`, `getGuardianStatus()`. `cli-output.js` parity in all four modes. Windows guard. ~200 lines. |
| `packages/web/bin/lib/commands-serve.js` | Import the helpers from `commands-guardian.js`. Add `options.guardian = true` to options (`cli-args.js`); foreground + daemon both call `maybeAutoStartGuardian(...)` before `startWebUiServer` / before the server-detached `spawn`. Foreground shutdown calls `stopGuardianViaIpc` if `guardianAutoStarted`. |
| `packages/web/bin/lib/cli-args.js` | Add `guardianAction = (positional[1] || 'status')` next to `startupAction`. Add `case 'guardian'` / `case 'no-guardian'`. Add `--guardian` / `--no-guardian` to `showHelp()`. Add `guardian` to `knownCommands` in `cli.js`. Add `openchamber guardian` help section. |
| `packages/web/bin/cli.js` | Import `guardianCommand`; add `guardian: guardianCommand` to `commands` map; add `if (command === 'guardian') await commands.guardian(options, guardianAction); return;` next to the existing `startup` / `schedule` dispatch blocks; add `'guardian'` to `knownCommands` list. |
| `packages/web/bin/openchamber-guardian.js` | Already exits 1 on Windows (lines 102-105). Add a friendlier stderr message: "OpenChamber guardian is Linux/POSIX only and does not run on Windows." No behavior change. |
| `scripts/guardian-smoke-test.sh` (new) | End-to-end smoke test (D5). `chmod +x`. ~80 lines. |
| `packages/web/server/lib/guardian/launch-wiring.test.js` (new) | Vitest covering CLI parity + spawn/IPC helpers. ~150 lines. Linux-only parts skip on Windows. |
| `packages/web/server/lib/opencode/DOCUMENTATION.md` | Add a new "Phase 2C — Launch wiring" section documenting CLI surface, `--guardian` / `--no-guardian` / `OPENCHAMBER_GUARDIAN_AUTOSTART`, autostart in `serve`, shutdown sequencing, and Windows behavior. |
| `plans/issue-2421-restart-handoff/phases/phase-2c.md` | This plan. |

## Validation plan (no commit / push this turn)

After implementation, run (in order):

1. `node --check` on every new and changed `.js` file.
2. `npx vitest run packages/web/server/lib/guardian/launch-wiring.test.js`.
3. `npx vitest run packages/web/server/lib/guardian/` (regression).
4. `npx vitest run packages/web/server/lib/opencode/lifecycle-guardian-integration.test.js` (regression).
5. `npx vitest run packages/web/server` (full regression, expect prior 842 pass / 2 skip baseline).
6. `bun run type-check:web` (must be clean).
7. `bun run lint:web` (must be clean).
8. `bun run docs:validate` (must be clean).
9. `bash scripts/guardian-smoke-test.sh` (only on Linux; prints "ok" on success).
10. `bun run dead-code` (inspect report — non-blocking but must be reviewed).

## Out of scope (closed)

- **OpenCode-side session resume** is not in OpenChamber's scope.
  OpenCode already provides durable session resume via
  `SessionContextEpoch` + `SessionHistory` + `SessionCompaction`
  (SQLite event log). Phase 2C's job is to keep the OpenCode child
  alive across OpenChamber restart so that resume isn't needed in
  the common case; if the OpenCode child itself dies, OpenCode's own
  resume flow handles it the next time it starts. See
  `plan.md` "Phase 4 scope" for the reasoning.
- **Cross-runtime adoption** — closed by user direction (2026-07-29):
  - **VS Code:** out. Windows is out of scope; cross-platform VS Code would need a separate design.
  - **Electron:** out. Backend starts in-process; no Unix-socket guardian attach point.
  - **Mobile (Capacitor):** nothing to do. Mobile is a client over HTTP/relay; works as long as the server works.
  - **Hosted mobile:** out.
- **systemd / launchd unit generation** — left as operator's
  responsibility (out of OpenChamber's contract).
- **UI client persistence** (open tabs, draft messages, scroll
  position across page reload) — `packages/ui` task, unrelated to
  the server-restart handoff scope of #2421; not on our roadmap.

**#2421 ends with Phase 2C.** No Phase 4 work.

## Risk register

| Risk | Mitigation |
|---|---|
| Autostart races with another `openchamber serve` invocation. | Reuse the entrypoint's existing `enforceSingleton()` (PID-file `O_EXCL`) so a second invocation exits 1 cleanly without affecting the running guardian. |
| Auto-stop on shutdown hangs. | `stopGuardianViaIpc({ timeoutMs: 3000 })`; on timeout, log a warning and continue (do not block process exit). |
| Operator has a manually started guardian; we accidentally stop it. | `guardianAutoStarted` flag gates D4 — we only stop what we started. |
| Windows users hit a confusing crash. | CLI-layer `assertPlatformSupported` (D6) returns a friendly `TunnelCliError` with usage-level exit code, well before the entrypoint's bare stderr. |
| `bun run dead-code` reports a stale ref. | Review each report; delete only confirmed dead, never remove freshly added files. |
| New script becomes a CI-only flake on macOS. | `uname -s` short-circuit at the top of `scripts/guardian-smoke-test.sh` (D5) — exits 0 on non-Linux. |
