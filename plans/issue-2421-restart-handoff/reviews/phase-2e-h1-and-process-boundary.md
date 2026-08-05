# Phase 2E — H1 Health-Client Fix and Process-Boundary Notes

## Scope

Two minimal, focused changes for the Phase 2E worktree:

1. H1 fix in `packages/web/server/lib/guardian/health-client.js`: hoist the
   `proof` binding out of the inner `try` so the `catch` no longer throws an
   unhandled `ReferenceError` when the pre-proof connection is refused.
2. New process-boundary integration test + POSIX script that exercise the
   full credential handoff across real process boundaries (real guardian,
   real managed-child fixture, real `GuardianClient`).

## H1 fix (health-client.js)

The H1 bug:

- Line 339 declared `const proof = ...` (block-scoped to the `try`).
- The `catch {}` at line 393 references `proof`; on a pre-proof connection
  failure, that reference raises `ReferenceError: proof is not defined`,
  masking the intended `credentialFailure` envelope and breaking the
  fail-closed contract for the unauthenticated probe.

The H1 fix:

- Hoist `let proof = null;` to the enclosing function scope.
- Document the contract inline: pre-proof failure → `credentialFailure`,
  post-proof failure → `proofFailure`. Both are structured envelopes
  rather than thrown errors.

The fix is the smallest semantic change that restores the contract. It
does not weaken validation, swallow the error, or alter observable
behavior of any of the 3 existing tests in `health-client.test.js`.

### Validation evidence

- `vitest run server/lib/guardian/health-client.test.js` → 4/4 passed
  (3 existing + 1 new "closed-port returns credentialFailure" case).
- Confirmed the new test fails on the unpatched code with
  `ReferenceError: proof is not defined` and passes on the patched code.
- `node --check` on the patched file: clean.
- Historical baseline: `vitest run server/lib/guardian/` → 283 passed / 1 skipped
  (the skipped one is the Windows-only `windows-smoke-script` test).

## Process-boundary coverage

The Phase 2E review gate requires a true web process-boundary E2E.
Booting the bundled web binary (`packages/web/.../dist/...`) is not
feasible in this worktree (no production build is staged; the dev
binary is the same Vite HMR server the E2E shell would have to wait
on). The new coverage uses the closest available local approximation:

- A real `ManagedOpenCodeGuardian` instance bound to a real Unix socket.
- The real `scripts/guardian-test-opencode.js` managed-child fixture,
  spawned by the guardian's spawn flow.
- A real `GuardianClient` driving `spawn → credential → health → stop`
  over authenticated IPC.
- A real Node child process (`scripts/process-boundary-web-harness.mjs`)
  that performs the same operations from a separate process boundary.
- A POSIX shell script (`scripts/web-restart-boundary-posix.sh`) that
  drives the same lifecycle through a separate Node helper
  (`scripts/web-restart-boundary-helper.mjs`).

### What is proven

- The credential is delivered only after a verified proof on the same
  socket (regression: no empty `Authorization` header on a pre-proof
  probe).
- A graceful restart (stop + spawn on a new port with the same owner)
  restores the credential from the encrypted store.
- A wrong-owner / port-swap scenario fails closed: the authenticated
  `credential` RPC rejects a foreign owner, and a pre-proof probe with
  an empty `Authorization` header is not honored.
- The web process never logs the credential (harness stderr is asserted
  to not contain the secret).

### What is not covered (explicit remaining gaps)

- **Native Windows**: both the POSIX script and the vitest
  process-boundary test are gated to Linux. Windows must rely on the
  hard-gated `guardian-windows-baseline.yml` workflow; the change
  adds no new Windows-only assertions locally.
- **True web-binary E2E**: no bundled web binary is launched in this
  worktree. The harness is a separate Node process; the helper script
  uses a separate Node helper. A future change could add a workflow
  that runs `bun run build:web` first and then drives the same harness
  against the real bundled server, but that build is out of scope for
  this fix.
- **Credential storage compromise tests**: the change relies on the
  existing encrypted-at-rest invariant; it does not add a new test for
  encrypted-at-rest properties (already covered in the existing
  `credential-store.test.js`).

## Files changed

