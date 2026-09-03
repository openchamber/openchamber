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
- [x] Windows: loopback TCP/discovery-file transport, ACL enforcement, authenticated IPC, and retained PowerShell/.NET process-handle child termination (`runTaskkillForce` is compatibility/test infrastructure only, not the production rehydrated-child path).
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
- [x] Record native `windows-latest` evidence for the Phase 2E paths (PR HEAD `3d04d66f6`; Windows baseline run `30874446398`).

### Documentation and validation gates
- [x] Document foreground/systemd semantics: ordinary SIGTERM is stop; supported `openchamber restart` is the restart contract.
- [x] Run focused Phase 2E tests plus source syntax, package type-check/lint, and docs validation; focused Vitest, Linux boundary, syntax, web type-check/lint, workflow-YAML parse, and docs validation passed locally.
- [x] Record Linux and required Windows CI evidence, including the local native-Windows limitation, before marking Phase 2E complete (PR HEAD `3d04d66f6`; Linux baseline run `30874446385`; Windows baseline run `30874446398`).
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

## Current uncommitted reviewer-fix scope — 2026-08-05

- [x] Keep the reviewer-fix scope to the actual **21 files (17 JavaScript + 4
  Markdown)** covering lifecycle/guardian/detection/v2/HMR/server composition
  and the canonical-doc boundary. The scope adds no UI, CLI, or unrelated
  platform files; adoption confirmation remains within the authenticated
  guardian IPC and existing v2 CAS ownership path. No unrelated UI, CLI, or
  platform files are included.
- [x] C1: adopt fail-closed admission. Every unresolved attention record blocks
  new launches regardless of explicit-port mismatch, null/unknown port,
  incomplete owner identity, or conflicting owner fields. Terminal/expired
  records unblock only after authoritative credential cleanup removes attention.
- [x] Add C1 regressions for unrelated explicit-port launch beside null-port
  attention, same-port/null-port admission, incomplete owner attention, and
  safely reconciled terminal/expired records.
- [x] H3: Reserved attention is re-read and terminalized through authoritative
  incarnation/revision/MAC/lease fences; transient CAS/store failure retains
  attention and credentials, then uses bounded explicit in-process retries.
  Expired state is used only for terminal recovery, never launch/bind/renew.
- [x] H5: sent non-idempotent Guardian RPC failures use stable
  `GUARDIAN_REQUEST_AMBIGUOUS` with `retryable: false`; ambiguity is detected
  through `code`, `ambiguous`, or preserved `originalCode`, and cleanup/wrappers
  retain the underlying transport code. Ambiguous prepare-handoff/spawn skips
  abort/rollback and legacy fallback; non-ambiguous failures retain fallback.
- [x] Extend the persistent owner-scoped ambiguity fence to initial guardian
  spawn, bootstrap/HMR restoration, restart, and direct lifecycle start. While
  unresolved, no stop, spawn, rollback, retry, or legacy fallback occurs.
  Delayed successor visibility is covered deterministically.
- [x] Require complete authenticated revision/lease/MAC binding when matching
  or clearing a persisted fence. Missing or mismatched binding, owner, or
  incarnation remains fenced until authoritative owner-scoped reconciliation
  supplies a complete record.
- [x] Preserve H1 pre/post process identity fences.
- [x] Focused validation after this scope change: guardian/C1/H3 tests **94
  passed**; lifecycle/HMR/fence tests **88 passed**; v2/store tests **20
  passed**; health-client/H1 tests **4 passed / 2 skipped** (platform-gated);
  changed-JS syntax checks,
  web typecheck/lint, docs validation, and diff-check passed.
- [ ] Native Windows rehydration, bundled-web process-boundary E2E, native H1
  interleaving, directory-wide orphan scans, and exactly-once side effects were
  not validated or claimed in this session; no CI evidence was added.

## Latest lifecycle-safety follow-up — 2026-08-05

