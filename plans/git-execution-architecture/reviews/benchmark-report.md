# Git Execution Benchmark Report

## Purpose and interpretation

This PR #2276 follow-up combines the final `target-real` and corrected default `soak` PASS runs. Deterministic counts, safety checks, and lifecycle assertions are blocking. Wall-clock duration, latency, CPU, memory, file-descriptor, and event-loop values are advisory and machine-specific.

This evidence does not claim cross-process serialization or absolute latency guarantees.
The Phase 4 coordinator profiles isolate Git configuration and do not enable or measure `core.fsmonitor`. The separate Phase 5 three-way comparison below enables one deterministic fixture-local hook only for its current+fsmonitor target.

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

## Historical/current/current+fsmonitor web service comparison

### Purpose and provenance

Phase 5 adds a separate architecture-neutral service benchmark. Comparison schema v2 invokes exported light-status, stage, and local-fetch operations rather than coordinator internals and evaluates three isolated targets.

- Before source: `4c2f8946b37315835cba55c88c5faaa829c32254`, runtime-verified as the direct parent of architecture commit `57c2975270369987fbde0b4bb578dceaa1f59aba`.
- Before `service.js` SHA-256: `d530b09950f1b3643c4b64bdb365247b5abb3e7dfb8e4bbc3bf4047996c4575a`.
- After `service.js` SHA-256: `7e34f26d6ab6a040b129538cf1e2977ae3c5148a11a29db6eefe480a003c4af5`.
- After+fsmonitor uses the same current-service SHA-256. Only its disposable repositories receive local `core.fsmonitor=<fixture hook>` and `core.fsmonitorHookVersion=2`.
- Environment: Linux x64, Git 2.52.0, Bun 1.3.14, Node 24.3.0.
- All targets used the same current installed dependency tree. This isolates source architecture/configuration but is not a reconstruction of historical dependencies or hardware.
- A POSIX PATH shim logged each top-level service-started Git executable and immediately `exec`ed the real binary. Fixture setup, direct correctness-oracle Git, Git helpers, and fsmonitor hook processes are excluded from Git-launch counts. Hook invocations are reported separately.
- The deterministic protocol-v2 hook returns `/` for an unknown token and for the mutation scenario, then no changed paths for its unchanged warm token. It is a controlled fixture hook, not a production watcher/daemon benchmark.
- Absolute latency is advisory. Correctness, equal cardinality, source/config provenance, launch/hook accounting, and cleanup are blocking.

### Representative 30,000 / 200 / 100 target

This profile maps 30,000 session entities to 200 common directories plus 100 linked worktrees (300 identities), then runs 300 cold status calls, 300 unchanged warm status calls, 600 stage operations, and 60 local fetches. Entity mapping starts no Git process. Both run orders passed 1,667 correctness checks in Before and After and 1,874 in After+fsmonitor, produced zero unclassified launches/invocations, and cleaned all fixtures.

Measured workload duration:

| Run order | Before | After | After + fsmonitor |
|---|---:|---:|---:|
| Before → after → after+fsmonitor | 16,281.249 ms | 22,563.860 ms | 23,655.630 ms |
| After+fsmonitor → after → before | 15,988.804 ms | 22,643.539 ms | 24,087.816 ms |

Blocking count/correctness evidence was stable in both orders:

| Metric | Before | After | After + fsmonitor |
|---|---:|---:|---:|
| Service calls | 1,260 | 1,260 | 1,260 |
| Top-level Git launches | 7,320 | 5,760 | 5,760 |
| Correctness checks | 1,667/1,667 PASS | 1,667/1,667 PASS | 1,874/1,874 PASS |
| Unclassified Git launches | 0 | 0 | 0 |
| Fixture cleanup | PASS | PASS | PASS |

Advisory p95 ranges across the two orders:

| Operation | Before | After | After + fsmonitor |
|---|---:|---:|---:|
| Cold status | 4,571.925–4,670.398 ms | 6,087.424–6,534.220 ms | 5,938.174–6,413.596 ms |
| Unchanged warm status | 4,525.761–4,588.477 ms | 6,008.937–6,068.893 ms | 5,974.635–6,038.283 ms |
| Stage mutation | 6,715.522–6,988.978 ms | 8,919.251–9,315.345 ms | 10,358.474–10,431.057 ms |
| Local fetch | 2,887.977–3,104.416 ms | 9,202.637–9,704.555 ms | 10,649.534–10,886.118 ms |

