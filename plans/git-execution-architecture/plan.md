# Git Execution Architecture

## Status

- Completed phases: Phase 1 — bounded process-local execution; Phase 2 — web/server migration plus verification/review closure; Phase 3 — VS Code extension-host Git execution parity; Phase 4 — real-Git execution harness; Phase 5 — exact pre-architecture/current/current+fsmonitor web Git service comparison.
- Active phase: none. Phase 6 shared web/VS Code Git execution core consolidation is locally complete and validated; publication has not started.
- Branch context supplied by the orchestrator: `feat/2233-git-execution`, based on PR #2232 head.
- Phase 6 changes only the approved shared core, VS Code facades, focused tests/harness, owning docs, and canonical plan state. Dependencies, package manifests, UI/public API behavior, conflict resolution, commits, pushes, PR mutation, and `../opencode` remain outside this work package.

## Why the original issue design was rejected

A total one-subprocess FIFO per `git-common-dir` is not a safe or scalable execution model:

- It causes head-of-line blocking between independent linked worktrees.
- It conflates distinct worktree indexes even though each linked worktree has its own Git directory and index.
- Cancellation is unsafe and underspecified: abandoning a waiter cannot imply that an admitted mutation stopped.
- Promise-chain queues and identity maps have unbounded process lifetimes without explicit limits or eviction.
- A durable process-local status snapshot has stale invalidation semantics when Git is changed externally.
- A process-local queue cannot provide the proposed cross-process guarantee; Git's own locking remains authoritative across processes.

## Corrected invariants

1. **Identity**
   - Common context identity is the canonical `git-common-dir`.
   - Worktree identity is the canonical worktree Git directory plus canonical top-level.
   - Subdirectories, symlinks, linked worktrees, relative Git output, and Windows case folding converge on those identities.
   - `isGitRepository` returns `false` for a missing path or a confirmed non-repository diagnostic; spawn, permission, and malformed discovery failures remain failures.

2. **Discovery**
   - Context discovery is dependency-injected, globally bounded to two operations, and single-flight per canonical input alias.
   - Discovery runs outside the execution coordinator and never recursively schedules itself.
   - Resolver queues and maps have explicit count limits and drain cleanup; no session identity is retained.

3. **Execution conflicts**
   - Reads may share a common context up to the read cap, but cannot overlap a same-worktree write.
   - Worktree-local writes conflict with reads/writes for the same worktree, not unrelated linked worktrees.
   - Common ref/config writes serialize with other common writes; common+target writes also exclude local work for their target worktree.
   - Topology writes are barriers for every operation in their common context.
   - Earlier conflicting writes block later reads, preventing writer starvation without imposing total FIFO head-of-line blocking.
   - Compound operations execute under one outer lease and pass it to unscheduled core helpers; those helpers do not reacquire nested reads. Incompatible re-entry fails instead of deadlocking.

4. **Bounds and overload**
   - Global active operations: `min(8, max(2, availableParallelism))`.
   - Reads per common context: 2.
   - Network operations: 1 per common context and 2 globally, including clones.
   - Discovery concurrency: 2.
   - Pending operations: 64 per common context and 2,048 globally.
   - Clone reservations: 256 pending globally, 16 pending per destination, and 256 active destination identities.
   - Context, worktree, discovery, and status in-flight maps have explicit count bounds and cleanup.
   - Overload, cancellation, queue timeout, and incompatible re-entry use structured internal error codes while existing route envelopes stay unchanged.

5. **Freshness and cancellation**
   - Mutation generations advance on admission and on every completion, including failure/cancellation.
   - Status coalescing is in-flight only and keyed by worktree identity, light/full shape, and relevant common/worktree generations.
   - Full status work may satisfy a light waiter after projection; light work never satisfies full.
   - Failed status work is removed immediately. Cancelling one waiter never cancels shared work or another waiter.
   - The architecture deliberately has no durable `SnapshotStore` or watcher because this process cannot safely observe every external Git mutation.

6. **Compatibility**
   - Existing route/API response shapes and web/Electron behavior remain stable.
   - Read-class subprocesses receive `GIT_OPTIONAL_LOCKS=0` only for that operation; mutations do not inherit it.
   - Manually configured `core.fsmonitor` passes through to Git unchanged across web/Electron and VS Code; OpenChamber neither mutates nor manages it.
   - No internal identity, generation, queue, or lane controls are exposed to users.

## Performance contract