- `packages/web/server/lib/guardian/health-client.js` — H1 fix (hoist
  `proof`).
- `packages/web/server/lib/guardian/health-client.test.js` — new
  "closed-port returns credentialFailure" test.
- `packages/web/server/lib/guardian/process-boundary.test.js` — new
  vitest process-boundary test (in-process + harness).
- `scripts/process-boundary-web-harness.mjs` — new Node child fixture
  acting as the "web" process.
- `scripts/web-restart-boundary-posix.sh` — new POSIX script.
- `scripts/web-restart-boundary-helper.mjs` — new Node helper invoked
  by the POSIX script.
- `.github/workflows/guardian-linux-baseline.yml` — new
  hard-gated step that runs the POSIX script.

## Gated actions

- No commits, pushes, branches, tags, or PR changes were made.
- No `git` or `gh` commands were run.
- No OCR or external review was invoked.

The CI workflow step is added in-tree but is not run by this agent
session; the maintainer must run the new workflow on the PR branch to
record the corresponding evidence.

## Current uncommitted reviewer-fix audit — 2026-08-05

### Audit basis and evidence boundary

- Historical review content before this section is preserved. This section is
  authoritative for the current uncommitted reviewer-fix scope.
- The current reviewer-fix scope is 21 files (17 JavaScript and 4 Markdown): lifecycle composition/HMR wiring,
  guardian/v2/detection/lifecycle source and regression-test files, owning
  module documentation, and the three canonical plan documents. The final
  adoption decision uses authenticated guardian confirmation backed by the v2
  same-record CAS; no plaintext credential persistence was added.
- Exact files: `packages/web/server/index.js`,
  `packages/web/server/lib/guardian/detection.js`,
  `packages/web/server/lib/guardian/detection.test.js`,
  `packages/web/server/lib/guardian/guardian-client.js`,
  `packages/web/server/lib/guardian/guardian.js`,
  `packages/web/server/lib/guardian/guardian.test.js`,
  `packages/web/server/lib/guardian/ipc-server.js`,
  `packages/web/server/lib/opencode/DOCUMENTATION.md`,
  `packages/web/server/lib/opencode/hmr-state-runtime.js`,
  `packages/web/server/lib/opencode/hmr-state-runtime.test.js`,
  `packages/web/server/lib/opencode/lifecycle-guardian-integration.test.js`,
  `packages/web/server/lib/opencode/lifecycle.js`,
  `packages/web/server/lib/opencode/lifecycle.test.js`,
  `packages/web/server/lib/opencode/managed-opencode-handoff-v2/protocol.js`,
  `packages/web/server/lib/opencode/managed-opencode-handoff-v2/protocol.test.js`,
  `packages/web/server/lib/opencode/managed-opencode-handoff-v2/record.js`,
  `packages/web/server/lib/opencode/managed-opencode-handoff-v2/store.js`,
  `packages/web/server/lib/opencode/managed-opencode-handoff-v2/store.test.js`,
  `plans/issue-2421-restart-handoff/phases/phase-2e.md`,
  `plans/issue-2421-restart-handoff/reviews/phase-2e-h1-and-process-boundary.md`,
  and `plans/issue-2421-restart-handoff/todo.md`.
- Findings distinguish current code facts from local validation evidence; no
  CI or native Windows evidence is claimed from this session.

### Scope and inventory

The current reviewer-fix scope is the 21-file inventory described above.
The current review
does not claim changes to the broader guardian directory, UI sync, CLI, or
other platform modules.

### Stage table

