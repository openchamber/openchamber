# Git Execution Benchmark Report

## Purpose and interpretation

This PR #2276 follow-up combines the final `target-real` and corrected default `soak` PASS runs. Deterministic counts, safety checks, and lifecycle assertions are blocking. Wall-clock duration, latency, CPU, memory, file-descriptor, and event-loop values are advisory and machine-specific.

This evidence does not claim cross-process serialization or absolute latency guarantees.

## Provenance

- Source commit: `fd37d3e3ab9a10e82e5491092e656b5d19f86506`
- Run date: `2026-07-16`
- Report schema: v2
- Seed: `8755`
- Environment: Linux x64, 8 CPUs, Git 2.52.0, Bun 1.3.14, Node 24.3.0

## Target-versus-soak overview

| Metric | Target-real | Corrected soak |
|---|---:|---:|
| Result | PASS | PASS |
| Duration | 12,659.423 ms observed | 300,000 ms configured at rate 20; 300,961.759 ms observed |
| Topology/entities | 30,000 entities; 200 common directories; 100 linked worktrees; 300 identities | 600 entities; 4 common directories; 2 linked worktrees; 6 identities |
| Coordinator API submissions | 30,962 | 6,000 |
| Scheduled operations | 1,262 | 4,590 |
| Git commands | 2,876 | 4,754 |
| Fan-out/status grouping | 30,000 waiters / 300 underlying operations | 3,279 status callers / 1,869 status groups |
| Generation movement | 1,324 | 3,116 |
| Unexpected errors | 0 | 0 |
| Child timeouts | 0 | 0 |
| Fixture cleanup | PASS | PASS |
| Deterministic assertions | 90/90 | 108/108 |

## Blocking deterministic evidence

### Target-real

- Modeled exactly 30,000 entities across 200 common directories, 100 linked worktrees, and 300 worktree identities.
- Recorded 30,962 API submissions, 1,262 scheduled operations, and 2,876 Git commands.
- The pathological fan-out had 30,000 waiters and 300 underlying operations.
- Generation movement was exactly 1,324.
- One expected lock failure occurred and was retried once.
- Unexpected errors and child timeouts were both zero; fixture cleanup passed; all 90 assertions passed.

```text
1 environment + 1313 fixture-setup + 300 discovery + 1260 workload + 2 lock-recovery + 0 cleanup = 2876
```

### Corrected soak

- Ran for 300,000 ms configured at rate 20 and 300,961.759 ms observed.
- Modeled exactly 600 entities across 4 common directories, 2 linked worktrees, and 6 worktree identities.
- Recorded 6,000 API submissions, 4,590 scheduled operations, and 4,754 Git commands.
- The immutable plan had 3,279 status callers in 1,869 status groups.
- Generation movement was exactly 3,116.
- Unexpected errors and child timeouts were both zero; fixture cleanup passed; all 108 assertions passed.

```text
1 environment + 39 fixture-setup + 6 discovery + 4649 workload + 0 lock-recovery + 59 cleanup = 4754
```

## Advisory all-waiter latency

These are exact `allWaitersObservedTotalMs` samples, in milliseconds. They are machine-specific observations, not portable thresholds.

### Target-real

| Class | Count | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|
| startup-status | 300 | 456.551 | 847.213 | 868.526 | 878.377 |
| pathological-fanout-status | 30,000 | 687.247 | 1,183.4 | 1,301.264 | 1,380.051 |
| mixed-mutation | 600 | 1,039.54 | 1,914.602 | 1,994.919 | 2,021.232 |
| mixed-fetch | 60 | 1,659.285 | 2,394.047 | 2,469.676 | 2,469.676 |
| lock-write | 2 | 11.466 | 13.214 | 13.214 | 13.214 |

### Corrected soak

| Class | Count | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|
| soak-diff | 1,163 | 13.66 | 16.497 | 18.575 | 22.235 |
| soak-mutation | 1,146 | 16.603 | 20.764 | 24.124 | 29.874 |
| soak-status | 3,279 | 16.045 | 19.412 | 22.923 | 35.923 |
| soak-fetch | 353 | 47.162 | 53.782 | 57.34 | 62.875 |
| soak-topology | 59 | 65.022 | 69.893 | 78.191 | 78.191 |

## Boundedness and resources

All values in this section are advisory and machine-specific.

### Peak bounded state

| Peak metric | Target-real | Corrected soak |
|---|---:|---:|
| Top-level operations | 8 | 3 |
| Coordinator active / pending | 8 / 652 | 3 / 1 |
| Global / per-context reads | 8 / 2 | 3 / 2 |
| Global / per-context network | 2 / 1 | 2 / 1 |
| Status in flight | 300 | 2 |
| Harness Git children | 8 | 4 |

### Process resources

| Metric | Target-real | Corrected soak |
|---|---:|---:|
| Harness CPU user / system (µs) | 5,247,750 / 5,698,466 | 34,007,331 / 51,763,457 |
| RSS bytes, start / peak / end | 41,390,080 / 208,621,568 / 134,873,088 | 51,605,504 / 91,910,144 / 80,121,856 |
| Heap bytes, start / peak / end | 1,481,727 / 110,974,521 / 67,830,884 | 175,406 / 35,396,877 / 22,592,028 |
| File descriptors, start / end | 14 / 14 | 14 / 14 |
| Event-loop delay ms, p50 / p95 / p99 / max | 2.093 / 14.787 / 21.594 / 421.019 | 0.179 / 3.412 / 4.858 / 17.584 |

## Safety and lifecycle

- Safety passed in both runs, with no failed guard codes.
- Final coordinator maps and queues drained: active, pending, network, context, worktree, status, and clone counts were all zero.
- Final resolver maps and discovery queues drained: in-flight alias/context and active/pending discovery counts were all zero.
- Active harness submissions and Git children were both zero at completion.
- File descriptors returned from 14 to 14 in both runs, and fixture cleanup passed.
- No report or fixture path, or other sensitive local data, is included here.

## Reproduction

```bash
# Full profiles
bun run perf:git:target-real
bun run perf:git:soak

# Focused test and static validation
bun run test:perf:git
bun run perf:git:type-check
bun run perf:git:lint
```

The full soak is manual and takes about five minutes.

## Evidence policy

The raw JSON artifacts remain local and uncommitted. This Markdown report is a curated evidence snapshot, not a portable latency baseline. Superseded or non-passing evidence is excluded.