- Interaction: status refresh, diff inspection, staging, unstaging, hunk/file discard, and commit must remain responsive under fan-out.
- Representative entity scale: 30,000 logical session records, 200 independent common directories, and 100 additional linked worktrees modeled as 300 worktree identities.
- Caller scale is separate: startup uses 300 callers; a 30,000-caller burst is a pathological fan-out correctness guard, not representative simultaneous activity.
- Cost model: session entities → unique worktree identities → scenario-declared logical callers → coordinator API submissions → underlying scheduled operations → direct Git children. Entity mapping itself performs zero submissions, scheduled operations, or Git commands.
- Deterministic guards assert operation counts, concurrency caps, fairness, cleanup, and bounded maps rather than wall-clock speed.

## Phased path

### Phase 1 — completed

- Add the bounded resolver and execution coordinator.
- Replace PR #2232's promise-chain queue for status and local index/worktree mutation paths.
- Add per-operation read-only Git environment, generation-aware status coalescing, structured internal failures, deterministic unit tests, and the synthetic scale test.
- Preserve routes and visible behavior.

Phase 1 completed on 2026-07-15 with focused resolver/coordinator/service/route tests green.

### Phase 2 — completed

- Classify and migrate every remaining Git service operation and owned web-server Git subprocess.
- Add explicit common/ref/config, topology, network, and pre-repository clone/destination resources while retaining worktree-local progress.
- Make context/lease reuse, authoritative repository detection, normal-admission idle pruning, and bypass ownership test-visible.
- Keep completed-result caching blocked; Phase 2 does not add snapshots/watchers.

Phase 2 verification closed on 2026-07-16 with 145 focused tests green, runtime syntax checks green, web type-check/lint green, and root-scoped no-install dead-code analysis inspected.

The closure added executable skills-catalog reservation coverage, guaranteed post-lease fast-create background admission, structured validation-error propagation, explicit core-helper lease reuse, side-effect-free diagnostics, FS timeout cleanup coverage, and stale composition cleanup. Legacy `getWorktrees` empty-on-failure behavior remains unchanged as a separately gated external-contract risk.

### Phase 3 — completed: VS Code extension-host parity

- Add package-local context resolution, execution coordination, closed operation/owner classification, and a service facade that acquires one top-level lease before the built-in Repository API/raw fallback decision.
- Migrate extension-host raw Git owners and skills-catalog clone reservations while preserving existing RuntimeAPI/BridgeResponse behavior and explicit bypasses.
- Add runtime-specific deterministic, scale, compatibility, type, lint, and build validation without moving server-owned behavior into shared UI.

Phase 3 started on 2026-07-16 after exhaustive imports confirmed that `bridge-git-runtime.ts` and `bridge-git-special-runtime.ts` are the only direct `gitService.ts` consumers. A raw-only design was rejected because the built-in Repository API is the preferred execution path and must share the same outer lease as raw fallback, recovery, and cleanup.

Phase 3 completed on 2026-07-16 with all 51 service operations executable through the injected facade suite, actual imported function exports reflected semantically, direct raw owners scanned with the TypeScript AST, and the pathological 30,000-caller fan-out fixture asserting exact counts, generations, cleanup, bounds, and identity behavior while deterministic fairness remains independently covered. The final bridge/facade follow-up passed 17 tests with 173 assertions; its isolated production-listener case passed 1 test with 7 assertions. `bun test src` passed 84 tests with 837 assertions across 18 files. Type-check, lint, and production build passed. Root-scoped no-install Knip returned the established 189-file/304-export/176-type baseline plus five configuration hints and its stale-install warning, with no new Phase 3 finding. The conditional shared-web regression was not run because no shared web file changed.

### Phase 4 — complete

- Add a standalone real-Git performance harness with `pr-real`, `target-real`, `soak`, and `cap-sweep` profiles.
- Keep production scheduler/service behavior and defaults unchanged; use web real-Git primitives plus deterministic VS Code coordinator parity.
- Make cardinality, coalescing, caps, fairness, generations, errors, drain, maps, FDs, child ownership, and cleanup blocking while latency remains advisory.
- Emit JSON to stdout by default, never commit generated reports/fixtures, and add no CI workflow in this phase.

Phase 4 explicitly distinguishes the 30,000 session-entity target from concurrent callers. The existing synthetic 30,000-caller tests are retained as pathological fan-out correctness guards rather than treated as a realistic concurrency benchmark.

