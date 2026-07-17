# Phase 5 — Before/After/After+Fsmonitor Git Service Comparison

Status: **complete (2026-07-18)**

## Goal

Measure the exact web Git service immediately before the new execution architecture, the current service, and the same current service with a manually configured fixture-local Git fsmonitor hook under one deterministic public-operation workload.

## Baseline

- Before source: `4c2f8946b`, verified as the direct parent of architecture commit `57c297527`.
- After source: the current worktree's `packages/web/server/lib/git/service.js`.
- After+fsmonitor source: byte-identical to After; only its disposable Git repositories receive local `core.fsmonitor=<fixture hook>` and `core.fsmonitorHookVersion=2`.
- All targets use the current worktree's installed dependency tree. This controls dependency variance but means the result is an approximate architecture/configuration comparison, not a reconstruction of the historical machine.

## Performance contract

- Representative target: 30,000 session entities mapped onto 200 common directories and 100 additional linked worktrees (300 identities).
- Entity mapping performs no Git operation.
- Representative workload: one cold and one unchanged warm status refresh per identity plus the reviewed mutation/fetch cardinalities.
- Pathological workload: a separate explicit 30,000-caller status workload submitted in reviewed 600-caller waves. It is not representative session concurrency, is not the same as the current-only simultaneous fan-out guard, and must never enter normal test discovery.
- Metrics: end-to-end latency p50/p95/p99/max, workload duration/throughput, exact top-level Git launches by scenario, success/failure counts, and fixture cleanup.
- Absolute timing is advisory. Correctness and exact cardinality/count accounting are blocking.

## Correctness gates

1. Every worktree receives a unique untracked identity file.
2. Every status result must identify its requested worktree's file.
3. Every planned mutation must be staged in the intended worktree after the mixed workload.
4. Every local fetch must succeed.
5. After+fsmonitor must use the current source hash, invoke protocol v2 exactly once per identity in both cold and warm status, preserve repository-local config, classify every hook invocation, and clean up.
6. A performance comparison is invalid if any target fails its correctness gate or if target cardinalities differ.

## Isolation

- Materialize only the historical service source under a unique OS temporary root.
- Run before, after, and after+fsmonitor in separate child processes with separate disposable repositories/remotes.
- Sanitize Git, credential, SSH-agent, HOME, and global/system configuration inputs.
- Use local bare remotes only; no external network.
- Count service-started top-level Git launches with a POSIX PATH shim that logs once and `exec`s the real Git binary. Fixture setup and oracle commands use the absolute real Git path and are excluded.
- Count fsmonitor hook invocations separately. The protocol-v2 hook returns `/` for an unknown token and during the mutation scenario, then no changed paths for its unchanged warm token. Hook processes are not Git launches and are excluded from worker CPU metrics.
- Remove every fixture, shim, trace, and materialized source in outer cleanup. Raw JSON is stdout or one explicit new path outside the workspace.

## Stop conditions

- Stop before production source changes, production fsmonitor management/daemon lifecycle, test telemetry hooks, dependencies, CI workflows, or committed benchmark artifacts.
- Stop if the historical source is not the direct architecture parent or imports unavailable local modules.
- Stop if correctness differs; report it separately from performance.
- Stop the pathological baseline on timeout/resource failure and report the capacity failure. The fixed caller waves are part of the declared comparative trace; do not add implementation-specific scheduling inside a wave.

## Result

- Baseline-parent verification, current/current/current+fsmonitor focused control, historical/current/current+fsmonitor smoke, and both representative run orders passed under comparison schema v2.
- Representative target: 30,000 entities / 200 common directories / 100 linked worktrees / 300 identities; 1,260 service calls; 1,667 correctness checks before/after and 1,874 after+fsmonitor; zero unclassified Git launches or hook invocations; cleanup passed.
- Representative launch count: 7,320 before versus 5,760 after and after+fsmonitor (21.311% fewer than before). Advisory completion ranges were 15,988.804–16,281.249ms before, 22,563.860–22,643.539ms after, and 23,655.630–24,087.816ms after+fsmonitor.
- Both representative orders recorded exactly 1,860 protocol-v2 hook invocations after+fsmonitor: 300 cold, 300 warm, and 1,260 conservative mutation refreshes. All 200 manual configs remained unchanged.
- Batched fan-out: 30,000 callers in 600-caller waves; 61,668 correctness checks before/after and 61,875 after+fsmonitor; 217,320 / 7,560 / 7,560 launches; 919,602.404ms / 34,040.489ms / 37,616.044ms; fan-out p95 17,221.023ms / 236.764ms / 247.857ms; cleanup passed.
- The deterministic shell hook adds process overhead and the fixture has only one tracked file per repository. The result documents measured tradeoffs rather than claiming a universal fsmonitor speedup or production watcher performance.
