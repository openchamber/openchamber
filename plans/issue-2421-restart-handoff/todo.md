# Issue #2421 Todo

## Phase 1 — V1 Protocol (COMPLETE)
- [x] Isolated v1 protocol + fake-store tests (19 passed).
- [x] No changes to legacy `managed-process-registry.js`.

## Phase 2A — V2 Durable Foundation (COMPLETE)
- [x] Master secret provider, SQLite CAS store, reservation/launch/lease protocol.
- [x] All remediation rounds and third review approved.
- [x] 27 v2 tests pass, type-check, lint, docs, syntax clean.

## Phase 2B — Linux Guardian Process (COMPLETE)
- [x] Design guardian architecture and IPC protocol.
- [x] Implement guardian core module (spawn, stop, health, lease renewal, cleanup).
- [x] Implement IPC server (Unix socket, JSON line protocol) — note: shutdown RPC response-ordering fix landed later in Phase 2C round.
- [x] Implement guardian client (web server side).
- [x] Tests: 17 focused unit tests for guardian core and IPC (after F3 removed 2 dead `adopt` tests).
- [x] Security review: 6 findings identified and remediated.
  - [x] P0/Critical: Fix adopt fingerprint algorithm mismatch (HMAC vs SHA-256) — surfaced by later cleanup.
  - [x] P1/High: Terminate orphaned child processes when spawn fails after creation.
  - [x] P2/Medium: Restrict Unix socket permissions atomically (umask).
  - [x] P2/Medium: Replace PID file with atomic create (O_EXCL).
  - [x] P3/Low: Ensure stopChild deletes from #children even if retire fails.
  - [x] Question: Confirm credential zeroing after withCredential.
- [x] Re-review after remediation: **APPROVED for Phase 3**.

## Phase 3 — Lifecycle Integration (COMPLETE — landed in same PR as 2B)
- [x] `bootstrapOpenCodeAtStartup()` detects and adopts guardian-managed child via `GuardianClient.list()`.
- [x] `restartOpenCode()` handoff branch: prepareHandoff → spawn successor via guardian → wait for ready → stop old child.
- [x] Legacy fallback when guardian is unavailable (Linux only).
- [x] `--handoff` / `--no-handoff` CLI flag → `OPENCHAMBER_RESTART_HANDOFF` env var (default: enabled).
- [x] F2 fix: single `buildManagedOpenCodeSpawnEnv({ rotatePassword })` helper used by both `startOpenCodeOnce` and guardian handoff.
- [x] F3 fix: dead `adopt()` RPC removed; trust boundary documented.
- [x] 11 lifecycle-guardian integration tests pass; 8 lifecycle regression tests pass.
- [x] Full server regression: 842 pass / 2 skip baseline.

## Phase 2C — Launch Wiring (COMPLETE — local, uncommitted)
- [x] `openchamber-guardian` registered in `packages/web/package.json#bin`.
- [x] `openchamber guardian {status|start|stop|reload|help}` subcommand in `commands-guardian.js`, dispatched from `cli.js`, with `--json` / `--quiet` / TTY parity per `clack-cli-patterns`.
- [x] `--guardian` (default) / `--no-guardian` opt-out flag in `cli-args.js`, mirroring the `--handoff` precedent.
- [x] `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled` env opt-out.
- [x] `maybeAutoStartGuardian` called in both foreground and daemon `serve` paths, gated on platform/options/env.
- [x] Foreground `shutdownForegroundServer` calls `stopGuardianViaIpc` (best-effort, 3s timeout) only when `isGuardianAutoStarted()` — never tears down an operator-started guardian.
- [x] SIGTERM → SIGKILL escalation in `stopGuardianViaIpc` if the IPC shutdown path fails.
- [x] `runReloadAction` sends `SIGHUP` to the running guardian PID; the entrypoint already handles SIGHUP by restarting its timers.
- [x] Windows: friendly CLI-layer `TunnelCliError` (with `--no-handoff` hint) + entrypoint still exits 1 on `win32`.
- [x] PID file moved under `managed-opencode-handoff-v2/` root so it honors `--data-dir` / `OPENCHAMBER_DATA_DIR` (H2 fix during review round).
- [x] IPC `shutdown` RPC now sends `{ acknowledged: true }` BEFORE `guardian.stop()` destroys the sockets (`ipc-server.js` one-line protocol fix surfaced by the smoke test).
- [x] Linux-only end-to-end smoke test `scripts/guardian-smoke-test.sh` prints `ok` and exits 0; auto-skips on non-Linux.
- [x] 24 launch-wiring vitest tests pass; 866 server tests pass / 2 skip (matches baseline + new tests).
- [x] Type-check, lint, docs validate all clean.

## Phase 4+ (CLOSED — no work on our roadmap)
- [x] **Session resume / agent loop restoration** — closed: not ours, OpenCode already provides it.
- [x] **VS Code integration** — closed by user direction (2026-07-29): no VS Code work; Windows is out of scope anyway.
- [x] **Electron integration** — closed by user direction (2026-07-29): no Electron work; backend starts in-process, no Unix-socket guardian attach point.
- [x] **Mobile (Capacitor iOS/Android)** — closed by user direction (2026-07-29): nothing to do; mobile is a client connecting to an existing server, works as long as the server works.
- [x] **Hosted mobile** — closed by user direction (2026-07-29): not doing.
- [ ] **UI client persistence** (open tabs, draft, scroll) — `packages/ui` task, unrelated to #2421; not on #2421 roadmap. If someone opens a separate issue for it, that's a separate PR.

**Net: #2421 ends with Phase 2C.** No Phase 4 work. See `plan.md` "Phase 4 scope" for the reasoning.

## Issue closure path
- [ ] Explicit approval to commit (Phase 2A/2B/3 + Phase 2C + ipc-server fix) on `fix/issue-2421-restart-handoff`.
- [ ] Explicit approval to push and update PR #2485 from `Refs #2421` → `Closes #2421` once Phase 2C ships.
