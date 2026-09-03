# Phase 2E — Protected Managed OpenCode Credential Handoff

## Status and baseline

Implementation is present but the phase is not complete. This phase extends the prior web guardian/lifecycle implementation and does not reopen the closed cross-runtime scope.

Baseline (2026-07-31):

- HEAD: `894daff0c1138de3a3f422ee84a00eee5b844438`.
- Current `upstream/main`: `9a0f0b8aa`.
- The existing PR branch has no commits after the specified HEAD.
- Current implementation includes authenticated credential/health handling and a Linux process-boundary script/test with the controlled managed-child fixture.
- Native Windows was not run locally; required Windows evidence must come from hard-gated CI.
- No true bundled OpenChamber web-process E2E exists in this worktree; the controlled fixture/helper must not be represented as a bundled web binary.

## Goal

Preserve a managed OpenCode child’s system-derived Basic Auth credential across web-process boundaries without exposing it through public records or unauthenticated IPC, while retaining correct restart, stop, crash, and guardian-rehydration semantics.

## Security and data contract

- Store one encrypted credential record per managed-child incarnation under the existing ACL/private v2 root. Derive its encryption key from the existing guardian master secret.
- Do not add plaintext SQLite/JSON credentials, logs, or public credential fields. Keep public record fields unchanged unless later evidence proves a change necessary.
- Credential material is system-derived managed-child Basic Auth, not a user-authored/manual value; normal users never receive a raw credential editor or `list` response.
- Authenticated owner-scoped credential IPC must validate `ownerInstanceId`, `runtimeIdentity`, `launchFingerprint`, and `incarnation`. `list` must never include the credential.
- Reject oversized IPC frames before parsing; enforce one bounded limit for credential-related requests and responses.

## Shared resolver and lifecycle contract

- Guardian health and rehydration must use one shared hostname resolver with `launchSpec.hostname` and the stored Basic Auth credential; host and credential derivation must not diverge between paths.
- Before any credential-bearing health request, the guardian must complete the unauthenticated managed-health challenge/proof contract bound to the incarnation, launch fingerprint, and port. Missing or invalid proof fails closed without sending Basic Auth. This is an application-level ownership proof, not OS process attestation; stock OpenCode does not currently implement it, so unsupported password-protected managed runtimes are rejected before credential delivery. Password-free normal health paths remain compatible.
- Adoption selects the exact owner first, verifies health, then retrieves the credential and restores web auth state. Credential retrieval must not occur for a wrong or ambiguous owner.
- Restart detach retains the credential. A confirmed normal stop removes it. A failed or unconfirmed stop retains it for recovery.
- Guardian restart/rehydration must preserve the same incarnation-scoped protections and restore only the exact verified owner.
- Credential operation locks retain their authenticated owner token and process identity through `.lock.remove` quarantine. Exact in-process recovery or authoritative stale-owner recovery may remove only that quarantine artifact; a replacement live lock remains a fence.

## Acceptance gates

### Implementation

- Encrypted per-incarnation storage, master-secret-derived key handling, bounded credential IPC, exact owner validation, and `list` redaction are implemented without plaintext persistence or unnecessary public-field changes.
- The shared hostname resolver is used by both guardian health and rehydration with stored Basic Auth credentials.
- Adoption and stop/restart cleanup follow the lifecycle contract above.
- Windows rehydrated termination opens and retains one process handle, verifies the persisted start-time and launch identity against that handle, and terminates only that handle; unavailable helper/native identity is a fail-closed condition, never a PID-only fallback.

### Tests

- Shared hostname resolver tests pass.
- IPC frame-size limit tests pass.
- Credential lifecycle tests cover encrypted-at-rest behavior, retrieval, retention, confirmed-stop removal, wrong-owner rejection, and redacted listing.
- A password-protected managed-child fixture proves the stored Basic Auth path.
- True web process-boundary E2E covers graceful restart, crash recovery, wrong owner, and guardian restart/rehydration.

### CI, documentation, and validation

- Linux coverage is hard-gated at minimum. Windows covers credential, restart, and owner-mismatch paths; required paths do not use `continue-on-error`.
- Documentation states foreground/systemd semantics: ordinary SIGTERM is stop, while supported `openchamber restart` is the restart contract.
- Focused tests, source syntax, package type-check/lint, docs validation, and final CI evidence are recorded before completion. Injected helper tests do not prove native restart/rehydration; native Windows execution remains an explicit limitation and an open evidence gate.

## Review gate

Phase 2E must remain open until the credential storage/derivation, authenticated IPC and frame limit, shared resolver, lifecycle retention, true web-boundary E2E, required Linux/Windows CI, and foreground/systemd documentation are reviewed and validated. Prior guardian/lifecycle review and baseline CI do not satisfy these gates.

## Retained out-of-scope decisions

VS Code, Electron, mobile, hosted mobile, UI client persistence, and automatic OpenCode session/in-flight-turn restoration remain out of scope. Phase 2E is web-process-boundary credential handoff only.

## Approved persistence follow-up — 2026-08-05

### Scope implemented in this worktree