The initial schema v1 Phase 4 implementation/local validation completed on 2026-07-16 without production scheduler/service changes, dependencies, telemetry hooks, CI workflows, or committed generated artifacts. Its three-test/profile results are retained only as history and are superseded by the schema v2 review closure below.

Independent testing then identified four report-contract gaps: aggregate callers duplicated API submissions, coalesced fan-out omitted waiter-observed latency, Git safety was declared rather than runtime-guarded, and Git spawn accounting was not a closed exact taxonomy. Phase 4 is reopened only for those harness/test/documentation fixes; production behavior remains out of scope.

The schema v2 closure removes the aggregate caller field, snapshots zero-work entity mapping, declares callers per scenario, records exact all-waiter totals separately from underlying task latency, enforces executable pre-spawn/output safety guards, and blocks on a complete six-category Git-command equation plus exact operation classes and success/failure counts. Focused tests and all requested local profiles passed. The independent default soak then exposed that paced same-generation status callers could coalesce according to real Git duration while the reviewed equation assumed one task per caller. Phase 4 is reopened only to precompute deterministic status waves/groups and make that immutable plan drive submissions, scheduled-operation counts, generation expectations, and Git-command accounting.

The correction is locally complete. The default seed now precomputes 6,000 callers/API submissions, 3,279 status callers in 1,869 groups, 4,590 scheduled operations, 4,754 Git commands, and generation movement 3,116. Separate status groups and local mutations are ordered per worktree; fetch/topology events are common-context barriers; unrelated contexts retain concurrency. Repeated real-Git tests with deliberately variable status delays, the normal reduced topology/idle soak, `pr-real`, reduced target, and cap sweep all pass. Production scheduler/service behavior remains unchanged.

Independent testing first passed the schema-v2 target and corrected default soak, then final hardening added a harness-owned per-child timeout/reap contract, rejection of soak-only flags on other profiles, and an executable normal-test-discovery guard. Every Git child now has a configurable 60,000ms default timeout, owned POSIX process-group/exact-Windows-child termination, a 1,000ms graceful close window, force-only escalation, and close/reap-balanced metrics. The focused entrypoint plus package-script inventory prevents implicit full-profile discovery.

Final-code full-profile evidence passes. Target reports 30,962 API submissions, 1,262 scheduled operations, 2,876 Git commands, 30,000/300 fan-out waiter/underlying samples, generation movement 1,324, zero child timeouts, zero unexpected errors, and successful cleanup. The corrected default soak reports 6,000 API submissions, 4,590 scheduled operations, 4,754 Git commands, 3,279 status callers in 1,869 groups, generation movement 3,116, zero child timeouts, zero unexpected errors, and successful cleanup. Generated reports remain local, non-durable, and uncommitted; their evidence paths are recorded only in the handover. The earlier failed soak remains non-passing, is superseded by the final corrected soak, and is excluded from PR evidence.

The focused harness passes 12/12, and harness type-check/lint pass. `pr-real`, the short topology/idle soak, docs validation, and dead-code inspection also pass. Production scheduler/service behavior remains unchanged.

### Phase 5 — complete: before/after/after+fsmonitor service comparison

- Run the exported web Git service from `4c2f8946b`, the direct parent of the architecture commit, and the current service through one deterministic public-operation workload.
- Model 30,000 session entities, 200 common directories, 100 linked worktrees, and 300 worktree identities without treating entity mapping as 30,000 simultaneous Git callers.
- Verify status identity and final staged state before interpreting performance results.
- Measure end-to-end latency and exact top-level Git launches with the same lightweight PATH shim for all targets. Keep fixture/setup and oracle Git outside the measured workload.
- Keep the pathological 30,000-caller workload a separate explicit profile with isolated timeout/failure reporting. Submit it in reviewed 600-caller waves so the legacy source cannot create one unsafe 30,000-process burst; do not present it as equivalent to the current-only simultaneous fan-out guard.
- Use the same installed dependency tree for both service sources so the comparison isolates the architecture/source change. Record that this is controlled approximate evidence, not a historical-machine reconstruction.
- Add no production hook, scheduler behavior change, dependency, CI workflow, committed generated report, or machine-specific pass/fail threshold.
- Run a third isolated target only against the current service with fixture-local manual `core.fsmonitor`/protocol-v2 hook configuration. Measure cold and unchanged warm status for every target, verify the hook/config contract, and keep production fsmonitor management out of scope.