| Stage | Status | Current evidence / boundary |
|---|---|---|
| scope understood | ✅ | Exactly the 21 changed paths listed in the latest Phase 2E inventory were reviewed (17 JavaScript, 4 Markdown). |
| code path found | ✅ | Guardian/v2 admission, credential cleanup, CAS/lease fencing, GuardianClient ambiguity, and lifecycle handoff/fallback paths were traced. |
| fix level checked | ✅ | Guardian owns child admission/reconciliation; v2 owns durable record/CAS state; lifecycle owns web handoff and legacy fallback. |
| behavioral contract | ✅ | The user naturally restarts, stops, adopts, or observes a managed OpenCode process. Values are system/provider-derived credentials and process identities selected by owner/incarnation, not user-authored or manually entered. Existing guardian/lifecycle patterns preserve exact identity checks and do not expose raw credentials to normal users. |
| implementation | ✅ | C1 blocks every unresolved attention record; H3 retries Reserved terminalization in-process with bounded scheduling and retains credentials until a fenced terminal CAS succeeds; H5 now fences initial spawn, bootstrap/HMR, direct start, and restart until complete owner-scoped revision/lease/MAC reconciliation. |
| verification | ⚠️ | Focused lifecycle/guardian/detection/v2/HMR/IPC tests, syntax, web type-check/lint, docs validation, and diff checks are local only; native Windows and bundled web E2E remain unverified. |
| review | ⚠️ | The C1 policy is selected and regression-covered; H1 behavior was preserved, and no native race evidence was added. |
| commit/PR | ⏭️ | No commit, branch, push, or PR action was performed. |

### Critical findings

| ID | Path / current lines | Root cause and impact | Status | Disposition |
|---|---|---|---|---|
| **C1** | `packages/web/server/lib/guardian/guardian.js:958-995` | Unresolved attention can contain stale, missing, or contradictory port/owner data, so field-based admission could allow a new launch beside an unresolved record. | **Fixed.** Every unresolved attention record blocks admission, including unrelated explicit ports, null ports, incomplete owners, and conflicting owners. Only authoritative terminal records whose credential cleanup succeeds are removed from attention and allowed to stop blocking. | The chosen fail-closed policy is covered by null-port, same-port/null-port, incomplete-owner, and terminal/expired cleanup regressions. |
| **C2** | `packages/web/server/lib/guardian/guardian.js:774-784` | `Buffer.fill(0)` clears the temporary encoded bytes, but it cannot clear the already-created Base64 string returned in the `Authorization` header. | **Confirmed scrubbing limitation.** The impact is bounded to the immutable in-memory string lifetime and is a severity caveat, not evidence that plaintext is persisted or logged. | Record as a residual secret-lifetime limitation; assess whether the transport/API can avoid materializing the string, without overstating it as a storage leak. |

### High findings