- Extended the existing v2 SQLite contract to schema `2421009`. The migration preserves the `2421007` record table and transactionally rebuilds the `2421008` operation table/index; malformed, unexpected, or partially migrated schemas still fail closed.
- Added signed owner/incarnation-bound operation records for non-idempotent spawn, stop, and abort outcomes. Records retain target revision/lease/MAC, resolution revision/lease/MAC, operation revision/MAC, and an authoritative confirmation horizon. Missing operation records remain unresolved; no stop/abort replay or legacy fallback is allowed while a durable operation is pending.
- Guardian operation status/resolution/expiry IPC is owner-scoped. Terminal resolution remains valid only after guardian-authoritative quiescence and exact owner/incarnation/revision/lease/MAC-bound terminal evidence; an expired operation remains a blocking recovery handle. Natural child exit retains its terminal row, attention, and operation handle until the durable resolution CAS succeeds.
- HMR lifecycle state now transfers the startup-secret lease association through a named lifecycle field. The lease remains internal redaction state, is released only after operation resolution/expiry, and is never written into the SQLite operation record or public IPC/list payload.
- Reserved startup rehydration explicitly re-arms the bounded same-process retry after a non-throwing CAS conflict, rather than relying on periodic cleanup or restart.

### Exact current file inventory

The current uncommitted scope is **21 files**:

```text
packages/web/server/index.js
packages/web/server/lib/guardian/detection.js
packages/web/server/lib/guardian/detection.test.js
packages/web/server/lib/guardian/guardian-client.js
packages/web/server/lib/guardian/guardian.js
packages/web/server/lib/guardian/guardian.test.js
packages/web/server/lib/guardian/ipc-server.js
packages/web/server/lib/opencode/DOCUMENTATION.md
packages/web/server/lib/opencode/hmr-state-runtime.js
packages/web/server/lib/opencode/hmr-state-runtime.test.js
packages/web/server/lib/opencode/lifecycle-guardian-integration.test.js
packages/web/server/lib/opencode/lifecycle.js
packages/web/server/lib/opencode/lifecycle.test.js
packages/web/server/lib/opencode/managed-opencode-handoff-v2/protocol.js
packages/web/server/lib/opencode/managed-opencode-handoff-v2/protocol.test.js
packages/web/server/lib/opencode/managed-opencode-handoff-v2/record.js
packages/web/server/lib/opencode/managed-opencode-handoff-v2/store.js
packages/web/server/lib/opencode/managed-opencode-handoff-v2/store.test.js
plans/issue-2421-restart-handoff/phases/phase-2e.md
plans/issue-2421-restart-handoff/reviews/phase-2e-h1-and-process-boundary.md
plans/issue-2421-restart-handoff/todo.md
```

### Validation recorded

- Earlier v2/store/protocol, guardian/detection/IPC/health, and lifecycle/HMR
  validation is historical and superseded by the current 21-file follow-up
  command recorded below.
- Process-boundary suite: **7 Vitest passed + 17 node:test passed**.
- Web type-check, web lint, documentation validation, changed-JavaScript syntax checks, and `git diff --check` passed.

### Remaining platform/evidence gaps

Native Windows rehydration/termination interleavings, true bundled-web process-boundary E2E, native H1 interleaving, directory-wide orphan scans, and exactly-once side-effect evidence remain open. No CI evidence was added in this worktree. Commit, push, PR publication, and status changes remain out of scope.

## Latest durable-operation remediation — 2026-08-05

This section supersedes earlier uncommitted-scope counts and validation totals.

### Actual current inventory

The current worktree scope is exactly **21 files: 17 JavaScript and 4 Markdown**. The paths are the 17 JavaScript files and four Markdown files listed in the inventory above.

### Remediation completed

- Guardian persists and validates a signed operation before every owner-scoped spawn, stop, prepare, and abort lifecycle-ambiguity side effect; failed creation cleans the reservation and never issues the side effect. Credential-removal/terminal cleanup is governed by the credential store's authenticated idempotent removal/absence contract and retained attention, not by the lifecycle ambiguity operation table.
- Prepare operation IDs are forwarded through IPC and resolved as `handoff-prepared`; owner-scoped operation discovery reconstructs fences after HMR/web-process loss before startup or fallback.
- Resolution requires the stored owner/incarnation and exact signed target binding plus guardian-authoritative quiescence. Absent target rows are distinct from read failures and never resolve an expired fence; only exact signed terminal evidence with durable operation CAS confirmation may clear it.
- Terminal attention is retained until credential absence/cleanup is independently confirmed, and terminal rows are retained while pending/expired operation handles reference them. Expired operations remain blocking and discoverable until authoritative resolution.
- Stop and unexpected-exit paths now terminalize the signed child row and resolve any pending/expired operation before releasing encrypted credential-store material; absent or unreadable child rows retain operation-linked attention and the non-plaintext credential handle through restart/rehydration.
- Schema `2421009` migrates `2421008` transactionally, preserves older record-only `2421007` databases, and rejects malformed rows, failed migration writes, unexpected schemas, and MAC-corrupt operations.

### Current validation