Phase 5 completed on 2026-07-18 and its three-way follow-up supersedes the earlier two-target evidence. Both representative run orders passed with 1,667 correctness checks before/after and 1,874 after+fsmonitor, exact topology/cardinality, zero unclassified launches, and cleanup. Top-level Git launches were 7,320 before versus 5,760 after and after+fsmonitor (21.311% fewer); measured duration ranges were 15,988.804–16,281.249ms, 22,563.860–22,643.539ms, and 23,655.630–24,087.816ms respectively. The third target preserved manual config and recorded exactly 1,860 protocol-v2 hook invocations in each order. The separately labeled 30,000-caller/600-caller-wave profile passed 61,668 checks before/after and 61,875 after+fsmonitor: 919,602.404ms / 34,040.489ms / 37,616.044ms, 217,320 / 7,560 / 7,560 top-level Git launches, and 17,221.023ms / 236.764ms / 247.857ms fan-out p95. The deterministic shell hook adds process overhead on this tiny-per-repository fixture, so no universal fsmonitor speedup is claimed. Raw reports remain local and uncommitted.

### Phase 6 — complete: shared web/VS Code Git execution core

- Keep the existing web ESM resolver, coordinator, and structured-error paths as the canonical runtime-neutral implementation so the unbundled published web server continues to include and execute them directly.
- Add sidecar TypeScript declarations and replace the three VS Code implementation copies with thin explicit re-export facades. The existing VS Code esbuild step bundles the canonical source; no package dependency, generated copy, or server build step is added.
- Preserve package-local service adapters, operation/owner inventories, built-in/raw fallback behavior, background worktree scheduling, command primitives, route/bridge envelopes, and compatibility fallbacks.
- Reconcile known implementation drift before deleting a copy. In particular, canonical settlement must preserve every Promise rejection reason, including falsy values, while retaining the web runtime's argument and identity validation.
- Update deterministic harness terminology from independent web/VS Code parity to web-direct/VS Code-adapter provenance while retaining both loader paths and all existing real-Git safety/accounting contracts.
- Keep duplicate package tests for the first extraction as cross-runtime adapter/build evidence even though production resolver/coordinator/error logic becomes singular.

Phase 6 completed locally on 2026-07-18. The existing web ESM files are now the single resolver/coordinator/error implementation with strict declaration sidecars; the VS Code paths are explicit typed re-export facades bundled into the extension. Runtime-specific adapters/classifications remain separate. Canonical settlement now preserves falsy rejection reasons, and the harness blocks on shared class/factory/constant/error identity before replaying both import paths. Web focused tests passed 108/108 plus 5/5 routes; VS Code focused tests passed 42/42 and its full suite passed 89/89 with 865 expectations; the performance harness passed 12/12 and `pr-real` passed with 31 Git commands, zero unexpected errors/timeouts, and cleanup. Workspace type-check/lint, affected builds, package inspection, docs validation, syntax/diff checks, and non-blocking dead-code inspection passed or matched the documented result. No dependency, manifest, UI/public API, generated source, commit, push, or PR body changed.

The detailed scope, implementation, and exact validation are in [`phases/phase-6.md`](./phases/phase-6.md), [`implementation/phase-6-impl.md`](./implementation/phase-6-impl.md), and the latest handover.

## Stop conditions

- Do not claim cross-process serialization.
- Do not add completed-result caching without an authoritative external invalidation source.
- Block the next phase if deterministic cleanup, fairness, route compatibility, or focused service tests are not green.
- Do not change production scheduler/service behavior, add telemetry hooks, or make single-host absolute latency PR-blocking in Phase 4.
- Do not introduce a new workspace package, package dependency, generated source copy, or public execution API to share the Phase 6 core without separately approved scope.

## Phase 2 entry conditions (satisfied)

- Phase 1 has no failing validation that blocks beginning Phase 2.
- A completed-result status snapshot remains blocked until an authoritative external-mutation invalidation source exists.
- Phase 2 must classify each remaining operation before migration; it must not treat the current worktree lane as implicit coverage for network or topology mutations.
- Cross-process ordering must continue to rely on Git's locks rather than being claimed by the process-local coordinator.

## Phase 2 reviewer constraints

- Full-status local config reads, `remote get-url`, `show-ref`, `rev-parse`, and comparisons against existing remote-tracking refs do not perform network I/O; only `ls-remote`, fetch, pull, push, and clone take network capacity.
- Slow network capacity alone must not form a total common-context barrier.
- User-authored shell execution, Git hooks/helpers, bootstrap discovery, and external processes are explicit non-guarantees rather than silently classified operations.
- Phase 3/VS Code remains separate until web/server coverage is complete and green.