| ID | Path / current lines | Root cause and impact | Status | Disposition |
|---|---|---|---|---|
| **H1** | `packages/web/server/lib/guardian/guardian.js:1252-1287` | A PID can be reused or the port occupant can change during the health request. Existing mitigations validate the persisted process identity before the health probe and revalidate it after the successful port-based response at 1287. Native race evidence for the replacement during the request is still missing. | **Open race/evidence risk.** The pre/post identity fences reduce the window but do not prove the native interleaving. | **Follow-up PR risk.** Add native PID-reuse-during-health evidence; do not mark the race fully closed. |
| **H2** | `packages/web/server/lib/guardian/guardian.js:419-433` | The mutation queue catches an internal rejection only to keep the queue usable. The original `queued` promise is returned, so the caller still receives the operation error. The “silent swallowing” claim is a false positive; the residual concern is only the semantics of intentionally detached queue recovery. | **False positive for caller-error loss; residual semantics concern.** | No merge blocker from this claim; retain a test that distinguishes queue recovery from caller error propagation. |
| **H3** | `packages/web/server/lib/guardian/guardian.js` and `packages/web/server/lib/opencode/managed-opencode-handoff-v2/store.js` | A same-process transient CAS/store failure could leave a Reserved attention record and credential stranded until restart. | **Fixed in current scope.** Reserved attention is re-read and terminalized through the authoritative incarnation/revision/MAC/lease fences; transient store failures retain attention and credentials, then use bounded scheduled retries. Expired state is used only for terminal recovery, never launch/bind/renew. | Deterministic guardian regression proves the first CAS failure leaves the Reserved record available and a same-process cleanup retry reaches Interrupted before credential removal; existing production SQLite protection/eviction coverage remains. |
| **H4** | `packages/web/server/lib/guardian/guardian.js:1821,1841` | POSIX termination intentionally signals the detached process group, then the child handle. Rehydrated children run identity checks immediately before each signal, but PGID reuse/group membership and the native detached-group behavior remain insufficiently exercised. | **Mitigated but not fully evidenced.** Identity checks and intentional detached-group behavior are present; the remaining risk is PGID/reuse behavior. | Follow-up native/process-group coverage; do not replace identity checks with PID-only signaling. |
| **H5** | `packages/web/server/lib/guardian/guardian-client.js` and `packages/web/server/lib/opencode/lifecycle.js` | A sent non-idempotent prepare-handoff or spawn RPC can have applied before response loss; rollback or legacy spawn can therefore duplicate or race the original side effect. | **Fixed without idempotency redesign.** Ambiguity is detected from `code`, `ambiguous`, or preserved `originalCode`; cleanup wrappers preserve `GUARDIAN_REQUEST_AMBIGUOUS`, `retryable: false`, and the underlying transport `originalCode`. Initial guardian spawn, bootstrap/HMR restoration, direct start, and restart persist and reconcile one owner-scoped fence before any duplicate stop, spawn, rollback, or legacy fallback. Complete revision/lease/MAC binding is mandatory; missing or mismatched binding remains fenced. Reconciliation may retry authoritative inspection/adoption, but the ambiguous non-idempotent RPC itself is never automatically replayed. | Focused lifecycle regressions cover ambiguous prepare-handoff, ambiguous abort while still prepared, repeated stop after ambiguity, ambiguous restart spawn, initial guardian spawn, delayed successor visibility, HMR/bootstrap retry, strict missing/incorrect binding, and non-ambiguous prepare-handoff fallback; existing client response-loss coverage remains. |
| **H6** | `packages/web/server/lib/opencode/lifecycle.js:866-901` | Windows fallback termination invokes recursive `taskkill /t` before and after force escalation. The recursive tree operation is broader than the retained-handle guardian path and has no equivalent native identity proof in this lifecycle fallback. | **High residual risk, not a confirmed incident.** | Add Windows identity/race coverage or constrain the fallback; do not describe the fallback as equivalent to guardian termination. |
| **H7** | `packages/web/server/lib/opencode/lifecycle.js:729-745,1935-1940` | The legacy POSIX fallback uses `lsof` and `kill -9` against any listener on a port when guardian use was not observed. It is intentionally gated by the legacy path, but it is not owner-scoped and can target a foreign listener. | **High residual availability/safety risk.** | Keep as a separately reviewed legacy fallback; require owner-aware evidence before expanding its use. |

### Remaining evidence gaps

Only the following current-diff risks remain open: native PID-reuse during
health/termination interleavings, native Windows rehydration and termination,
and a true bundled-web process-boundary run. These are evidence gaps, not
claims that the local implementation is incorrect.

### Test gaps

| ID | Required gap | Current coverage and remaining gap |
|---|---|---|
| **TG1** | **null port** | Corrected: unresolved null-port attention blocks unrelated explicit-port launches, and same-port/null-port plus incomplete-owner cases are covered. Safely reconciled terminal/expired records are removed from attention and do not block. |
| **TG2** | **Reserved CAS/store retry** | Deterministic same-process coverage proves a transient Reserved terminal CAS failure is retried without deleting credentials before terminalization. A permanent store outage remains retained attention and is bounded by explicit retry scheduling. |
| **TG3** | **PID reuse during health** | Pre-health and post-health identity checks are covered in unit paths; no native test replaces the PID/port occupant during the in-flight health request. |
| **TG4** | **sequence desync after server crash** | MAC/sequence and reconnect behavior are covered for response loss; the client marks the sent side effect ambiguous and does not replay that side-effecting RPC. Lifecycle reconciliation may retry safe authoritative inspection. A native crash interleaving remains unverified. |
| **TG5** | **orphan credential cleanup** | Terminal attention cleanup is retryable and protected from periodic record deletion. A directory-wide scan for credentials whose record is missing remains outside this focused reviewer-fix scope. |
| **TG6** | **concurrent spawn** | Queue/CAS and some launch-race behavior are covered; no complete concurrent spawn test proves that two callers cannot both pass admission when one record has incomplete port/identity state. |
| **TG7** | **Windows-specific coverage** | Existing Windows handle-helper/ACL seams remain covered, while the current uncommitted guardian regressions that require POSIX sockets are guarded with `skipIf(process.platform === 'win32')`. They are local POSIX evidence, not native Windows evidence; native Windows rehydration, process replacement, and termination races remain unverified. |