- Focused command `bun run --cwd packages/web test -- server/lib/guardian/ server/lib/opencode/managed-opencode-handoff-v2/ server/lib/opencode/lifecycle.test.js server/lib/opencode/lifecycle-guardian-integration.test.js server/lib/opencode/hmr-state-runtime.test.js --pool=threads --maxWorkers=1`: **636 passed / 3 skipped** across 24 test files, including overlapping operation retention, post-pruning tombstone, and stop-verification/no-duplicate-stop regressions.
- Process-boundary command `bun run --cwd packages/web test:node-boundary`: **7 Vitest + 17 node:test passed**.
- Process-boundary coverage: **7 Vitest passed + 17 node:test passed**.
- All 17 JavaScript inventory files passed `node --check`; `bun run type-check:web`, `bun run lint:web`, `bun run docs:validate` (**450 pages / 45 sidebar links**), and `git diff --check` passed.
- Native Windows rehydration/termination interleavings, bundled-web process-boundary E2E, native H1 interleavings, directory-wide orphan scans, exactly-once side-effect evidence, and CI remain platform/evidence gaps.

## Latest H5 retention/liveness follow-up — 2026-08-05

- Guardian attention and child entries retain a deduplicated operation set per
  incarnation, not a single operation ID. Spawn, prepare, stop, abort, and
  cleanup outcomes therefore cannot overwrite one another; restart discovery
  restores every pending/expired operation and attention/credentials clear only
  after every unresolved operation has authoritative quiescent resolution.
- HMR lifecycle state transfers the complete owner-scoped ambiguity-fence list.
  A resolved operation is retained as a signed owner/incarnation/target/resolution
  binding tombstone after its terminal child row is pruned. Reconciliation may
  use that tombstone to distinguish authoritative resolution from absence, but
  wrong binding, read failure, and ordinary missing unresolved state remain
  blocked.
- A stop response followed by stale, malformed, or failed list verification
  persists the stop operation/fence and retains the startup-secret lease. No
  duplicate stop is issued; release requires authoritative terminal/quiescence
  confirmation. The legacy injected-client path may clear only from a fresh
  authenticated empty list and never from a failed read.
- The canonical inventory remains exactly **21 files: 17 JavaScript and 4
  Markdown** listed above. No UI, CLI, dependency, or unrelated platform file
  is included. Focused H5 overlap, post-pruning tombstone, HMR restart, and
  verification-failure regressions are part of the current validation below.
- Current validation also includes all 17 inventory JavaScript files passing
  `node --check`; `bun run type-check:web`, `bun run lint:web`,
  `bun run docs:validate` (**450 pages / 45 sidebar links**), and
  `git diff --check` passed. Native Windows, bundled-web process-boundary,
  native interleaving, orphan-scan, exactly-once, and CI evidence remain open.

## Latest lifecycle-operation findings — 2026-08-05

- HMR/bootstrap reconciliation now always discovers the complete owner-scoped
  pending/expired operation set, merging durable operation IDs with any HMR
  fences already present instead of returning early on the first fence.
- Initial-spawn terminal reconciliation binds the local fence before use and
  confirms the exact resolved terminal operation before releasing its
  startup-secret lease. Durable terminal fences require matching owner,
  incarnation, and target/resolution revision, lease, and MAC bindings; stale
  or replaced bindings remain blocked.
- Failed `beginStopping`, `prepareHandoff`, and `abortHandoff` transitions
  immediately retain their persisted operation in guardian attention. That
  attention is rehydrated before child rows and blocks launches on unrelated
  ports until every unresolved operation resolves authoritatively.
- The canonical scope remains exactly **21 files: 17 JavaScript and 4
  Markdown**.
- Validation: focused lifecycle/guardian/v2/HMR/IPC command **643 passed / 3
  skipped** across 24 files; process-boundary **7 Vitest + 17 node:test**;
  17 inventory JavaScript syntax checks; web type-check/lint; docs validation
  (**450 pages / 45 sidebar links**); and `git diff --check` all passed.
- Native Windows rehydration/termination interleavings, bundled-web
  process-boundary E2E, native H1 interleaving, orphan scans, exactly-once
  side-effect evidence, and CI remain unverified.

## Latest global-admission and no-successor lease remediation — 2026-08-05

- Direct legacy startup and restart fallback now query guardian global admission
  before closing/spawning. Foreign-owner attention and durable operations are
  not filtered out; unresolved global state blocks launch fail-closed.
- A confirmed no-successor result after a non-ambiguous spawn failure performs
  authoritative cleanup and releases the associated startup-secret lease once.
  Ambiguous responses, unresolved operations/fences, malformed lists, and read
  failures retain the lease.
- Regressions cover foreign unresolved attention during restart with no exact
  owner/child, zero retained leases after confirmed no-successor failure, and
  lease retention for ambiguous failure. The canonical scope remains exactly
  21 files: 17 JavaScript and 4 Markdown.
- Current validation: focused guardian/lifecycle/detection/v2/HMR/IPC command
  **645 passed / 3 skipped** across 24 files; process-boundary **7 Vitest + 17
  node:test passed**; 17 inventory JavaScript syntax checks; web type-check and
  lint; docs validation (**450 pages / 45 sidebar links**); and
  `git diff --check` passed.
