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
- [x] Legacy fallback when guardian is unavailable on the supported web platforms.
- [x] `--handoff` / `--no-handoff` CLI flag → `OPENCHAMBER_RESTART_HANDOFF` env var (default: enabled).
- [x] F2 fix: single `buildManagedOpenCodeSpawnEnv({ rotatePassword })` helper used by both `startOpenCodeOnce` and guardian handoff.
- [x] F3 fix: dead `adopt()` RPC removed; trust boundary documented.
- [x] 11 lifecycle-guardian integration tests pass; 8 lifecycle regression tests pass.
- [x] Full server regression: 842 pass / 2 skip baseline.

## Phase 2C — Launch Wiring (local validation complete; Windows gate/publication pending)
- [x] `openchamber-guardian` registered in `packages/web/package.json#bin`.
- [x] `openchamber guardian {status|start|stop|reload|help}` subcommand in `commands-guardian.js`, dispatched from `cli.js`, with `--json` / `--quiet` / TTY parity per `clack-cli-patterns`.
- [x] `--guardian` (default) / `--no-guardian` opt-out flag in `cli-args.js`, mirroring the `--handoff` precedent.
- [x] `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled` env opt-out.
- [x] `maybeAutoStartGuardian` called in both foreground and daemon `serve` paths, gated on platform/options/env.
- [x] Foreground/web shutdown never tears down the guardian service automatically; ordinary stop is owner-scoped and restart/update detach with `{ preserveGuardian: true }`.
- [x] SIGTERM → SIGKILL escalation in `stopGuardianViaIpc` if the IPC shutdown path fails.
- [x] `runReloadAction` sends `SIGHUP` to the running guardian PID; the entrypoint already handles SIGHUP by restarting its timers.
- [x] Windows: loopback TCP/discovery-file transport, ACL enforcement, authenticated IPC, and `taskkill.exe` child termination.
- [x] PID file moved under `managed-opencode-handoff-v2/` root so it honors `--data-dir` / `OPENCHAMBER_DATA_DIR` (H2 fix during review round).
- [x] IPC `shutdown` RPC now sends `{ acknowledged: true }` BEFORE `guardian.stop()` destroys the sockets (`ipc-server.js` one-line protocol fix surfaced by the smoke test).
- [x] Linux and Windows end-to-end smoke tests launch a real managed-child fixture, cover negative IPC authentication, and print `ok` on success.
- [x] 24 launch-wiring vitest tests pass; 866 server tests pass / 2 skip (matches baseline + new tests).
- [x] Type-check, lint, docs validate all clean.

## Cross-platform follow-up — implementation complete; current CI validation passed; maintainer review pending
- [x] Shared guardian path resolver used by entrypoint, CLI, detection, and lifecycle.
- [x] Stable owner/runtime/launch identity is persisted in per-port instance metadata, propagated through `OPENCHAMBER_GUARDIAN_OWNER_ID`, filtered during adoption, and enforced on stop/abort calls.
- [x] Initial managed spawn goes through a running guardian; failed handoffs roll back successor/old-record state before legacy fallback.
- [x] Authenticated challenge/MAC/replay-protected IPC on POSIX and Windows.
- [x] Windows smoke script authenticates `list`/`shutdown`; Windows workflow smoke is a hard gate.
- [x] Current-tree ACL follow-up validation: 34 ACL tests passed; changed-file syntax, web type-check/lint, docs validation, and diff check are clean.
- [x] High review findings: platform-aware v2 filesystem branches, unquoted `icacls` argv, readiness-gated autostart, recoverable failed guardian stop, and fail-closed recovery-store startup.
- [x] Same-primitive medium correction: `taskkill` EPERM is now an ambiguous failure (ESRCH remains already-gone), and stale data events from replaced guardian sockets are ignored.
- [x] Owner-scoped CLI stop now avoids force-killing the web process or removing owner metadata when guardian shutdown is unconfirmed; retry/adoption regression covered in `bin/cli.test.js`.
- [x] Foreground signal shutdown now preserves the PID marker and owner metadata when `controller.stop()` rejects; regression covered in `bin/lib/commands-serve.test.js`.
- [x] Launch-failure cleanup now has a stale-CAS regression proving it re-reads and retries with the current revision.
- [x] Run the real `windows-latest` workflow at `7e4d595f3`; Windows baseline passed. Linux baseline and `pr checks` also passed at the same head.

