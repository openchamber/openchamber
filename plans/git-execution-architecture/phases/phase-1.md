# Phase 1 — Bounded Process-Local Git Execution

Status: **complete (2026-07-15)**

## Goal

Deliver a production-usable server slice that removes the total `git-common-dir` FIFO introduced by PR #2232 while preserving existing API and runtime behavior.

## In scope

- Canonical, injected Git context discovery.
- Bounded conflict-aware execution for status, diff reads needed by the current Git panel, stage, unstage, commit, hunk application, and file revert paths.
- Worktree-local concurrency with common/topology barrier capability.
- Writer fairness and explicit backpressure.
- Per-operation optional-lock suppression for read-only status/diff work.
- In-flight-only full/light status deduplication with generation invalidation.
- Deterministic correctness/resource tests and a seeded synthetic scale model.

## Out of scope

- A durable status snapshot/cache or filesystem watcher.
- A cross-process scheduler guarantee.
- Complete migration of every branch, stash, history, network, merge/rebase, and worktree operation.
- Network/topology lane rollout.
- VS Code parity implementation decisions.
- UI, route shape, public API, dependency, or persistence changes.

## Acceptance criteria

1. Canonical identities converge for aliases, subdirectories, symlinks, and linked worktrees.
2. Discovery never exceeds two active operations, is single-flight, bounded, and cleans up.
3. Same-worktree reads and writes do not overlap; distinct linked-worktree local operations can progress.
4. Common writes serialize their entire common context; earlier conflicting writes cannot starve.
5. Queue overload and queued cancellation are structured and deterministic.
6. Mutation generations change on admission and completion/failure.
7. Full/light status coalescing obeys directionality, does not cache failures, and isolates waiter cancellation.
8. All coordinator/resolver/status maps and queues are bounded and contain no session-derived keys.
9. The pathological 30,000-caller seeded fan-out guard respects operation/concurrency bounds and drains to empty/bounded state without real Git fan-out; it is not representative session concurrency.
10. Existing focused service and route tests remain green, and module documentation distinguishes implemented Phase 1 from later work.

## Risks and controls

- **External Git mutation:** no completed-result cache is introduced.
- **Unsafe cancellation:** only queued work is removable; admitted running mutations settle normally. Shared status waiter cancellation is local to that waiter.
- **Re-entry deadlock:** compound operations use one lease/core helper; incompatible nested acquisition fails explicitly.
- **Worktree aliasing:** scheduling keys use discovered canonical Git identity, never request/session paths.
- **Map growth:** admission limits and immediate drain cleanup are test-visible.

## Completion evidence

- All ten acceptance criteria are implemented and covered by deterministic unit/integration tests.
- Final focused result: 77 passed, 0 failed across resolver, coordinator, service, and route tests.
- Node syntax/import smoke checks, web type-check, and web lint pass.
- Dead-code analysis used the available cached Knip with `--no-install`; it reported the repository's existing noisy baseline and did not report the new resolver/coordinator/error files.