The current uncommitted tests cover fail-closed admission, Reserved CAS/store
retry and credential retention, production SQLite protection/eviction,
GuardianClient response loss/disconnect/ambiguity, lifecycle ambiguity through
initial spawn and HMR/bootstrap/restart cleanup, strict revision/lease/MAC and
owner/incarnation matching, no-fallback handoff/spawn behavior, and retained
non-ambiguous fallback. POSIX-only guardian cases are guarded with
`skipIf(process.platform === 'win32')`; they are local POSIX evidence, not
native Windows handle-helper/ACL evidence.

### Architecture notes

- **AN1 — overall design:** v2 provides private master-secret, encrypted
  credential, SQLite record, lease, and CAS ownership; guardian provides child
  lifecycle, authenticated RPC, health, and cleanup; lifecycle provides web
  startup/restart/adoption wiring; CLI provides administrative control. The
  separation is sensible; C1 now treats unresolved attention as an
  availability-and-ownership fence, while H3 demonstrates that credential
  recovery crosses these boundaries.
- **AN2 — v1/v2 coexistence clarity:** the v2 directory is a distinct durable
  foundation while the older handoff protocol remains a separate protocol
  surface. The split is documented by naming and state models, but both are
  handoff implementations; callers and future maintainers need an explicit
  rule that guardian lifecycle uses v2 and must not silently fall back to v1
  records or semantics.
- **AN3 — IPC transport test fragility:** the Node boundary tests exercise real
  helper/socket process behavior, while injected seams cover platform-specific
  failure paths. Bun cannot provide equivalent transferred-`net.Socket`
  coverage, and native Windows transport/rehydration remains absent, so the
  suite is valuable but platform-fragile rather than complete.

### Merge blockers and disposition

- **C1 disposition:** resolved with the selected fail-closed policy: every
  unresolved attention record blocks admission, regardless of port or owner
  fields; only terminal records with authoritative cleanup may unblock, while
  expired operations remain blocked until quiescence and exact CAS resolution.
- **Preserved follow-up evidence risk:** **H1** still lacks native
  PID-reuse-during-health evidence; no change here weakens its pre/post identity
  fences.
- **H3** now retries a Reserved terminal CAS/store failure in-process, retains
  attention and credentials until terminalization succeeds, and leaves a
  bounded explicit retry schedule when the failure persists; a full
  process-crash/orphan scan remains a separate evidence gap.
- **H5** now preserves the stable non-replayable ambiguity contract through every
  lifecycle entrypoint and blocks duplicate stop/spawn/rollback or legacy
  fallback until an owner-scoped fence is authoritatively reconciled. Bounded
  reconciliation retries inspection/adoption without replaying the ambiguous
  RPC. Exact
  revision/lease/MAC binding is fail-closed; exactly-once side effects are not
  claimed and no broad idempotency redesign was added.
- **Native Windows rehydration and bundled web E2E remain unverified**; no CI
  evidence was produced in this session.

### Exact validation evidence available in this session

- `bun run --cwd packages/web test -- server/lib/guardian/guardian.test.js --pool=threads --maxWorkers=1`: **94 passed**.
- `bun run --cwd packages/web test -- server/lib/opencode/lifecycle-guardian-integration.test.js server/lib/opencode/lifecycle.test.js server/lib/opencode/hmr-state-runtime.test.js --pool=threads --maxWorkers=1`: **88 passed**.
- `bun run --cwd packages/web test -- server/lib/opencode/managed-opencode-handoff-v2/store.test.js server/lib/opencode/managed-opencode-handoff-v2/protocol.test.js --pool=threads --maxWorkers=1`: **20 passed**.
- `bun run --cwd packages/web test -- server/lib/guardian/health-client.test.js --pool=threads --maxWorkers=1`: **4 passed / 2 skipped** (platform-gated).
- `node --check` on the 17 JavaScript inventory files: **clean**.
- `bun run type-check:web`: **passed**.
- `bun run lint:web`: **passed** (web package TypeScript/TSX lint configuration).
- `bun run docs:validate`: **passed** after this documentation update.
- `git diff --check`: **passed**.
- No CI, native Windows, or bundled-web process-boundary command was run in this session; those remain unverified.