- [x] Extend the owner-scoped ambiguity fence to ambiguous owner-scoped stop
  and abort-handoff cleanup responses, including successor cleanup, with no
  duplicate cleanup, rollback, or legacy fallback before authoritative
  reconciliation. Reconciliation may retry authoritative inspection/adoption,
  but never replays an ambiguous non-idempotent RPC.
- [x] If reconciliation still sees `handoff-prepared` after an ambiguous
  `abortHandoff()`, keep the persisted fence and remain blocked; do not abort a
  second time.
- [x] Make every direct owner-scoped stop consult the unresolved ambiguity
  fence before issuing a stop RPC; repeated stop requires reconciliation,
  adoption, or explicit safe resolution.
- [x] Require complete revision, lease, and MAC binding on both expected and
  observed adoption records; missing fields fail closed.
- [x] Route every fence-clearing adoption through guardian-side
  `confirmAdoption()`, whose credential/health revalidation and v2 same-record
  authoritative CAS are the final authority. Record-binding and
  credential/health mutation-after-read regressions are deterministic;
  plaintext credentials remain transient.
- [x] Add guardian-side signed terminal status plus exact-binding CAS
  confirmation for ambiguous stops after retirement/removal from `#children`.
  Wrong owner, incarnation, revision, lease, or MAC remains fenced and no stop
  replay is used.
- [x] Keep H3 bounded attention retry scheduled when Reserved terminalization
  succeeds but Interrupted/Retired credential removal fails; retain attention
  and encrypted credentials until removal succeeds.
- [x] Add deterministic lifecycle regressions for ambiguous stop, repeated
  direct stop, ambiguous abort while prepared, delayed successor visibility,
  no duplicate child/fallback, and binding mutation; add detection missing-field,
  v2 CAS, and guardian credential/health mutation regressions.
- [x] Final validation for this scope: current **21-file scope (17 JavaScript +
  4 Markdown)**, focused lifecycle/guardian/detection/v2/HMR/IPC suites and
  all new regressions from that preceding scope are historical; the current
  21-file follow-up totals are recorded in the latest Phase 2E section.
- [ ] Native Windows rehydration/termination races, bundled-web
  process-boundary E2E, native H1 interleaving, directory-wide orphan scans,
  and exactly-once side effects remain platform/evidence gaps.

## H5 terminal-retention and startup-secret lease follow-up — 2026-08-05

- [x] Retain signed `Interrupted`/`Retired` terminal records through a fresh
  authoritative confirmation horizon so an expired launch lease cannot prune
  the H5 terminal handle immediately after a lost stop response.
- [x] Keep `terminalStatus()`/`confirmTerminal()` fail-closed on exact owner,
  incarnation, revision, lease, and MAC binding; release a fence only after
  authoritative terminal/quiescence confirmation, never on early absence and
  never by replaying stop/abort.
- [x] Associate startup-secret leases with unresolved initial-spawn and direct-
  stop ambiguity fences, retain them through unresolved state, transfer them on
  authoritative adoption, and release them after terminal confirmation or safe
  fence expiry without persisting plaintext secrets.
- [x] Correct the canonical inventory and validation wording to the actual
  **21 files (17 JavaScript + 4 Markdown)**. The preceding focused totals are
  historical; current counts are recorded in the latest Phase 2E section.
- [ ] Native Windows rehydration/termination interleavings, bundled-web
  process-boundary E2E, native H1 interleaving, directory-wide orphan scans,
  and exactly-once side effects remain platform/evidence gaps; no CI evidence
  was added in this session.

## Approved durable operation persistence follow-up — 2026-08-05

- [x] Extend the existing v2 persistence contract to schema `2421009` with a
  strict signed operation table and transactional `2421007`/`2421008` migrations that
  preserves existing child records and fails closed on malformed schemas.
- [x] Persist owner/incarnation-bound spawn, stop, and abort operation outcomes
  with exact target/resolution revision, lease, MAC, and authoritative
  confirmation horizon. Missing records remain unresolved; no stop/abort replay
  or legacy fallback is permitted while an operation is pending.
- [x] Resolve ambiguous stop only after guardian-authoritative quiescence and
  exact target/terminal evidence; an expired operation remains blocking and
  discoverable, and initial ambiguous spawn remains fenced until safe
  authoritative resolution.