## Phase 2E — Protected Managed OpenCode Credential Handoff (IMPLEMENTATION PRESENT — NOT COMPLETE)

Baseline (2026-07-31): HEAD `894daff0c1138de3a3f422ee84a00eee5b844438`; current `upstream/main` `9a0f0b8aa`; the existing PR branch has no commits after the specified HEAD. Phase 2E implementation and the Linux boundary script/test are present. Native Windows evidence was not run locally and remains open; the worktree has no true bundled OpenChamber web-process E2E, only the controlled managed-child boundary helper.

### Implementation gates (present; phase remains open for evidence)
- [x] Store encrypted per-incarnation managed OpenCode credentials under the existing ACL/private v2 root, deriving the encryption key from the existing guardian master secret.
- [x] Keep credentials out of plaintext SQLite/JSON and public record fields; change public fields only if later evidence proves it necessary.
- [x] Add authenticated owner-scoped credential IPC that validates `ownerInstanceId`, `runtimeIdentity`, `launchFingerprint`, and `incarnation`; ensure `list` never returns the credential.
- [x] Enforce a bounded IPC frame size before parsing credential-related requests or responses.
- [x] Use one shared hostname resolver for guardian health and rehydration, using `launchSpec.hostname` and stored Basic Auth credentials.
- [x] Adopt only after exact-owner selection and health; then retrieve the credential and restore web auth state.
- [x] Retain credentials on restart detach and on failed/unconfirmed stop; remove them only after confirmed normal stop.
- [x] Windows rehydrated termination uses a retained process-handle PowerShell/.NET helper that rechecks persisted start/launch identity; helper failure remains fail-closed and never falls back to PID-only taskkill.

### Test gates
- [x] Add shared hostname resolver tests.
- [x] Add IPC frame-size limit tests.
- [x] Add credential lifecycle tests, including encryption-at-rest, retrieval, retention, confirmed-stop removal, wrong-owner rejection, and redacted listing.
- [x] Add password-protected fixture coverage.
- [x] Add injected Windows handle-helper success, identity-failure, and unavailable-helper coverage; these tests do not substitute for native Windows rehydration evidence.
- [ ] Add true web process-boundary E2E for graceful restart, crash recovery, wrong owner, and guardian restart/rehydration.

### Medium findings implemented in the current worktree
- [x] Smoke health requests include the complete exact owner/incarnation identity while retaining credential redaction.
- [x] POSIX stale sockets and Windows discovery lock/temp/final artifacts recover only after a validated prior guardian PID marker proves death; live, reused, legacy, and ambiguous identities remain fail-closed.
- [x] Credential publication retries transient post-link directory-fsync failures and guardian launch cleanup removes linked targets before terminalizing a failed record.
- [x] IPC request and response frame-size regressions are covered by focused tests.
- [ ] Native Windows runtime evidence and true bundled OpenChamber web-process E2E remain unverified and are not claimed by local validation; the Linux boundary script and injected helper tests use only controlled fixtures/seams.

### CI gates
- [x] Add hard-gated Linux coverage for the Phase 2E credential, lifecycle, and web-boundary paths.
- [x] Add Windows credential, restart, and owner-mismatch coverage; required paths must not use `continue-on-error`.
- [ ] Record native `windows-latest` evidence for the Phase 2E paths.

### Documentation and validation gates
- [x] Document foreground/systemd semantics: ordinary SIGTERM is stop; supported `openchamber restart` is the restart contract.
- [x] Run focused Phase 2E tests plus source syntax, package type-check/lint, and docs validation; focused Vitest, Linux boundary, syntax, web type-check/lint, workflow-YAML parse, and docs validation passed locally.
- [ ] Record Linux and required Windows CI evidence, including the local native-Windows limitation, before marking Phase 2E complete.
- [ ] Complete maintainer/security review of credential storage, IPC authentication/frame limits, lifecycle retention, shared hostname resolution, and required CI workflows.

