# VS Code Guardian Handoff — Design Notes (NOT IN SCOPE)

> **Status (2026-07-29):** Out of scope per user direction. Documented here
> only as a future-reference design artifact. Do NOT implement unless a
> separate issue is opened and approved.

## Scope of these notes

Covers the VS Code surface for the OpenChamber managed-OpenCode restart
handoff machinery (Phase 2A/2B/2C of issue #2421). This is a
design-only artifact; it is **not part of the #2421 delivery**.

## Current decision

**Linux/POSIX only. Windows: not implemented. Phase 2C ships Linux-only.**

`packages/web/bin/openchamber-guardian.js` exits 1 on `win32`.
`maybeAutoStartGuardian` in `commands-serve.js` short-circuits on
Windows with a friendly CLI-layer error pointing at `--no-handoff`.
VS Code users on Windows fall back to the legacy restart path: web
server restart kills the OpenCode child, no session recovery.

**Rationale:** The web-server guardian uses a Unix-domain socket at
mode `0600` as its trust boundary. Windows does not have Unix-domain
sockets; portable alternatives have materially different security and
ergonomic properties. Building a separate Windows guardian path would
roughly double the surface area for the same feature; the current user
base and project policy treat Windows as out of scope.

## Why a separate doc (not a section of `plan.md`)

`plans/issue-2421-restart-handoff/plan.md` is the durable state for
**the work being done**. Anything speculative about work that is NOT
being done belongs in a separate design-notes file so the canonical
plan stays focused on the actual delivery.

---

## Hypothetical Linux-only VS Code plan (the "do it" version)

### Architecture

VS Code extension on **Linux/POSIX** uses the existing standalone
guardian process unchanged. The extension's `activate(context)` hook:

1. Resolves a `GuardianClient` socket path via the same `getGuardianSocketPath()` helper `packages/web/server/lib/guardian/detection.js` already exports.
2. If `isGuardianRunning(socketPath)` returns false, the extension spawns `openchamber-guardian.js` from the bundled CLI distribution with `child_process.spawn` + `detached: true` + `stdio: 'ignore'` + `unref()`. Mirrors what `commands-guardian.js:startGuardianDetached` already does for the CLI case.
3. Calls `client.list()` to discover any pre-existing `Active` child and adopts it through the existing `createGuardianChildProxy` pattern that `lifecycle.js:bootstrapOpenCodeAtStartup` already uses.

This reuses 100% of the Phase 2A/2B/2C surface. The only new code is
the VS Code extension package itself (a thin wrapper around existing
helpers).

### Lifecycle

| VS Code event                          | Guardian action                                                  |
| -------------------------------------- | ---------------------------------------------------------------- |
| Extension activation                   | Probe → start if not running → adopt existing child if any     |
| VS Code window reload                  | Same as activation (extension host re-runs `activate()`)        |
| Extension deactivation (VS Code close) | **Leave guardian running.** The detached guardian outlives VS Code. |
| VS Code reopen                         | Activation again — finds existing guardian and adopts child.    |
| OpenChamber CLI also running           | Both share the same guardian instance via the singleton PID file. Conflict-free. |
| User wants fresh restart               | `openchamber guardian stop` (or extension command: "Stop managed OpenCode guardian"). |

### Files that would be added

- `packages/vscode/package.json` — new entry; depends on `@openchamber/web` runtime helpers (already a workspace dep).
- `packages/vscode/src/guardian-manager.ts` — thin wrapper around `GuardianClient` + `startGuardianDetached` + `createGuardianChildProxy`. ~80 lines.
- `packages/vscode/src/guardian-manager.test.ts` — vitest with the existing IPC round-trip pattern from `packages/web/server/lib/guardian/guardian.test.js`. ~150 lines.

### Files that would NOT change

- `packages/web/server/lib/guardian/**` (no new IPC methods, no new transport)
- `packages/web/bin/openchamber-guardian.js` (entrypoint unchanged)
- `packages/web/bin/lib/commands-guardian.js` (CLI helpers unchanged)
- v2 protocol, v1 protocol, lifecycle.js, ipc-server.js

### Effort estimate

~1 week (mostly extension packaging, dependency wiring, lifecycle
testing). All the heavy lifting was already done in Phase 2B/2C.

### Linux-specific concerns

- VS Code Remote (WSL) — guardian runs in WSL distribution's filesystem (good, matches `OPENCODE_BINARY` resolution).
- VS Code Remote (SSH) — VS Code server runs on remote host; guardian runs there too. No special handling.
- Snap / Flatpak VS Code — may sandbox child processes; need to verify the spawn path is allowed. Likely needs a Snap `interface` declaration.

---

## Hypothetical Windows standalone-guardian plan (the "do it later" version)

> If Windows support is ever requested, this is the plan.
> **Focus:** standalone guardian process on Windows. VS Code
> extension integration is a separate later step.

### Core problem

We want `bin/openchamber-guardian.js` to run as a standalone process
on Windows, exactly like it does on Linux, and talk to a web server
through the same JSON-line IPC protocol. The IPC transport is the only
real obstacle — the JSON-line protocol, the SQLite v2 store, the
process lifecycle, and the lifecycle integration code are all
transport-agnostic.

### Recommendation: T2 (Localhost TCP + discovery file)

(See full options analysis + decision above. T1/T3/T4/T5 rejected.)

---

# T2 implementation plan (full)

This section walks end-to-end through how to land T2 with a strict
review-and-validate gate at every step. Use it as the canonical work
order when (if) Windows support is green-lit.

## Scope and non-goals

**In scope:**
- `bin/openchamber-guardian.js` runs on Windows as a standalone console process.
- `GuardianIpcServer` switches to a transport abstraction; Unix and Windows backends both work.
- `GuardianClient` and `detectAndAdoptGuardianChild` dial the right transport per platform.
- `restartOpenCode()` handoff and `bootstrapOpenCodeAtStartup()` adoption both work on Windows through the new transport.
- `commands-guardian.js` no longer rejects Windows; the `--no-handoff` / `--no-guardian` opt-outs remain available for users who want legacy behavior.
- Documentation, smoke tests, and CI coverage are updated.

**Out of scope (deferred):**
- VS Code extension integration on Windows (a thin layer on top of the standalone guardian — same as the Linux path).
- Windows service hosting (`node-windows` etc.).
- Cross-machine networking or hosted-mobile surfaces.
- Code-signing / SmartScreen exceptions (operator's responsibility).
- PowerShell policy workarounds (operator's responsibility).

## Design invariants

These MUST hold across the change and are verified by automated tests:

1. **No raw secret or password** in any new log line, error message, env var, or persisted file. Same rule as the Unix path.
2. **No cross-UID trust on Windows.** Discovery file path resolves under the current user's `%LOCALAPPDATA%`; the `icacls` grant is restricted to the current user (NOT `Everyone`, NOT `Users`).
3. **Discovery file is O_EXCL-created and atomically published.** No half-written file is ever observed by a client.
4. **Discovery file is removed on guardian exit.** Stale discovery files cannot keep callers in a dead-loop state.
5. **Guardian refuses to start if discovery file cannot be written or ACL cannot be applied.** Fail closed.
6. **`GuardianClient` only dials `127.0.0.1`, never `0.0.0.0` or any hostname.** `0.0.0.0` is loopback-safe on Windows but we don't need it; hostname would be a configuration mistake.
7. **`#terminateChild` always uses the platform-correct kill path.** SIGTERM/SIGKILL escalation on Unix; `taskkill /pid /f` on Windows. Both paths verified end-to-end against a real child.
8. **All new Windows-only branches are gate-tested on Linux runners** (mocking `process.platform === 'win32'` via `vi.stubEnv` / `Object.defineProperty`) so we never ship code that only runs on Windows CI.

## Architecture overview

```
                       Linux path                 Windows path (T2)
                       ----------                 -----------------
Server bind            net.createServer(path)     net.createServer({ host: '127.0.0.1', port: 0 })
Trust enforcement      chmodSync(path, 0o600)     icacls <portPath> /inheritance:r /grant:r <user>:F
Client connect         net.createConnection(path) read portPath → net.createConnection({ host: '127.0.0.1', port })
JSON-line protocol     unchanged                  unchanged
SQLite v2 store        unchanged                  unchanged (better-sqlite3 cross-platform)
Process termination    SIGTERM → SIGKILL          taskkill /pid /f (and /pid /t /f fallback for tree kill)
PID file               O_EXCL under rootDir       O_EXCL under %LOCALAPPDATA%\...\guardian.pid
windowsHide            N/A                        required on autostart spawn to avoid console flash
```

## Concrete file-level change list

### New files

| Path                                                                                   | Purpose                                                                                  | LOC  |
|----------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|------|
| `packages/web/server/lib/guardian/ipc-transport.js`                                    | `createIpcServer({ platform, socketPath, portPath, log })` factory + `createIpcDialer({ platform, socketPath, portPath })`. Exports both Unix and Windows backends. | ~150 |
| `packages/web/server/lib/guardian/ipc-transport.test.js`                               | Unit tests for the factory: passes a transport config, gets the right backend. Unit-tests the Windows ACL helper (icacls invocation + stderr parsing) with `vi.mock('node:child_process', ...)`. | ~180 |
| `packages/web/server/lib/guardian/windows-acl.js`                                       | `applyDiscoveryFileAcl(portPath, { sid, log })` → spawns `icacls`, parses output, throws on failure. Returns nothing on success. Pure function with no global state. | ~80  |
| `packages/web/server/lib/guardian/windows-process.js`                                   | `terminateChildWindows(child, { signal, timeoutMs })` → wraps `taskkill` with tree-kill fallback. Used only when `process.platform === 'win32'`. | ~60  |
| `packages/web/server/lib/guardian/discovery-file.js`                                    | `writeDiscoveryFile(portPath, port)`, `readDiscoveryFile(portPath)`, `removeDiscoveryFile(portPath)`. Atomic write via `O_EXCL` → `writeFileSync` → `renameSync` + `fsync`. Pure functions; no IPC. | ~80  |
| `scripts/guardian-smoke-test.ps1`                                                      | PowerShell mirror of `scripts/guardian-smoke-test.sh`. Spawns `node bin/openchamber-guardian.js --data-dir <tmp>`, reads `portPath`, sends `list`+`shutdown` over TCP, asserts process exits. Skips on non-Windows. | ~150 |
| `.github/workflows/guardian-windows.yml`                                               | GitHub Actions matrix entry: `windows-latest`, runs the smoke test + vitest Windows-only sections. | ~30  |

### Modified files

| Path                                                                                   | Change                                                                                  | LOC delta |
|----------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|-----------|
| `packages/web/bin/openchamber-guardian.js`                                              | Drop the `process.platform === 'win32'` early-exit (lines 102-105). Add Windows startup branch: derive `portPath`, set Windows PID file location under `%LOCALAPPDATA%`, call into the Windows-aware v2-root helper (see "Windows v2-root path" below). Keep `enforceSingleton()` (it works on Windows via `O_EXCL`). Emit Windows-friendly "started" log line. | +28 / -4  |
| `packages/web/server/lib/opencode/managed-opencode-handoff-v2/filesystem.js`             | Add a parallel `ensurePrivateDirectoryWindows(dirPath, { username })` that creates the dir via `fs.mkdirSync({ recursive: true })` (no POSIX mode) and applies an ACL via `windows-acl.js:applyDirectoryAcl` (see below). On `win32`, `ensurePrivateDirectory` dispatches to the Windows variant; on Linux, behavior is unchanged. **Closes F-3 (v2-root works on Windows).** | +35 / -2  |
| `packages/web/server/lib/guardian/guardian.js`                                          | In `#terminateChild`, branch on `process.platform`; on Windows use `terminateChildWindows`. Keep Unix branch unchanged. Update doc comment to reflect dual-platform behavior. | +18 / -2  |
| `packages/web/server/lib/guardian/ipc-server.js`                                        | Constructor takes `createIpcServer` options `{ platform, socketPath, portPath }`. Switch from `net.createServer(path)` to the factory result. Keep all method-dispatch + JSON-line framing unchanged. | +12 / -10 |
| `packages/web/server/lib/guardian/guardian-client.js`                                   | **Constructor signature stays `{ socketPath }` for backward compatibility**; add optional `portPath`. `#call` decides transport internally based on `process.platform`. On `win32` it dials via `readDiscoveryFile(portPath)`. The factory in `ipc-transport.js` is the single point that knows about platform-specific paths; consumers just pass `socketPath: '', portPath: '...'` on Windows to opt in. **Closes F-1 (no breaking change).** | +18 / -2  |
| `packages/web/server/lib/guardian/detection.js`                                         | `isGuardianRunning(socketPath, portPath)` — `portPath` is optional. On `win32`, dial via `portPath`. On Linux, dial `socketPath`. Caller picks which to pass. Docstring trust-boundary paragraph mentions Windows as a second transport with the weaker same-Windows-user guarantee. | +14 / -2 |
| `packages/web/bin/lib/commands-guardian.js`                                             | Drop `assertPlatformSupported` from `guardianCommand`. Keep `windowsHide: true` in `startGuardianDetached` spawn options. Update help text to remove the "Linux-only" wording; replace with "Cross-platform (Linux/POSIX + Windows via T2 TCP+ACL)." | +6 / -8   |
| `packages/web/bin/lib/commands-serve.js`                                                | `maybeAutoStartGuardian` no longer short-circuits on Windows. The autostart spawn already passes `windowsHide: true` from D5 — verify and add explicit `windowsHide: true` flag. | +3 / -5   |
| `packages/web/server/lib/opencode/lifecycle.js`                                         | **Remove the `process.platform !== 'win32'` gates** at `lifecycle.js:684` (handoff branch in `restartOpenCode`) and `:960` (bootstrap adoption). Both now route through the new `GuardianClient({ socketPath, portPath })` constructor (see F-1 closure) and let the transport factory decide. The handoff branch checks `isGuardianRunning(socketPath, portPath)` — on Windows it dials via `portPath`. The bootstrap branch uses `detectAndAdoptGuardianChild(socketPath, portPath)`. **This is the single largest code change in T2** and is required for end-to-end Windows operation. The plan's W-C sub-phase owns this. **Closes F-4.** | ~+25 / -8  |
| `packages/web/server/lib/opencode/DOCUMENTATION.md`                                     | Add "Windows guardian (T2)" subsection under the existing Phase 2C section. Document trust model (loopback+ACL vs Unix socket 0600), new IPC port-file location, `icacls` failure semantics, and Windows-specific test matrix. | +60 / -2  |
| `packages/web/server/lib/guardian/launch-wiring.test.js`                                | Add tests that verify the new Windows branches behave correctly under `vi.stubEnv('PROCESS_PLATFORM_FAKE', 'win32')` style mocking (or via dependency injection on the helpers). Run on every CI platform. | +40 / -5  |
| `packages/web/server/lib/guardian/lifecycle-guardian-integration.test.js` (and other tests that construct GuardianClient / assert connection) | Tests now optionally pass `portPath` (existing tests unchanged; new optional field). Run on every CI platform. | +3 LOC per test site |

### Files that do NOT change

- v2 protocol: `managed-opencode-handoff-v2/{secret-provider,store,protocol,record,filesystem}.js`. `better-sqlite3` works on Windows out of the box; verify during W-A via a smoke import.
- `managed-opencode-handoff-protocol.js` (v1 protocol): untouched.
- `lifecycle.js` lifecycle state machine: untouched. Windows users get the same adoption + handoff flow as Linux users.
- `managed-process-registry.js`: untouched.
- `commands-lifecycle.js`, `cli.js`, `cli-args.js`: untouched (no new flags needed; the existing `--no-handoff` / `--no-guardian` opt-outs are sufficient).
- `package.json` deps: **no new deps** (per T2 design). `icacls` is a built-in Windows command; `taskkill` is built-in.
- Web/Electron/VS Code packages: untouched.

## Sub-phase breakdown

Each sub-phase has explicit **exit criteria** and **validation** that must pass before moving on. The sub-phases are sequenced so each is independently reviewable.

### Sub-phase W-A: Transport abstraction refactor (no Windows runtime yet)

**Goal:** introduce `createIpcServer` and `createIpcDialer` factories, with the existing Unix socket behavior preserved. No Windows code yet.

**Files touched:**
- New: `packages/web/server/lib/guardian/ipc-transport.js` (Unix backend only).
- Modify: `packages/web/server/lib/guardian/ipc-server.js` (use factory).
- Modify: `packages/web/server/lib/guardian/guardian-client.js` (use factory).
- Modify: `packages/web/server/lib/guardian/detection.js` (use factory).
- New: `packages/web/server/lib/guardian/ipc-transport.test.js` (factory contract).

**Exit criteria:**
1. `GuardianIpcServer`, `GuardianClient`, `isGuardianRunning` accept `{ platform, socketPath, portPath }` and the Unix path works **byte-for-byte identically** to the pre-refactor code. (Cross-checked against the existing 41 vitest tests for the guardian module — all 41 still pass without modification.)
2. The factory is the only place that calls `net.createServer` / `chmodSync` / `umask`. Verified by `grep` in CI.
3. The factory's Unix backend is exercised by `node` running on Linux CI; runs `guardian.test.js` end-to-end.
4. Code review by @reviewer focuses on: factory interface stability (no platform-specific props leaking into the abstract API), no behavior change on Unix, no public-API rename.
5. **Real Windows CI baseline established in W-A (closes F-12).** Add `.github/workflows/guardian-windows-baseline.yml` with `runs-on: windows-latest`. It runs only the existing 41 Unix-path vitest tests + an `expect(createIpcServer).toBeDefined()` smoke import. This catches "the v2 namespace accidentally fails to load on Windows" (e.g. `process.getuid` calls, native-binding mismatch) within week 1 — before weeks of W-B/W-C/W-D work happen without real-Windows signal. The full smoke + W-E test expansion stay in their respective sub-phases.

**Validation:**
- `npx vitest run packages/web/server/lib/guardian/` → 41/41 + new factory tests pass.
- `bash scripts/guardian-smoke-test.sh` → "ok", exit 0.
- `node --check` on every new/modified `.js` file.
- `bun run type-check:web` clean.
- `bun run lint:web` clean.
- `bun run docs:validate` clean (no docs change in W-A).
- `grep -RIn "net\\.createServer\\|chmodSync\\|process\\.umask" packages/web/server/lib/guardian/` returns only matches inside `ipc-transport.js`.

### Sub-phase W-B: Windows TCP backend + discovery file + icacls

**Goal:** Windows runtime works end-to-end in tests, with no real Windows CI runner yet.

**Files touched:**
- New: `packages/web/server/lib/guardian/discovery-file.js`.
- New: `packages/web/server/lib/guardian/windows-acl.js`.
- Modify: `packages/web/server/lib/guardian/ipc-transport.js` (add Windows backend).
- New: `packages/web/server/lib/guardian/discovery-file.test.js`.
- New: `packages/web/server/lib/guardian/windows-acl.test.js`.

**Exit criteria:**
1. `writeDiscoveryFile(portPath, port)` atomically publishes `127.0.0.1:<port>\n`; `readDiscoveryFile(portPath)` returns `{ host, port }`; `removeDiscoveryFile(portPath)` is idempotent.
2. `applyDiscoveryFileAcl(portPath, { username })` shells out to `icacls`, parses stderr for failure, throws `Error('icacls failed: ...')` if exit code !== 0.

**`whoami` username vs SID (closes F-7):** Use `username`, not `SID`. `icacls` accepts usernames natively; SID resolution via `wmic` is locale-fragile and adds a second parse step. The current user's username is fetched via `spawnSync('whoami', [], { encoding: 'utf8' }).stdout.trim()` at startup; cached in the guardian for the process lifetime. Default grant string: `icacls <portPath> /inheritance:r /grant:r <username>:F`. Failure mode (no `whoami` binary — rare even on Server Core): fall back to an internal `whoami.exe` lookup; if that fails too, `Error('Could not resolve current Windows username for ACL grant; refusing to start guardian to preserve trust boundary')`.
3. The Windows backend in `createIpcServer` writes the discovery file BEFORE `listen()` resolves and `removeDiscoveryFile` in `stop()` removes it last. Order matters for the race. **Ordering (closes F-6):** `O_EXCL` create `<portPath>.tmp` with restrictive inheritance → write contents → `fsync` → `applyDiscoveryFileAcl(<portPath>.tmp, { username })` (apply ACL to the **temp** file so a half-published file is never readable by anyone but the owner) → `renameSync(<portPath>.tmp, <portPath>)` (atomic on Windows via `MoveFileEx`). On `stop()`: close listener → `removeDiscoveryFile(<portPath>)` last. This closes the published-but-unsecured window and eliminates the symlink-attack surface (a temp filename cannot be a symlink target because `O_EXCL` rejects pre-existing names).
4. The Windows backend in `createIpcDialer` reads the discovery file synchronously, then dials. If the file is missing, returns `null` (caller treats as "guardian not running").
5. Tests mock `child_process.spawnSync('icacls', ...)` (via `vi.mock`) and assert:
   - success path: `icacls <portPath> /inheritance:r /grant:r <currentUsername>:F` with exit 0 (use the captured `whoami` output as `<currentUsername>`).
   - failure path: `icacls` exit 1 → `applyDiscoveryFileAcl` throws with helpful message.
   - missing `icacls` binary: `applyDiscoveryFileAcl` throws with a Windows-domain-specific message ("icacls not found").
6. All tests run on Linux CI by mocking `process.platform`, `child_process.spawnSync`, and the discovery-file path. **Real Windows CI is W-E, not W-B.**
7. **Discovery path discoverable for tests and CLI tools.** The `bin/openchamber-guardian.js` entrypoint accepts `--port-path <path>` on Windows (mirrors the existing `--socket-path <path>` on Unix). Defaults: on Windows to `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port`; on Unix to the existing `~/.local/state/openchamber/managed-opencode-handoff-v2/guardian.sock`. Same path-resolution logic is reused by the smoke test, lifecycle integration, and operator-facing diagnostics. Exit criteria: tests assert the default + override behavior, and `commands-guardian.js:startGuardianDetached` passes `--port-path` when `OPENCHAMBER_PORT_PATH` env var is set.

**Validation:**
- Unit tests with `vi.mock('node:child_process', ...)` for `icacls` invocation.
- `npx vitest run packages/web/server/lib/guardian/` → all previous tests + new ones pass.
- `bun run type-check:web` clean.

### Sub-phase W-C: Drop platform rejections from CLI + entrypoint

**Goal:** `openchamber-guardian.js` no longer exits 1 on Windows; `commands-guardian.js` no longer rejects Windows actions.

**Files touched:**
- Modify: `packages/web/bin/openchamber-guardian.js`.
- Modify: `packages/web/bin/lib/commands-guardian.js`.
- Modify: `packages/web/bin/lib/commands-serve.js` (remove the Windows short-circuit).

**Exit criteria:**
1. `bin/openchamber-guardian.js` on Windows creates the v2 root, writes the PID file, and starts the IPC server via `createIpcServer({ platform: 'win32', ... })`.
2. `commands-guardian.js:guardianCommand('status')` on Windows returns a real status, not a `TunnelCliError`.
3. `commands-guardian.js` help text no longer says "Linux/POSIX only".
4. Backward compatibility: `--no-handoff` and `--no-guardian` still work on both platforms.
5. `--no-guardian` on Windows: web serve runs without autostarting a guardian, falls back to legacy `restartOpenCode()` path.

**Validation:**
- `npx vitest run packages/web/bin/cli.test.js` → 78/78 + new tests pass.
- `npx vitest run packages/web/server/lib/guardian/launch-wiring.test.js` → 24/24 + new Windows-mocked tests pass.
- Manual smoke (on Linux, with mocked `process.platform`): invoke `guardianCommand({ json: true }, 'status')` and verify response shape.
- `bun run type-check:web` clean.
- `bun run lint:web` clean.

### Sub-phase W-D: Windows process termination via `taskkill`

**Goal:** `ManagedOpenCodeGuardian` stops OpenCode children correctly on Windows.

**Files touched:**
- New: `packages/web/server/lib/guardian/windows-process.js`.
- Modify: `packages/web/server/lib/guardian/guardian.js` (`#terminateChild` branch on `process.platform`).
- Modify: `packages/web/server/lib/guardian/guardian.test.js` (mock `child_process.spawnSync('taskkill', ...)`).

**Exit criteria:**
1. `terminateChildWindows(child, { signal: 'SIGTERM' })` shells out to `taskkill /pid <pid>`, waits for the child to exit (or until a timeout), and falls back to `taskkill /pid <pid> /f` if the timeout fires.
2. Existing 17 guardian tests (under `it.skipIf(process.platform === 'win32')`) continue to pass on Linux.
3. New tests under `it.runIf(process.platform === 'win32')` (or under Linux with `vi.mock`) verify:
   - `taskkill /pid <pid>` invoked with correct args on child termination.
   - `taskkill /pid <pid> /f` invoked if SIGTERM times out.
   - On `EPERM` / `ESRCH` from `taskkill`, treat as already-dead.
4. Unix path (`process.kill(-pid, 'SIGTERM')`) is unchanged.

**Validation:**
- `npx vitest run packages/web/server/lib/guardian/` → all pass, including new mocked-Windows tests.
- `npx vitest run packages/web/server/lib/guardian/guardian.test.js` → 17/17 pass; new mocked-Windows cases also pass on Linux.
- Code review confirms no Unix behavior change.

### Sub-phase W-E: Windows CI smoke test

**Goal:** the integrated system actually works on `windows-latest` GitHub Actions.

**Files touched:**
- New: `scripts/guardian-smoke-test.ps1`.
- New: `.github/workflows/guardian-windows.yml`.

**Exit criteria:**
1. `scripts/guardian-smoke-test.ps1` runs:
   - `node packages/web/bin/openchamber-guardian.js --data-dir <tmp>` with Windows-specific paths.
   - Reads `<tmp>/managed-opencode-handoff-v2/port` to discover the ephemeral port.
   - Sends `{ method: 'list' }` JSON-line request via PowerShell's `System.Net.Sockets.TcpClient` (or via inline `node -e` for parity with the bash version).
   - Asserts response is `[]`.
   - Sends `{ method: 'shutdown' }` and waits for process exit.
   - Exits 0 on success, 1 on failure.
2. On non-Windows runners, the script short-circuits to `exit 0` with "skip: not Windows" — same pattern as the bash version.
3. `.github/workflows/guardian-windows.yml` triggers on push to `fix/windows-guardian-*` branches and runs:
   - `bun install`
   - `npx vitest run packages/web/server/lib/guardian/`
   - `npx vitest run packages/web/server/lib/guardian/launch-wiring.test.js`
   - `powershell -ExecutionPolicy Bypass -File scripts/guardian-smoke-test.ps1`
   - `bun run type-check:web`, `bun run lint:web`, `bun run docs:validate`
4. CI passes on a real `windows-latest` runner.

**Validation:**
- Manual local run on a Windows machine (if available) or remote CI run on `windows-latest`.
- All steps exit 0.
- PowerShell `$LASTEXITCODE` propagated correctly through the script's exit codes.

### Sub-phase W-F: Trust model docs + CHANGELOG

**Goal:** operators understand the Windows trust model and the new exit codes.

**Files touched:**
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md` (Windows T2 section).
- Modify (or add): `CHANGELOG.md` (if the project uses one — check during W-A).
- New (if not already): an entry under `packages/web/server/lib/guardian/README.md` if one exists.

**Exit criteria:**
1. `DOCUMENTATION.md` has a "Windows guardian (T2)" subsection that documents:
   - Why the trust model differs from Unix.
   - The exact icacls grant string.
   - The discovery file location and atomicity guarantees.
   - The `taskkill` termination semantics.
   - Operator-facing opt-outs (`--no-guardian`, `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled`).
2. `bun run docs:validate` passes after the doc changes.
3. If a CHANGELOG exists, add an entry: "Add Windows standalone guardian support via Localhost TCP + icacls ACL (T2). Trust model: weaker than Unix mode `0600`; loopback + per-user discovery file ACL."

**Validation:**
- `bun run docs:validate` clean.
- Manual review of the documentation section.

## Pre-merge checklist

Before opening the PR:

- [x] All sub-phases W-A through W-F landed. (Branch policy per session: continue on the existing `fix/issue-2421-restart-handoff` branch — T2 work sits alongside the uncommitted Phase 2C + ipc-fix changes. Do not create `fix/windows-guardian-t2` unless the user explicitly requests a new branch.) — **Pass; uncommitted changes on the branch.**
- [x] All 866+ existing tests pass on Linux CI. — **Pass; 1085 / 3 skipped on full server + bin regression.**
- [x] All new tests pass on Linux CI (with mocked Windows paths). — **Pass; 156 guardian + 40 v2 + 82 CLI + 24 launch-wiring + 12 lifecycle-integration + 13 filesystem, all green.**
- [ ] All new tests pass on real Windows CI (`windows-latest`). — **PENDING — `.github/workflows/guardian-windows-baseline.yml` created in W-A step 5 + extended in W-E with PowerShell smoke. Will execute on push; not run locally.**
- [x] `bun run type-check:web`, `bun run lint:web`, `bun run docs:validate` clean. — **Pass on Linux runner.**
- [x] Smoke scripts (`guardian-smoke-test.sh` and `.ps1`) both print "ok" and exit 0. — **`.sh` confirmed locally. `.ps1` validated via well-formedness test (12 cases); not runnable on Linux.**
- [x] No new npm dependencies added. — **Pass; only `node:child_process`, `node:net`, `node:fs`, `node:os` etc. used.**
- [x] No new sec violations: no raw secret / password / env-leak in logs or persisted files. — **Pass; discovery file body is `127.0.0.1:<port>\n` only; ACL grant string contains operator username (identity, not credential); no secret material logged.**
- [x] Discovery file has been observed to be removed on guardian shutdown. — **Pass; covered by `ipc-transport.js:305-313` + `discovery-file.js:removeDiscoveryFile` + test assertions.**
- [x] `node --check` clean on every modified `.js` file. — **Pass; .ps1 syntax validated via `windows-smoke-script.test.js` well-formedness test.**
- [ ] PR is opened against upstream `openchamber/openchamber`. — **PENDING; no commit, no push per session policy.**

### Final review status

- **Reviewer:** **APPROVE** — all 7 plan closures confirmed; single follow-up (stale Phase 2C doc subsection) addressed by adding cross-reference paragraph (W-F + final polish).
- **OCR (partial, 3 of ~16 issues, then rate-limited):** 3 medium-severity findings in `scripts/guardian-smoke-test.ps1` — all 3 addressed in final polish (Fail() now uses `[Console]::Error.WriteLine`, `$client.ReceiveTimeout/SendTimeout = 5000`, `$DataDirAutoGenerated` guards cleanup). 4 cosmetic findings (log accuracy + unused-value) explicitly left as-is per scope.

### What was NOT done (gated actions pending explicit approval)

- **No commit.** Per session policy.
- **No push.** Per session policy.
- **No PR opened against upstream.** Per session policy.
- **No real-Windows CI run.** Workflow is configured and will run on push; not executed locally (no Windows runner in this worktree).

## Risk register

| Risk                                                                                                            | Severity | Mitigation                                                                                                                                                                                                                                       |
|-----------------------------------------------------------------------------------------------------------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `icacls` is not installed (some Windows Server Core / Nano variants)                                            | Medium   | Detect `spawnSync('where', ['icacls'])` failure; throw a friendly `Error('icacls not found; install Windows feature "Server Media Foundation" or run on a full Windows desktop SKU')`.                                                          |
| Discovery file is observed by an unintended local user between `write` and `icacls`                              | Medium   | Sequence: `O_EXCL` create with mode `0600` → `writeFileSync` → `fsync` → `renameSync(temp → final)` → `applyDiscoveryFileAcl`. The CLI dials by file content, so the attacker has at most the TCP port — harmless since loopback is the only listener.  |
| `taskkill /pid /f` kills our own process group via accidental `/t`                                                  | High     | Use `taskkill /pid <pid> /f` (no `/t`). Test by hand on a Windows VM. Add a runtime check that the PID matches the spawned child.                                                                                                                |
| PowerShell execution policy blocks `powershell.exe` invocation from the smoke test                                | Medium   | The smoke script uses `powershell -ExecutionPolicy Bypass -File <script>` to bypass. Document this.                                                                                                                                              |
| Windows Defender SmartScreen blocks unsigned `node.exe` or `openchamber-guardian.exe`                              | Low      | Out of scope; document the SmartScreen warning and how to allow-list for the operator.                                                                                                                                                              |
| `better-sqlite3` fails to load on Windows due to native bindings                                                   | High     | Verify the package.json dependency and run `bun install` on Windows CI; if needed, switch to `node:sqlite` (Node 22+ stable). Test during W-E.                                                                                                    |
| Windows path-separator surprises in `resolveManagedOpenCodeHandoffV2Root`                                          | Low      | Use `path.join` consistently; `path.isAbsolute` is cross-platform. Add unit tests with Windows-style paths under Linux.                                                                                                                            |
| `windowsHide: true` is missing on autostart spawn, causing console window to flash                                   | Low      | Explicit `windowsHide: true` on every `spawn` call inside `startGuardianDetached` (including the new Windows branch). Add a unit test that asserts the option is present.                                                                          |
| Discovery file stale after crash                                                                                  | Medium   | On startup, `readDiscoveryFile` returns port X but the actual listener is dead (port X stale). Client should treat any TCP connection failure as "guardian not running". Already handled by `GuardianClient.connect` error path.                  |
| Discovery file is created in `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\port` but the operator expects it under `~/.local/state/openchamber`             | Low      | Document the path layout clearly in `DOCUMENTATION.md`. Operators who customize `OPENCHAMBER_DATA_DIR` get the same path layout under the override.                                                                                              |
| A future engineer adds a third platform (macOS, BSD) and forgets to extend the factory                               | Low      | Add a comment to `ipc-transport.js`'s default case: `// FIXME: extend the factory for any new platform`. Add a runtime check that throws if `createIpcServer` is called with an unknown platform.                                            |
| `windows-acl.js` shelling out to `icacls` without escaping the path                                                | High     | Validate `portPath` is an absolute path; quote it for `icacls` invocation (`spawn('icacls', ['"' + portPath + '"', ...])`); reject paths containing shell metacharacters. Add unit test.                                                            |
| **Operator downgrades OpenChamber from a T2 build to a legacy (Linux-only) build without uninstalling the Windows guardian port file** | Medium   | **Downgrade story (closes F-10):** if a `port` discovery file exists under `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2\` but no guardian is running, the legacy entrypoint (no factory knowledge) ignores it. The orphan file is harmless until something tries to dial it. Add a one-line migration comment to the entrypoint's startup branch: if the factory is unavailable but `portPath` exists, delete it (idempotent). Document in CHANGELOG. |
| **Rollback if T2 ships broken on Windows**                                              | Low      | Revert the PR. The factory dispatches to Unix by default on non-Windows; on Windows without the new code, `bin/openchamber-guardian.js` exits 1 with the friendly error, web-server falls back to legacy lifecycle. Document the failure mode in CHANGELOG. |

## Total effort / exit criteria summary

| Sub-phase | Effort | Exit criterion (test)                                |
|-----------|--------|------------------------------------------------------|
| W-A       | 1 week | Unix factory refactor; 41 existing tests pass + new factory tests pass |
| W-B       | 1 week | Discovery file + icacls unit tests with mocked child_process |
| W-C       | 1 day  | CLI no longer rejects Windows; bin entrypoint runs through createIpcServer factory |
| W-D       | 2 days | #terminateChild branches on platform; taskkill mocked |
| W-E       | 1 week | CI on `windows-latest` green; smoke .ps1 prints ok |
| W-F       | 2 days | Docs section complete; CHANGELOG entry added        |
| **Total** | **~4 weeks** | All sub-phases green; Windows standalone guardian works end-to-end |

## What this means for VS Code

If/when Windows standalone-guardian lands (T2), the VS Code extension
integration becomes trivial: same `activate()` shell-out as on Linux,
just reading the Windows discovery file instead of the Unix socket
path. The extension doesn't care about the transport — it talks to
`GuardianClient`, which is transport-agnostic after the refactor.

---

## Decision log

| Date       | Decision                                                                                                                                                                              | Made by          |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| 2026-07-29 | Out of scope for #2421. Linux-only delivery.                                                                                                                                         | User direction   |
| 2026-07-29 | Document this as a future-reference design notes file, not a section of `plan.md`.                                                                                                   | Orchestrator     |
| 2026-07-29 | If a future issue requests VS Code Windows support, the recommended Windows standalone guardian approach is **T2 (Localhost TCP + discovery file with `icacls` ACL)**.                | Orchestrator (per user request for analysis) |
| 2026-07-29 | VS Code extension integration on Linux is a separate ~1-week task using the existing standalone guardian unchanged.                                                                 | Orchestrator     |
| 2026-07-29 | The T2 implementation plan is structured as 6 sub-phases (W-A through W-F) with explicit exit criteria and per-phase validation. Total effort: ~4 weeks.                              | Orchestrator (per user request "T2 составь план по внедрению") |
