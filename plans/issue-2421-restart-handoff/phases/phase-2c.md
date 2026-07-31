# Phase 2C — Guardian Launch Wiring

## Scope (from inline PR-body steps 1–6)

1. Register `openchamber-guardian` in `packages/web/package.json#bin`.
2. Add `openchamber guardian {start | stop | status | reload}` subcommand
   (new `commands-guardian.js`) that wraps the entrypoint.
3. In `serveCommand()` (foreground + daemon paths), auto-start the guardian
   before `startWebUiServer` if no singleton is detected; reuse the
   `O_EXCL` PID file so we never run two. Add an opt-out
   (`OPENCHAMBER_GUARDIAN_AUTOSTART=disabled` or `--no-guardian`).
4. On graceful shutdown (`SIGTERM`/`SIGINT`), stop only the current
   owner-scoped OpenCode child. The guardian service outlives the web server;
   restart/update requests explicitly detach and `openchamber guardian stop`
   is the administrative service shutdown.
5. End-to-end smoke tests on Linux and Windows authenticate IPC, launch a
   real managed child, verify owner-scoped health/stop behavior, and confirm
   guardian shutdown; scripts under `scripts/` are hard-gated in both CI jobs.
6. `openchamber-guardian` uses a POSIX Unix socket or Windows loopback TCP
   discovery file, with the same authenticated JSON-line protocol and owner
   checks on both platforms.

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

### D3. Auto-start inside `serveCommand` (foreground + daemon), gated by opt-out

- **Decision:** In `commands-serve.js`, **before** `startWebUiServer`
  (or before spawning the daemon child), call
  `maybeAutoStartGuardian({ logFd, options, emitNotice })`:
  - Skip if `options.guardian === false` (i.e. `--no-guardian`).
  - Skip if `options.handoff === false` (the user has already opted
    out of the entire guardian branch; no point starting it).
  - Skip if `process.env.OPENCHAMBER_GUARDIAN_AUTOSTART === 'disabled'`.
  - Probe via the platform-specific `isGuardianRunning(socketPath, portPath)`. If true,
    log `guardian already running (pid N)` and continue.
   - Otherwise, call `startGuardianDetached({ logFd, env: extraEnv })`
     which `spawn`s `bin/openchamber-guardian.js` with
     `detached: true, stdio: 'ignore'` (writes to a `guardian.log`
     next to the server log), `unref()`s it, and waits for the
     platform-specific IPC readiness probe with a bounded timeout before
     `serve` continues. A timeout, spawn failure, or ambiguous race fails
     closed rather than allowing a legacy OpenCode launch beside an unready
     guardian. The spawned `pid` plus the PID file path remain available for
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

### D4. Graceful shutdown → owner-scoped child stop or restart detach

- **Decision:** `commands-serve.js` does not automatically shut down the
  guardian service. `shutdown-runtime.js` closes the current guardian-managed
  child with its owner identity for ordinary stop, but never kills an
  arbitrary listener on that port. Restart/update requests send
  `{ preserveGuardian: true, restart: true }` to `/api/system/shutdown`; the
  server detaches from the child and the CLI reuses the persisted owner ID for
  the successor web server. `openchamber guardian stop` is the explicit
  administrative operation that stops the guardian service.
 - **Why:**
  - Guardian ownership is a durable service boundary, not a child of the
    web-server process. Keeping it alive is what permits restart adoption.
  - Owner-scoped child stop prevents one OpenChamber instance from stopping
    another instance's child; administrative guardian stop remains explicit.
  - Restart intent is carried through the existing authenticated HTTP route,
    so CLI and UI-triggered lifecycle requests share the same behavior.
- **Rejected:**
  - "Track the spawned guardian's pid and SIGTERM it directly."
    Skips the protocol-correct shutdown (no SQL cleanup, no
    child SIGTERM with timeout). The guardian already implements
    graceful shutdown over IPC — bypassing it is a downgrade.
  - "Stop the guardian during every web-server shutdown." This breaks restart
    adoption and can terminate a guardian owned by another OpenChamber
    instance; administrative service shutdown remains an explicit command.

### D5. End-to-end Linux and Windows smoke tests

- **Decision:** Add the two platform scripts plus a shared client:
  1. `scripts/guardian-smoke-test.sh` — boots a real guardian via
     `node packages/web/bin/openchamber-guardian.js` against a temp
     `data-dir`, rejects unauthenticated and replayed requests, launches the
     real managed-child fixture, checks owner-scoped health/stop, sends
     `shutdown`, and prints "ok".
   2. `scripts/guardian-smoke-test.ps1` — the same authenticated Windows
      loopback-TCP/ACL flow, hard-gated by the Windows workflow.
   3. `scripts/guardian-smoke-client.js` and
      `scripts/guardian-test-opencode.js` — shared authenticated client and
      real managed-child fixture used by both platform scripts.
   4. `packages/web/server/lib/guardian/launch-wiring.test.js` — a
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
  - **The smoke clients prove end-to-end runtime correctness** — real guardian
     binaries, real platform transports, a real managed child, process
     termination, and authenticated negative paths. Focused vitests cannot
     claim all of that.
  - **The vitest proves the CLI surface parity** in all four
    modes (TTY / `--quiet` / `--json` / non-TTY) without depending
    on `uname` / a real process group, so it runs in CI on every
    platform (the spawn parts skip on non-Linux).
   - **A shared Node smoke client avoids duplicated protocol code.** It is
     invoked by both platform scripts under the real runtime and keeps the
     negative authentication checks identical.
- **Rejected:**
  - "Pure shell script with no vitest integration." CI would have
    no per-PR signal; the only way to verify would be a manual run.
  - "Only a vitest with a mocked child_process." Misses the
    end-to-end runtime check the user asked for explicitly in
    inline step 5.