Interpretation: the current architecture used 21.311% fewer top-level Git launches than the historical path, while its bounded workload duration was 38.588–41.621% longer on this machine. Relative to current without fsmonitor, the third target's cold/warm p95 was 0.504–2.452% lower, but whole-workload duration was 4.839–6.378% longer and Git-launch count was unchanged. The shell hook adds one external process per invocation, the fixture has only one tracked file per repository, and mutation safety deliberately returns `/`; this is not evidence of a universal fsmonitor speedup.

### Fsmonitor contract evidence

| Metric | Before | After | After + fsmonitor |
|---|---:|---:|---:|
| Fsmonitor mode | Disabled | Disabled | Fixture hook, protocol v2 |
| Configured common directories | 0 | 0 | 200 |
| Hook invocations | 0 | 0 | 1,860 |
| Invocation scenarios | — | — | 300 cold; 300 warm; 1,260 mutation refresh |
| Hook responses | — | — | 300 cold; 300 warm; 1,260 refresh |
| Config preserved | N/A | N/A | 200/200 |
| Unexpected versions / unclassified invocations | 0 / 0 | 0 / 0 | 0 / 0 |

The configuration is created by the harness with direct fixture Git before the measured worker path. The service only inherits it. Production OpenChamber does not read, write, probe, cache, expose, start, stop, or inspect fsmonitor configuration or daemon lifecycle.

### Batched 30,000-caller fan-out

The explicit pathological profile retains the same 30,000 entities and topology, then adds 30,000 status callers. For host safety and legacy comparability, callers are grouped evenly by worktree and submitted in fixed 600-caller waves. It is not equivalent to the current-only simultaneous 30,000-caller guard.

The final-code reverse-order run passed 61,668 correctness checks in Before and After and 61,875 in After+fsmonitor, including authoritative topology and hook/config checks. It had zero unclassified launches/invocations and cleaned all three fixtures.

| Metric | Before | After | After + fsmonitor |
|---|---:|---:|---:|
| Whole measured workload | 919,602.404 ms | 34,040.489 ms | 37,616.044 ms |
| Total top-level Git launches | 217,320 | 7,560 | 7,560 |
| Fan-out scenario duration | 902,948.869 ms | 11,596.824 ms | 12,022.228 ms |
| Fan-out Git launches | 210,000 | 1,800 | 1,800 |
| Fan-out caller latency p50 | 9,808.308 ms | 203.981 ms | 212.040 ms |
| Fan-out caller latency p95 | 17,221.023 ms | 236.764 ms | 247.857 ms |
| Fan-out caller latency p99 | 17,978.202 ms | 254.839 ms | 262.163 ms |
| Fan-out caller latency max | 18,912.777 ms | 264.138 ms | 271.237 ms |
| Fsmonitor hook invocations | 0 | 0 | 2,160 |

Interpretation: when many callers ask the same worktree/generation question, the current service performs bounded generation-aware in-flight sharing. Compared with historical, current completed the whole workload 27.015× faster, used 96.521% fewer top-level Git launches, and lowered fan-out p95 72.735×. The shell-hook target retained the same Git-launch count but was 10.504% slower overall and 4.685% higher at fan-out p95 than current without fsmonitor. This reports the measured hook overhead honestly; it does not model a persistent Watchman/native daemon on a large tracked tree.

### Comparison reproduction

```bash
bun run test:perf:git:comparison
bun run perf:git:compare:smoke
bun run perf:git:compare:target
bun run perf:git:compare:target -- --order after-first
bun run perf:git:compare:pathological -- --order after-first
```

Raw comparison JSON remains local and uncommitted. Only the third disposable comparison target enables `core.fsmonitor`; the report does not add production management, claim cross-process serialization, count Git helpers/hooks as top-level Git launches, or make machine-specific latency blocking.
