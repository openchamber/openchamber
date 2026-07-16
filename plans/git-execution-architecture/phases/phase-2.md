# Phase 2 — Complete Web Git Operation Migration

Status: **complete; verification/review closed (2026-07-16)**

## Goal

Migrate every OpenChamber-owned Git operation in the web server to explicit bounded execution resources while preserving existing routes, response shapes, failure signals, and web/Electron behavior.

## Reviewer findings addressed by this phase

- Remaining stash, branch/checkout/reset, cherry-pick/revert, merge/rebase/continue, network, worktree, ref, config, history, and helper subprocesses can currently bypass coordination and race.
- Full status uses local `remote get-url`, remote-tracking ref, and revision probes; these do **not** contact remotes. Actual network operations are `ls-remote`, fetch, pull, push, and clone.
- Compound helpers need an obvious outer-lease/unscheduled-core contract.
- `isGitRepository` must distinguish confirmed non-repository results from infrastructure or malformed discovery failures.
- Idle TTL pruning must run during ordinary admissions rather than only on new-context admission or diagnostics.
- Scale coverage needs mixed reads/mutations and generation/fairness assertions.

## Resource model

The coordinator remains explicit rather than becoming a generic reader/writer lock:

1. **Read / local observation**
   - May share a common context up to the read cap.
   - Cannot overlap a write targeting the same worktree.
   - Receives operation-scoped `GIT_OPTIONAL_LOCKS=0`.

2. **Worktree-local write**
   - Exclusively owns one worktree's index/HEAD/working tree.
   - May progress beside local work in a distinct linked worktree when no shared ref/config resource is touched.

3. **Common/ref/config mutation**
   - Serializes shared refs/config mutations within one common context.
   - May additionally own a target worktree for commit/pull/merge-like compounds.
   - Does not block unrelated observations merely because it carries a slow network modifier.

4. **Topology-exclusive barrier**
   - Excludes every operation in the common context while worktree topology or maintenance is changed.
   - Invalidates only identities made stale by successful/partially successful topology work.

5. **Network modifier**
   - Capacity: one per common context and two globally.
   - Combines with a base profile; it is not itself a total context lock.

6. **Clone/destination reservation**
   - Applies before a common Git directory exists.
   - Same canonical destination is exclusive; all reservations/maps/queues are explicitly bounded and network-capped.

## Preliminary service classification

The owning documentation receives the final exhaustive table. Implementation starts from these rules:

- **Bootstrap discovery:** `isGitRepository`, top-level/common-dir resolution. Runs outside the coordinator by design so discovery cannot recursively schedule itself.
- **Read:** status/diff/history/show/log/stash listing/counts/remotes/remote URL/branch or worktree listing/conflict details/identity reads.
- **Worktree write:** stage, unstage, hunk/file discard, detached checkout, no-commit revert.
- **Common + target worktree:** commit, branch checkout/create, cherry-pick, reset, stash mutations, merge/rebase/continue/abort, pull.
- **Common only:** config/identity writes, ref deletion/rename, remote config mutation, fetch, push, remote branch deletion, integration planning when it materializes a local tracking branch.
- **Topology:** worktree add/remove/prune, temporary integration worktrees, and their Git recovery/cleanup.
- **Network:** `ls-remote`, fetch, pull, push, clone, and operation paths that can execute them.
- **Memory/pure:** bootstrap status lookup and pure ref-selection helper; no Git subprocess exists to schedule.

## Web-server direct Git inventory

- `git/service.js`: owning repository operations; all non-bootstrap subprocesses migrate under classified outer operations.
- `fs/routes.js`: owned `/api/fs/clone` uses bounded destination reservation and `/api/fs/list` delegates ignore probes; arbitrary `/api/fs/exec` remains an explicit user-authored shell bypass.
- `fs/search.js`: owned `git check-ignore` migrates to a classified observation.
- `skills-catalog/git.js`: owned clone and temporary-repository commands migrate to clone/repository scheduling; `git --version` remains a capability-probe bypass.
- `notifications/template-runtime.js`: direct branch `rev-parse` is replaced by the classified Git service status path.
- Git subprocesses in tests are test fixtures, not runtime bypasses.

## Explicit non-guarantees/bypasses

- Git hooks, credential helpers, transport helpers, and processes spawned by Git execute under Git's process tree but are not individually scheduled.
- External Git processes remain outside OpenChamber's process-local coordinator; Git lock files are authoritative.
- User-authored `/api/fs/exec` and worktree start commands can invoke arbitrary tools, including Git, and are documented—not parsed into scheduler profiles.
- Context discovery and `git --version` capability checks run before a repository identity exists and never recursively acquire execution resources.

## Acceptance criteria

1. Every exported `service.js` operation has a checked classification or an explicit no-subprocess/bootstrap bypass.
2. Every OpenChamber-owned runtime Git subprocess outside `service.js` is migrated or appears in the explicit bypass table.
3. All five repository resource combinations plus clone reservations have deterministic conflict/cap/fairness tests.
4. Compound mutations hold one lease through validation, mutation, fallback, recovery, and cleanup; nested incompatible acquisition fails immediately.
5. Genuine reads alone receive optional-lock suppression.
6. Every migrated mutation advances relevant generations on admission and completion/failure/cancellation.
7. Topology invalidation removes only stale retained worktree identities; no completed-result cache/watcher is added.
8. Missing paths and confirmed non-repositories return `false`; spawn, permission, and malformed discovery failures throw.
9. Throttled lazy pruning executes during normal admission with no perpetual timer; hard count bounds remain authoritative.
10. The seeded pathological 30,000-caller fan-out workload respects global/read/network/conflict caps, writer fairness, generations, and cleanup without claiming representative session concurrency.
11. Existing service/route contracts and focused regressions remain green.

## Stop conditions

- Stop on any operation whose real resource behavior cannot be classified safely; report that operation rather than guessing.
- Do not move into VS Code or Phase 3.
- Do not add completed-result snapshots, repository-state services, or watchers.
- Do not claim control over hooks/helpers/external processes or cross-process ordering.

## Completion result

- Every exported Git service operation has a machine-checked classification; direct runtime owners and bypasses have a closed inventory.
- Web-server service, FS clone/list/search, skills-catalog, and notification Git ownership are migrated.
- Coordinator profile, network, clone, timeout, pruning, generation, topology, cancellation, lock propagation, and pathological 30,000-caller fan-out coverage is green.
- Final focused validation: 145 tests passed, 0 failed, 647 assertions across 10 files, including executable skills-catalog scan/install coverage.
- Runtime syntax checks, `bun run type-check`, and `bun run lint` passed.
- Root-scoped cached no-install Knip completed with 189 unused files, 304 unused exports, and 176 unused exported types, plus the expected stale-cache warning.
- Fast-create background attachment is admitted only after the outer topology lease settles; validation cores reuse their existing common/topology lease and preserve `GIT_EXECUTION_*` errors.
- `getStats()` is side-effect-free; throttled admission/drain pruning remains effective without a timer loop.
- Legacy `getWorktrees` empty-on-failure behavior is documented but unchanged. Completed-result caching remains blocked and Phase 3 is unstarted.