### D6. Windows transport and lifecycle support

- **Decision:** Windows uses loopback TCP and an ACL-protected discovery file;
  the guardian and clients perform a challenge/response handshake and MAC
  every ordered request with a replay-protected sequence number.
- **Why:** The durable owner/launch contract must remain identical across the
  supported web platforms. Only transport, ACL, and process-termination
  primitives vary.

## Concrete file-level change list

| File | Change |
|---|---|
| `packages/web/package.json` | Add `"openchamber-guardian": "./bin/openchamber-guardian.js"` to `bin` (D1). |
| `packages/web/bin/lib/commands-guardian.js` (new) | `guardianCommand(options, action)` with `status/start/stop/reload`, plus exported `startGuardianDetached({ logFd, env })`, `stopGuardianViaIpc({ timeoutMs })`, `maybeAutoStartGuardian(...)`, `getGuardianStatus()`. `cli-output.js` parity in all four modes and shared platform path resolution. |
| `packages/web/bin/lib/commands-serve.js` | Import the guardian autostart helper. Foreground + daemon both call `maybeAutoStartGuardian(...)`; shutdown leaves the guardian service running and preserves owner-scoped lifecycle semantics. |
| `packages/web/bin/lib/cli-args.js` | Add `guardianAction = (positional[1] || 'status')` next to `startupAction`. Add `case 'guardian'` / `case 'no-guardian'`. Add `--guardian` / `--no-guardian` to `showHelp()`. Add `guardian` to `knownCommands` in `cli.js`. Add `openchamber guardian` help section. |
| `packages/web/bin/cli.js` | Import `guardianCommand`; add `guardian: guardianCommand` to `commands` map; add `if (command === 'guardian') await commands.guardian(options, guardianAction); return;` next to the existing `startup` / `schedule` dispatch blocks; add `'guardian'` to `knownCommands` list. |
| `packages/web/bin/openchamber-guardian.js` | Cross-platform standalone entrypoint; initializes the shared private root before the PID singleton, then starts the authenticated POSIX or Windows transport. |
| `scripts/guardian-smoke-test.sh` / `scripts/guardian-smoke-test.ps1` | Authenticated Linux and Windows end-to-end smoke tests. |
| `packages/web/server/lib/guardian/launch-wiring.test.js` (new) | Vitest covering CLI parity + spawn/IPC helpers on both platform branches. |
| `packages/web/server/lib/opencode/DOCUMENTATION.md` | Add a new "Phase 2C — Launch wiring" section documenting CLI surface, `--guardian` / `--no-guardian` / `OPENCHAMBER_GUARDIAN_AUTOSTART`, autostart in `serve`, shutdown sequencing, and Windows behavior. |
| `scripts/guardian-smoke-client.js` / `scripts/guardian-test-opencode.js` | Shared authenticated smoke client and real managed-child fixture used by Linux and Windows. |
| `.github/workflows/guardian-linux-baseline.yml` / `.github/workflows/guardian-windows-baseline.yml` | Hard-gated real-platform lifecycle smoke and package checks. |
| `plans/issue-2421-restart-handoff/phases/phase-2c.md` | This plan. |

## Validation plan (no commit / push this turn)

After implementation, run (in order):

1. `node --check` on every new and changed `.js` file.
2. `npx vitest run packages/web/server/lib/guardian/launch-wiring.test.js`.
3. `npx vitest run packages/web/server/lib/guardian/` (regression).
4. `npx vitest run packages/web/server/lib/opencode/lifecycle-guardian-integration.test.js` (regression).
5. `npx vitest run packages/web` (full web regression).
6. `bun run type-check:web` (must be clean).
7. `bun run lint:web` (must be clean).
8. `bun run docs:validate` (must be clean).
9. `bash scripts/guardian-smoke-test.sh` on Linux and the PowerShell smoke script on Windows (both print "ok" on success).
10. `npx vitest run packages/web/server/lib/guardian/windows-smoke-script.test.js` (PowerShell script contract).
11. `bun run dead-code` (inspect report — non-blocking but must be reviewed).

## Out of scope (closed)

- **OpenCode-side session resume** is not in OpenChamber's scope.
  OpenCode already provides durable session history via
  `SessionContextEpoch` + `SessionHistory` + `SessionCompaction`
  (SQLite event log). OpenChamber does not automatically continue a
  post-crash generation or reconstruct an in-flight turn. It adopts a live,
  identity-verified guardian child when present; normal startup may create a
  fresh child when none remains, but that is not continuation of the lost
  generation. Dead/ambiguous records remain an attention condition. See
  `plan.md` "Phase 4 scope" for the reasoning.
- **Cross-runtime adoption** — closed by user direction (2026-07-29):
   - **VS Code:** out. Cross-platform VS Code would need a separate design and runtime bridge.
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
| Restart or stop affects the wrong child. | Persist `OPENCHAMBER_GUARDIAN_OWNER_ID`, require exact owner/runtime matching, and never fall back after uncertain cleanup. |
| Web shutdown accidentally kills a foreign listener. | Owner-scoped guardian stop; never use the port-kill fallback for guardian-managed children. |
| Windows transport exposes an unauthenticated or stale endpoint. | ACL the discovery file before publication, bind loopback only, require challenge/MAC authentication, and remove stale discovery files before atomic replacement. |
| `bun run dead-code` reports a stale ref. | Review each report; delete only confirmed dead, never remove freshly added files. |
| Smoke script runs on the wrong platform. | The Bash and PowerShell scripts are paired with explicit hard-gated Linux and Windows workflows; Bash remains a no-op outside Linux. |