These results do not prove native Windows rehydration, bundled web E2E,
PID-reuse races, directory-wide orphan cleanup, or exactly-once IPC side effects.

## Latest lifecycle-safety follow-up — 2026-08-05

- Ambiguous owner-scoped `stop` and `abort-handoff` cleanup responses now
  persist the same H5 owner fence as prepare/spawn ambiguity. Reconciliation
  never repeats the uncertain cleanup or enters rollback/legacy fallback until
  the exact terminal/post-transition record is authoritative; an ambiguous
  abort that still observes `handoff-prepared` remains blocked and is never
  issued a second abort.
- Every direct owner-scoped stop consults the persisted fence before issuing a
  stop RPC, so repeated stop calls cannot replay an ambiguous side effect.
- Adoption requires complete revision/lease/MAC binding on expected and
  observed records. The final decision uses authenticated guardian-side
  credential/health revalidation followed by a v2 same-record CAS; record,
  credential, and health mutation-after-read regressions fail closed.
- H3 retry scheduling is retained across Reserved → Interrupted/Retired
  terminalization when credential removal fails. Attention and the encrypted
  credential remain until the bounded same-process retry succeeds.
- New deterministic coverage is in
  `lifecycle-guardian-integration.test.js` (ambiguous stop, repeated direct
  stop, ambiguous abort while prepared, delayed successor, binding race),
  `detection.test.js` (missing binding fields), `protocol.test.js` (CAS race),
  and `guardian.test.js` (credential/health mutation races and terminal
  cleanup retry). Local platform gaps remain unchanged: native Windows rehydration and
  termination races, bundled-web process-boundary E2E, native H1 interleaving,
  directory-wide orphan scans, and exactly-once side effects are not claimed.
- Follow-up local evidence from that earlier scope is historical; the current
  21-file follow-up validation is recorded in the final section below.

## Final high-severity follow-up — 2026-08-05

- The current uncommitted scope is exactly **21 files: 17 JavaScript and 4
  Markdown**. The verified paths are the 17 JavaScript paths and 4 Markdown
  paths listed in the current audit above; no other worktree paths are claimed.
- Lifecycle fence adoption now calls guardian-side `confirmAdoption()`, which
  owns final credential/health revalidation and the v2 same-record CAS. The
  lifecycle CAS regression proves confirmation is invoked and a binding
  mutation keeps the fence and leaves the process unpublished.
- Ambiguous stop reconciliation now queries the signed terminal record through
  guardian `terminalStatus()` and confirms its exact owner/incarnation/
  revision/lease/MAC through `confirmTerminal()` after the child is removed from
  the guardian live-child map. The lifecycle regression removes the terminal
  row from `list()` and proves no stop replay occurs before successor adoption;
  guardian coverage rejects wrong owner, incarnation, revision, and MAC.
- The prior focused validation is historical. The current 21-file follow-up
  validation is recorded in the final section below.
- Native Windows rehydration/termination interleavings, bundled-web
  process-boundary E2E, native H1 interleaving, directory-wide orphan scans,
  and exactly-once side-effect evidence remain unverified platform/evidence
gaps. No commit or push was performed.

## Durable-operation remediation review — 2026-08-05

The current reviewed scope is exactly **21 files: 17 JavaScript + 4 Markdown**. The canonical path inventory is maintained in `plans/issue-2421-restart-handoff/phases/phase-2e.md`; no UI, CLI, dependency, or unrelated platform files are included.

- **Fail-closed creation:** guardian operation persistence precedes spawn, stop,
  prepare, and abort lifecycle-ambiguity side effects. Invalid/unavailable
  creation fails closed and reservation cleanup is attempted inside the same
  error path; credential-removal cleanup follows its separate authenticated
  store/attention contract.