### Confirmed blocker follow-up (2026-08-02)
- [x] Share one match-aware startup redactor across stdout/stderr, including bounded cross-stream password/token/encoded-Basic regressions; preserve labels, URL parsing, and diagnostic limits.
- [x] Fence transport/discovery artifacts with normalized dev/ino, stable birth-time metadata (ctime fallback), and file type through publication, quarantine, recovery, removal, and close; fail closed when identity metadata is unavailable.
- [x] Add deterministic unlink/recreate replacement coverage that reuses dev+ino with changed identity metadata and preserves the replacement with a `replaced` outcome.
- [x] Prior local validation for the pre-helper transport work: focused guardian/lifecycle suite 264 passed; full serial web suite 1,387 passed / 3 skipped; root type-check/lint, syntax, docs, Linux smoke, and POSIX boundary passed.
- [x] Replace the POSIX listener-close workaround with `guardian/ipc-listener-helper.js`: the forked Node child owns the Unix listener FD, forwards real `net.Socket` handles over IPC, exits without `server.close()`/pathname unlink on ordered shutdown or parent disconnect, and the parent waits for helper exit before identity-safe socket removal. Helper startup/identity/IPC failure, replacement, and cleanup uncertainty retain transport/marker authority; Windows transport is unchanged.
- [x] Add real helper-boundary coverage for authenticated guardian IPC, replacement-before/during/after shutdown, helper crash/parent disconnect stale recovery, repeated FD/process baselines, and missing/ambiguous/helper-failure fail-closed behavior; the focused Bun transport unit file passes with the two handle-transfer cases delegated to the Node boundary test.
- [x] Current helper validation: Node boundary test 6 passed; Bun transport unit 57 passed / 2 skipped for Bun's unsupported socket-handle deserialization; PID-marker 8 passed; targeted guardian cleanup/marker tests pass; web type-check/lint, syntax, docs, Linux smoke, and POSIX boundary passed.
- [x] POSIX helper ownership/lifecycle blocker follow-up (2026-08-02): the helper publishes `<socketPath>.owner` as an O_EXCL-equivalent same-inode hard-link proof; parent readiness and close verify/track both identities; stale recovery requires the alias and preserves legacy/no-alias paths; close fences late handles, drains parent IPC, cancels in-flight listen, and resets state for relisten; standalone marker release is limited to verified startup rollback or clean `onStopped`.
- [x] Final local validation: Node/Vitest guardian + IPC + lifecycle + v2 + CLI suites 29 files, 616 passed / 1 skipped; full serial Node web suite 131 files, 1,433 passed / 3 skipped; Node IPC boundary 6 passed; Bun IPC transport 57 passed / 2 skipped; root type-check, lint, docs, changed-JS syntax, Linux guardian smoke, and POSIX web boundary passed.
- [ ] Full serial Bun web execution remains unavailable as a clean gate: the run timed out after 600s with existing Bun/Vitest mock API gaps (`vi.resetModules`, `vi.stubGlobal`, missing client methods), native `better-sqlite3` loading failure, missing `fetch`/`originalFetch` in affected tests, relay timeout, and transferred `net.Socket` incompatibility. The two Bun IPC skips are specifically the real helper-forwarded socket and stale-socket restart cases; Node boundary coverage proves those process/handle paths instead.
- [ ] Native Windows runtime and true bundled-web process-boundary evidence remain open and are not claimed by local validation.