- [x] Add guardian operation status/resolution/expiry IPC and natural-child-exit
  terminalization so the live child map is not the sole recovery authority.
- [x] Transfer startup-secret lease association through named HMR lifecycle
  state, retain it through unresolved operation state, and release it only after
  authoritative operation resolution/expiry; no plaintext secret is persisted
  in SQLite, JSON, public records, or IPC list/status payloads.
- [x] Re-arm Reserved startup-recovery attention after a non-throwing CAS
  conflict for same-process bounded retry.
- [x] Current worktree inventory is exactly **21 files**; canonical details and
  validation are recorded in `phases/phase-2e.md`.
- [x] The prior focused validation remains historical; current follow-up
  commands and counts are recorded in the latest Phase 2E review section.
- [ ] Native Windows rehydration/termination interleavings, bundled-web
  process-boundary E2E, native H1 interleaving, directory-wide orphan scans,
  exactly-once side effects, and CI evidence remain open; no commit or push was
  performed.

## Latest lifecycle admission and lease cleanup findings — 2026-08-05

- [x] Add guardian-authoritative global admission before every direct legacy
  startup/restart fallback while guardian state is available; unresolved
  attention or durable operation for any owner blocks without owner/port
  filtering, while exact owner-scoped adoption remains separate.
- [x] After confirmed old-child stop and non-ambiguous successor spawn failure,
  require an authenticated empty successor result and no unresolved operation or
  ambiguity fence before releasing the startup-secret lease exactly once.
- [x] Regressions cover foreign unresolved attention/no exact owner with no
  legacy spawn, zero leases after confirmed no-successor failure, and lease
  retention for ambiguous failure.
- [x] Validation: focused guardian/lifecycle/detection/v2/HMR/IPC command
  **645 passed / 3 skipped** across 24 files; process-boundary **7 Vitest + 17
  node:test passed**; 17 JavaScript syntax checks; web type-check/lint; docs
  validation (**450 pages / 45 sidebar links**); and `git diff --check` passed.
- [x] Current inventory remains exactly **21 files: 17 JavaScript + 4
  Markdown**; no commit or push was performed.

## Latest durable-operation remediation — 2026-08-05

- [x] Current inventory verified as exactly **21 files: 17 JavaScript + 4 Markdown**; canonical paths are recorded in `phases/phase-2e.md`.
- [x] Fail closed before guardian spawn, stop, prepare, and abort lifecycle
  ambiguity side effects when durable operation creation is unavailable,
  invalid, or fails; reservation cleanup and no-spawn regression are covered.
- [x] Forward prepare operation IDs through GuardianClient and IPC; persist and resolve prepare operations, with operation status/list/discovery coverage.
- [x] Enforce exact stored target owner/incarnation/revision/lease/MAC resolution bindings; distinguish absent target records from read failures; require signed terminal resolution and durable/terminal CAS confirmation before clearing lifecycle fences.
- [x] Discover owner-scoped pending and expired operations after HMR/web-process restart and reconstruct the lifecycle fence before adoption, start, retry, or legacy fallback.
- [x] Retain terminal attention until encrypted credential absence/cleanup is independently confirmed; expired operations remain unresolved and discoverable until authoritative quiescence resolution.
- [x] Extend the durable store migration to schema `2421009`; add operation-table/index migration rollback, malformed-row, reopen, and MAC-corruption coverage while preserving `2421007` compatibility and transactional behavior.
- [x] Final focused command passed **634 tests / 3 skips** across 24 guardian/v2/lifecycle/HMR files, including absent/unreadable operation-attention rehydration and stop/unexpected-exit credential-retention regressions; process-boundary command passed **7 Vitest + 17 node:test**; 17 JavaScript syntax checks, web type-check/lint, docs validation (**450 pages / 45 sidebar links**), and `git diff --check` passed.
- [ ] Native Windows rehydration/termination interleavings, bundled-web process-boundary E2E, native H1 interleaving, directory-wide orphan scans, exactly-once side effects, and CI evidence remain platform/evidence gaps; no commit or push was performed.