- **Prepare forwarding/discovery:** the generated operation ID crosses GuardianClient and IPC, prepare resolves to `handoff-prepared`, and owner-scoped operation discovery reconstructs a lifecycle fence before startup/fallback after HMR or web-process loss.
- **Bound resolution:** protocol and guardian verify signed operation and target bindings, distinguish absent records from read failures, permit post-pruning resolution only from an exact signed terminal record, and lifecycle confirms the durable operation/terminal CAS before clearing a fence.
- **Retention/migration:** absent terminal rows retain attention until credential cleanup is independently confirmed; expired operations remain unresolved and discoverable until guardian-authoritative quiescence plus exact binding/CAS resolution; schema `2421009` preserves `2421007` compatibility and transactionally migrates `2421008` with rollback/reopen/malformed-row coverage.

The validation totals in earlier sections are historical. The current
21-file follow-up command results are recorded below. Native Windows,
bundled-web process-boundary, native interleaving, orphan-scan, exactly-once,
and CI evidence remain explicitly unverified.

## H5 terminal-retention and startup-secret lease follow-up — 2026-08-05

- The canonical reviewer-fix inventory remains exactly **21 files: 17
  JavaScript and 4 Markdown**. The implementation stayed within the existing
  lifecycle/guardian/v2/HMR/server composition and the three canonical
  documentation files; no UI, CLI, or unrelated platform paths were added.
- Terminal `Interrupted`/`Retired` transitions now renew their signed lease
  from authoritative store time for a bounded confirmation horizon. Guardian
  cleanup can therefore prune only after that retained horizon, while
  `terminalStatus()`/`confirmTerminal()` still require exact owner, incarnation,
  revision, lease, and MAC binding. A row absent before expiry remains a stable
  fail-closed ambiguity; absence after the exact retained fence lease expires
  is the only safe fence cleanup path.
- Startup-secret leases are associated with the in-memory/HMR ambiguity fence.
  Ambiguous initial guardian spawn and direct owner-scoped stop retain the lease
  through unresolved state; authoritative adoption transfers it to the adopted
  child, and exact terminal confirmation or safe expired-fence cleanup releases
  it. Plaintext secrets remain transient and redacted.
- Focused validation from the preceding H5 scope is historical; the current
  21-file follow-up commands and counts are recorded below. The new regressions
  cover expired-operation retention/quiescence and terminal operation CAS
  retry, in addition to the prior H5 coverage.
- Native Windows rehydration/termination interleavings, bundled-web
  process-boundary E2E, native H1 interleaving, directory-wide orphan scans,
  and exactly-once side-effect evidence remain unverified platform/evidence
  gaps. No commit or push was performed.

## Latest durable-operation review remediation — 2026-08-05

- Expired operations remain unresolved and discoverable. The confirmation
  horizon only records `expired`; lifecycle reconciliation cannot clear the
  H5 fence until guardian quiescence and exact signed target/terminal evidence
  pass the owner/incarnation/revision/lease/MAC-bound operation CAS.
- Terminal rows are retained while pending/expired operations reference them.
  Natural exit and stop retain attention, child entries, and operation IDs
  until durable resolution succeeds; read/CAS failure is retryable retention,
  not absence-as-success. Credential material remains protected by the
  authenticated credential-store removal/absence contract.
- Operation-fencing documentation is intentionally limited to lifecycle
  ambiguity side effects (spawn/stop/prepare/abort). Credential-removal and
  terminal cleanup use the credential store's authenticated idempotent cleanup
  and guardian attention retention instead of claiming operation-table fencing.

Final validation for this current **21-file (17 JavaScript + 4 Markdown)**
scope:

- `bun run --cwd packages/web test -- server/lib/guardian/ server/lib/opencode/managed-opencode-handoff-v2/ server/lib/opencode/lifecycle.test.js server/lib/opencode/lifecycle-guardian-integration.test.js server/lib/opencode/hmr-state-runtime.test.js --pool=threads --maxWorkers=1` — **636 passed / 3 skipped** across 24 files, including overlapping operation retention, post-pruning tombstone, and stop-verification/no-duplicate-stop regressions.
- `bun run --cwd packages/web test:node-boundary` — **7 Vitest + 17 node:test passed**.
- 17 inventory JavaScript files with `node --check` — **clean**.
- `bun run type-check:web`, `bun run lint:web`, `bun run docs:validate` (**450 pages / 45 sidebar links**), and `git diff --check` — **passed**.

