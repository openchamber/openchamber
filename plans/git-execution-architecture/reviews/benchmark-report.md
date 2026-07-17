# Git Execution Benchmark Report

## Purpose and interpretation

This PR #2276 follow-up combines the final `target-real` and corrected default `soak` PASS runs. Deterministic counts, safety checks, and lifecycle assertions are blocking. Wall-clock duration, latency, CPU, memory, file-descriptor, and event-loop values are advisory and machine-specific.

This evidence does not claim cross-process serialization or absolute latency guarantees.
The harness isolates Git configuration and does not enable or measure `core.fsmonitor`.

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

## Historical/current web service comparison

### Purpose and provenance

Phase 5 adds a separate architecture-neutral service benchmark. It invokes exported light-status, stage, and local-fetch operations rather than coordinator internals.

- Before source: `4c2f8946b37315835cba55c88c5faaa829c32254`, runtime-verified as the direct parent of architecture commit `57c2975270369987fbde0b4bb578dceaa1f59aba`.
- Before `service.js` SHA-256: `d530b09950f1b3643c4b64bdb365247b5abb3e7dfb8e4bbc3bf4047996c4575a`.
- After `service.js` SHA-256: `7e34f26d6ab6a040b129538cf1e2977ae3c5148a11a29db6eefe480a003c4af5`.
- Environment: Linux x64, Git 2.52.0, Bun 1.3.14, Node 24.3.0.
- Both sources used the same current installed dependency tree. This isolates source architecture but is not a reconstruction of historical dependencies or hardware.
- A POSIX PATH shim logged each top-level service-started Git executable and immediately `exec`ed the real binary. Fixture setup, direct correctness-oracle Git, and Git helpers are excluded.
- Absolute latency is advisory. Correctness, cardinality, launch accounting, and cleanup are blocking.

### Representative 30,000 / 200 / 100 target

This profile maps 30,000 session entities to 200 common directories plus 100 linked worktrees (300 identities), then runs 300 status calls, 600 stage operations, and 60 local fetches. Entity mapping starts no Git process. Both run orders passed all 1,066 correctness checks for each implementation, including authoritative common-directory/top-level topology checks, produced zero unclassified launches, and cleaned their fixtures.

| Run order | Before duration | After duration | Before Git | After Git | Duration change | Git reduction |
|---|---:|---:|---:|---:|---:|---:|
| Before → after | 11,548.750 ms | 16,540.896 ms | 5,220 | 3,960 | after 43.227% longer | 24.138% |
| After → before | 10,596.833 ms | 15,551.758 ms | 5,220 | 3,960 | after 46.759% longer | 24.138% |

Advisory p95 ranges across the two orders:

| Operation | Before p95 | After p95 |
|---|---:|---:|
| Startup status | 4,581.188–4,803.168 ms | 5,670.701–6,432.429 ms |
| Stage mutation | 5,915.716–6,663.972 ms | 9,011.120–9,173.991 ms |
| Local fetch | 2,447.418–2,867.017 ms | 9,370.659–9,441.419 ms |

Interpretation: this representative profile has only one status caller per worktree identity, so it does not exercise same-identity status coalescing. The historical path permits much broader burst parallelism across 200 repositories; the current architecture deliberately enforces global/read/network bounds. On this machine that trade reduced top-level Git launches by 1,260 but increased completion and queue-observed latency. This is evidence of the bounded-throughput trade, not a portable latency threshold.

### Batched 30,000-caller fan-out

The explicit pathological profile retains the same 30,000 entities and topology, then adds 30,000 status callers. For host safety and legacy comparability, callers are grouped evenly by worktree and submitted in fixed 600-caller waves. It is not equivalent to the current-only simultaneous 30,000-caller guard.

The final-code reverse-order run passed all 61,067 correctness checks per implementation, including authoritative topology checks, had zero unclassified launches, and cleaned both fixtures.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Whole measured workload | 906,456.058 ms | 27,888.368 ms | 32.503× faster after |
| Total top-level Git launches | 215,220 | 5,760 | 97.324% fewer after |
| Fan-out scenario duration | 895,880.638 ms | 11,608.410 ms | 77.175× faster after |
| Fan-out Git launches | 210,000 | 1,800 | 99.143% fewer after |
| Fan-out caller latency p50 | 9,716.253 ms | 203.438 ms | 47.760× lower after |
| Fan-out caller latency p95 | 17,073.159 ms | 236.470 ms | 72.200× lower after |
| Fan-out caller latency p99 | 17,815.126 ms | 249.649 ms | 71.361× lower after |
| Fan-out caller latency max | 18,616.131 ms | 285.076 ms | 65.302× lower after |

Interpretation: when many callers ask the same worktree/generation question, the current service performs bounded generation-aware in-flight sharing. The historical total common-directory FIFO repeats the full service Git sequence per caller. The comparison therefore shows both sides of the architecture: lower unconstrained completion time for a one-call-per-identity burst in the old path, versus dramatically lower work and latency under repeated same-identity fan-out in the current path.

### Comparison reproduction

```bash
bun run test:perf:git:comparison
bun run perf:git:compare:smoke
bun run perf:git:compare:target
bun run perf:git:compare:target -- --order after-first
bun run perf:git:compare:pathological -- --order after-first
```

Raw comparison JSON remains local and uncommitted. The report does not enable or measure `core.fsmonitor`, claim cross-process serialization, count Git helpers, or make machine-specific latency blocking.