## Latest durable-operation review remediation — 2026-08-05

- [x] Expiry is no longer resolution: pending operations become an expired
  unresolved state at the confirmation horizon, remain discoverable after
  restart, protect their terminal child rows from pruning, and continue to
  block start/retry/fallback until guardian-authoritative quiescence plus exact
  owner/incarnation/revision/lease/MAC-bound signed evidence passes CAS.
- [x] Natural-exit, stop, and cleanup paths retain terminal rows, attention,
  child entries, and durable operation IDs until `resolveDurableOperation()`
  succeeds. Read/CAS failure is retained and retried; missing operation or
  target state is never absence-as-success, and credentials remain behind the
  credential store's authenticated absence/cleanup contract.
- [x] Documentation narrows operation-fencing claims to lifecycle ambiguity
  side effects (spawn/stop/prepare/abort); credential-removal cleanup remains
  covered by the shared credential-store idempotent removal and attention
  retention contract.
- [x] Exact commands are recorded in `phases/phase-2e.md` and the current
  review section; **634 passed / 3 skipped**, process-boundary **7 Vitest + 17
  node:test**, 17 syntax checks, web type-check/lint, docs validation, and
  `git diff --check` passed. No commit or push was performed.

## Latest H5 retention/liveness findings — 2026-08-05

- [x] Track all outstanding signed operations per incarnation in guardian
  attention/child state; later stop/abort/cleanup operations cannot overwrite a
  pending spawn/prepare handle, and restart discovery restores the full set.
- [x] Keep attention and credentials retained until every unresolved operation
  has authoritative quiescent resolution, including out-of-order resolution.
- [x] Retain resolved signed operation rows as owner/incarnation/binding-bound
  tombstones after terminal child pruning so HMR reconciliation distinguishes
  authoritative resolution from ordinary absence. Wrong binding and read
  failure remain blocked.
- [x] Persist the stop operation/fence and startup-secret lease after an
  authoritative stop response whose list verification is stale, malformed, or
  unavailable; later terminal/quiescence confirmation clears it without a
  duplicate stop.
- [x] Preserve the exact **21-file (17 JavaScript + 4 Markdown)** inventory and
  update validation claims only with current command results. No commit or push
  was performed.
- [x] Current validation: focused guardian/v2/lifecycle/HMR command **636
  passed / 3 skipped** across 24 files; process boundary **7 Vitest + 17
  node:test**; 17 JavaScript syntax checks; web type-check/lint; docs
  validation (**450 pages / 45 sidebar links**); and `git diff --check` passed.

## Latest lifecycle-operation findings — 2026-08-05

- [x] Always discover and merge the complete owner-scoped pending/expired
  operation set even when HMR already transferred one or more fences; keep
  every unresolved operation blocking and cover the multiple-operation case.
- [x] Declare and bind the initial-spawn fence before terminal reconciliation;
  require exact terminal operation confirmation before releasing its lease and
  cover restart/HMR recovery without a `ReferenceError` or stuck fence.
- [x] Attach failed `beginStopping`, `prepareHandoff`, and `abortHandoff`
  operations to durable attention immediately; rehydrate them before child
  rows and block unrelated-port admission until resolution.
- [x] Match durable terminal fences against operation owner/incarnation and
  target or resolution revision/lease/MAC bindings; stale or replaced fences
  remain blocked.
- [x] Preserve the exact **21-file (17 JavaScript + 4 Markdown)** inventory.
- [x] Current validation: focused lifecycle/guardian/v2/HMR/IPC command **643
  passed / 3 skipped** across 24 files; process boundary **7 Vitest + 17
  node:test**; 17 JavaScript syntax checks; web type-check/lint; docs
  validation (**450 pages / 45 sidebar links**); and `git diff --check` passed.
- [ ] Native Windows rehydration/termination interleavings, bundled-web
  process-boundary E2E, native H1 interleaving, directory-wide orphan scans,
  exactly-once side effects, and CI evidence remain open; no commit or push was
  performed.