Native Windows, bundled-web process-boundary, native interleaving, orphan-scan,
exactly-once, and CI evidence remain explicitly unverified.

## H5 retention/liveness follow-up — 2026-08-05

- Guardian attention/child state now carries all outstanding operation IDs for
  an incarnation. A later stop, abort, or cleanup result cannot overwrite a
  pending spawn/prepare operation; restart discovery restores every pending or
  expired operation and clears retention only after all resolve authoritatively.
- Resolved signed operation rows are retained as owner/incarnation/target/
  resolution-bound tombstones after terminal-row pruning. HMR reconciliation
  can therefore prove resolution after restart without treating ordinary
  absence as success; wrong binding and read failure remain blocked.
- A successful stop followed by stale/malformed/failed list verification keeps
  the durable stop fence and startup-secret lease. The stop RPC is not replayed;
  only authoritative terminal/quiescence confirmation can clear the fence.
- The exact current inventory remains **21 files (17 JavaScript + 4 Markdown)**;
  no UI, CLI, dependency, or unrelated platform file is included.
- Validation: process-boundary **7 Vitest + 17 node:test**, 17 JavaScript
  syntax checks, web type-check/lint, docs validation (**450 pages / 45
  sidebar links**), and `git diff --check` passed.

## Latest lifecycle-operation remediation — 2026-08-05

- HMR discovery no longer returns early when a transferred fence exists. It
  lists and merges the complete owner-scoped pending/expired operation set, so
  an undiscovered durable operation remains an admission blocker.
- Initial-spawn terminal cleanup declares and binds its fence before use, then
  confirms the exact resolved terminal operation before releasing the associated
  startup-secret lease. Durable terminal reconciliation rejects stale or
  replaced owner/incarnation/revision/lease/MAC bindings.
- Guardian retains failed `beginStopping`, `prepareHandoff`, and `abortHandoff`
  operations in durable attention immediately. Rehydration restores those
  operation IDs before child interpretation, and fail-closed launch admission
  blocks a different-port launch until all unresolved IDs resolve.
- The exact current inventory remains **21 files: 17 JavaScript + 4
  Markdown**.
- Final validation: focused lifecycle/guardian/v2/HMR/IPC command **643 passed
  / 3 skipped** across 24 files; process-boundary **7 Vitest + 17 node:test**;
  17 inventory JavaScript syntax checks; `bun run type-check:web`;
  `bun run lint:web`; `bun run docs:validate` (**450 pages / 45 sidebar
  links**); and `git diff --check` all passed.
- Remaining evidence gaps are unchanged: native Windows rehydration and
  termination interleavings, bundled-web process-boundary E2E, native H1
  interleaving, orphan scans, exactly-once side effects, and CI evidence.

## Latest lifecycle admission and lease cleanup findings — 2026-08-05

- **Global admission:** direct legacy startup/restart fallback now queries the
  guardian's authenticated global admission status before closing or spawning.
  The status includes all unresolved attention and pending/expired durable
  operations; foreign owners and unrelated ports are intentionally not filtered.
  Exact owner-scoped adoption remains a separate path.
- **No-successor cleanup:** after a confirmed old-child stop and a
  non-ambiguous successor spawn failure, lifecycle performs a fresh authenticated
  empty successor check, verifies no matching unresolved operation/fence, and
  releases that launch's startup-secret lease exactly once. Ambiguous,
  malformed, unavailable, or unresolved outcomes retain the lease.
- **Regression evidence:** lifecycle integration covers foreign attention with
  no exact owner and proves no legacy spawn, confirmed no-successor zero-lease
  cleanup, and ambiguous successor-failure lease retention. The exact current
  inventory remains 21 files (17 JavaScript + 4 Markdown); no commit or push was
  performed.
- **Current validation:** focused guardian/lifecycle/detection/v2/HMR/IPC
  command **645 passed / 3 skipped** across 24 files; process-boundary **7
  Vitest + 17 node:test passed**; 17 JavaScript syntax checks; web
  type-check/lint; docs validation (**450 pages / 45 sidebar links**); and
  `git diff --check` passed.
