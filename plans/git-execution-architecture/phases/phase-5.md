# Phase 5 — Before/After Git Service Comparison

Status: **complete (2026-07-18)**

## Goal

Measure the exact web Git service immediately before the new execution architecture and the current service with the same deterministic public-operation workload.

## Baseline

- Before source: `4c2f8946b`, verified as the direct parent of architecture commit `57c297527`.
- After source: the current worktree's `packages/web/server/lib/git/service.js`.
- Both sources use the current worktree's installed dependency tree. This controls dependency variance but means the result is an approximate architecture comparison, not a reconstruction of the historical machine.

## Performance contract

- Representative target: 30,000 session entities mapped onto 200 common directories and 100 additional linked worktrees (300 identities).
- Entity mapping performs no Git operation.
- Representative workload: one status refresh per identity plus the reviewed mutation/fetch cardinalities.
- Pathological workload: a separate explicit 30,000-caller status workload submitted in reviewed 600-caller waves. It is not representative session concurrency, is not the same as the current-only simultaneous fan-out guard, and must never enter normal test discovery.
- Metrics: end-to-end latency p50/p95/p99/max, workload duration/throughput, exact top-level Git launches by scenario, success/failure counts, and fixture cleanup.
- Absolute timing is advisory. Correctness and exact cardinality/count accounting are blocking.

## Correctness gates

1. Every worktree receives a unique untracked identity file.
2. Every status result must identify its requested worktree's file.
3. Every planned mutation must be staged in the intended worktree after the mixed workload.
4. Every local fetch must succeed.
5. A performance comparison is invalid if either implementation fails its correctness gate.

## Isolation

- Materialize only the historical service source under a unique OS temporary root.
- Run before and after in separate child processes with separate disposable repositories/remotes.
- Sanitize Git, credential, SSH-agent, HOME, and global/system configuration inputs.
- Use local bare remotes only; no external network.
- Count service-started top-level Git launches with a POSIX PATH shim that logs once and `exec`s the real Git binary. Fixture setup and oracle commands use the absolute real Git path and are excluded.
- Remove every fixture, shim, trace, and materialized source in outer cleanup. Raw JSON is stdout or one explicit new path outside the workspace.

## Stop conditions

- Stop before production source changes, test telemetry hooks, dependencies, CI workflows, or committed benchmark artifacts.
- Stop if the historical source is not the direct architecture parent or imports unavailable local modules.
- Stop if correctness differs; report it separately from performance.
- Stop the pathological baseline on timeout/resource failure and report the capacity failure. The fixed caller waves are part of the declared comparative trace; do not add implementation-specific scheduling inside a wave.

## Result

- Baseline-parent verification, current/current focused control, historical/current smoke, and both representative run orders passed.
- Representative target: 30,000 entities / 200 common directories / 100 linked worktrees / 300 identities; 960 service calls; 1,066 correctness checks per implementation; zero unclassified launches; cleanup passed.
- Representative launch count: 5,220 before versus 3,960 after (24.138% fewer). Advisory completion was 43.227–46.759% longer after under the one-call-per-identity broad burst.
- Batched fan-out: 30,000 callers in 600-caller waves; 61,067 correctness checks per implementation; 215,220 versus 5,760 launches; 906,456.058ms versus 27,888.368ms; fan-out p95 17,073.159ms versus 236.470ms; cleanup passed.
- The result documents both tradeoffs rather than declaring one architecture universally faster.