### Remaining helper/runtime blockers (2026-08-02)
- [x] Bind the POSIX helper on the private owner pathname and publish the public socket with a no-clobber hard link; readiness now proves the bound-path/public/owner identity invariant without comparing sockfs FD dev/ino to pathname dev/ino.
- [x] Persist the verified POSIX transport/owner identity in the PID marker with a same-inode read/token-check/ftruncate/write/fsync update; a replaced marker path is never overwritten and stale recovery rejects legacy, missing, or replacement identities.
- [x] Remove unannounced same-inode ownership capture when helper readiness is lost or ambiguous; pre-ready helper shutdown/disconnect now performs identity-fenced cleanup that preserves replacements, with a 20-cycle parent-disconnect regression.
- [x] Add deterministic ready-identity and bind-to-alias replacement races, and bound helper shutdown IPC sends so a hung callback kills the child handle while cleanup authority remains retained.
- [x] Terminate direct lifecycle children and destroy their pipes on every post-spawn startup failure before retry/rejection.
- [x] Escalate direct lifecycle cleanup to stable `OPENCODE_CHILD_STILL_RUNNING` when a detached child survives termination, retain its managed-process registry entry, and suppress retry beside the live child.
- [x] Permit verified-dead pre-ready marker recovery without `transportIdentity` only when public/owner/quarantine artifacts are absent; retain authority when any artifact exists.
- [x] Fence normal marker and recovery-lease release with identity-safe quarantine removal so replacement races return false without deleting the replacement.
- [x] Fence POSIX helper events by per-listen generation and destroy late sockets from stale helpers after relisten.
- [x] Refresh ctime-only identities after descriptor-proven quarantine rename; retain an uncertain quarantine when no descriptor can prove continuity, and cover both the identity transition and public publication race.
- [x] Keep the Linux `O_PATH` publication descriptor through helper shutdown; require the descriptor-backed `closed` handoff to match the previously published object so a replacement pair cannot become cleanup authority.
- [ ] Native Windows runtime and bundled-web process-boundary evidence remain separate open gates.

## Phase 4+ (CLOSED — no work on our roadmap)
- [x] **Session resume / agent loop restoration** — closed: not ours, OpenCode already provides it.
- [x] **VS Code integration** — closed by user direction (2026-07-29): no VS Code work; its cross-runtime guardian bridge remains a separate design.
- [x] **Electron integration** — closed by user direction (2026-07-29): no Electron work; backend starts in-process, no Unix-socket guardian attach point.
- [x] **Mobile (Capacitor iOS/Android)** — closed by user direction (2026-07-29): nothing to do; mobile is a client connecting to an existing server, works as long as the server works.
- [x] **Hosted mobile** — closed by user direction (2026-07-29): not doing.
- [ ] **UI client persistence** (open tabs, draft, scroll) — `packages/ui` task, unrelated to #2421; not on #2421 roadmap. If someone opens a separate issue for it, that's a separate PR.

**Net Phase 4 status remains closed.** Phase 2E is a web-only protected-credential follow-up and does not reopen the cross-runtime decisions. See `plan.md` "Phase 4 scope" for the reasoning.

## PR review follow-up — runtime fix head `7e4d595f3`
- [x] Read the PR review threads and issue comments through the current bot review; preserve PR #2485 as OPEN/Draft.
- [x] Align provenance with `upstream/main`; current PR metadata reports `MERGEABLE`.
- [x] Treat shared `packages/ui` live-status reconciliation as an affected surface; keep UI client persistence out of this issue.
- [x] Fix `icacls` parsing for target paths containing spaces and add regression coverage; native Windows output remains pending.
- [x] Add the negative explicit/non-inherited `CREATOR OWNER` ACL test.
- [x] Update the PR handoff with the guardian-owned `openchamber stop` failure/retry behavior.
- [x] Validation recorded at exact runtime head `7e4d595f3`: local ACL checks passed; Linux baseline, Windows baseline, and `pr checks` passed. Subsequent branch commits are plan-only.
- [ ] Obtain human maintainer review for both workflow files; automation cannot clear this trust-boundary gate.
- [ ] Track the oversized-diff fail-closed fix for `.github/workflows/pr-review.yml` separately unless explicitly added to this issue.

## Issue closure path
- [x] Provenance audited at current head; no history rewrite or Draft-status change is planned.
- [x] Complete the PR review follow-ups above and refresh final-head validation.
- Note: Further commits, pushes, force-pushes, or PR status changes require separate explicit approval.
