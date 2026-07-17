# Phase 4 — Git Execution Performance Validation

Status: **complete; final-code target and corrected soak pass (2026-07-16)**

## Goal

Add PR-ready, reproducible performance validation without changing production scheduling behavior. The harness must combine deterministic operation-count and lifecycle assertions with advisory latency/resource measurements, use only disposable local Git fixtures, and never write a report unless an explicit output path is supplied.

## Performance contract

- **Interaction:** repository startup status, status/diff refresh, worktree-local index mutations, local fetch, linked-worktree identity discovery, and lock-failure recovery.
- **Entity scale:** 30,000 logical session records mapped onto 200 independent Git common directories and 100 additional linked worktrees, for 300 worktree identities total.
- **Caller scale:** entity count is not concurrent caller count. Startup is a 300-caller burst. A separate 30,000-caller status burst is deliberately pathological fan-out used only as a coalescing/correctness guard.
- **Cost model:** session entities → unique worktree identities → scenario-declared logical callers → coordinator API submissions → underlying scheduled operations → direct Git children. Entity-cardinality mapping is measured separately and must perform zero submissions, operations, and Git commands.
- **PR budget:** `pr-real` targets less than 30 seconds on ordinary CI, but elapsed time and latency percentiles are advisory. Deterministic cardinality, caps, conflicts, generations, errors, drain, resource cleanup, and fixture cleanup are blocking.
- **Comparison policy:** a relative timing gate is valid only in an explicit paired base/head mode using the same host and fixture. A single-machine p99 is never PR-blocking.

The existing synthetic web and VS Code 30,000-caller tests are pathological fan-out correctness guards. They prove bounded state and exact coalescing under an intentionally extreme submission burst; they do not represent 30,000 simultaneously active user sessions or 30,000 Git subprocesses.

## Runtime boundary

Real Git execution uses the web coordinator/resolver primitives because they are server-owned Node/Bun modules with no native-host dependency. The VS Code coordinator/resolver remain package-local and are exercised with the same deterministic test-only fixture and assertions. The harness does not import the VS Code Git extension API or any built-in Repository API outside Extension Host.

## Profiles

### `pr-real`

- Disposable local repository, linked worktree, and local bare remote.
- Real status and diff-like reads, worktree-local writes, local bare fetch, canonical linked-worktree identity, external `index.lock` failure plus retry, fairness/conflict ordering, map/queue drain, and fixture cleanup.
- Fast deterministic smoke intended for reviewers and possible future PR checks; no workflow is added in this phase.

### `target-real`

Default topology and counts are fixed to the issue target:

- 30,000 logical session records;
- 200 independent common directories;
- 100 additional linked worktrees, yielding 300 worktree identities;
- entity-cardinality mapping that proves 30,000 sessions → 300 identities → zero coordinator submissions, zero scheduled operations, and zero Git commands by mapping itself;
- 300-worktree real startup status burst;
- pathological 30,000-caller status fan-out with exactly 300 underlying status tasks;
- exactly 600 real mutation operations and 60 local bare fetch/network operations in a seeded mixed workload;
- one expected external lock failure and one successful retry.

A reduced `--development` override exists for implementation validation. It must report its reduced configuration and must never be presented as the full target result.

### `soak`

- Seeded steady mixed workload over disposable local repositories.
- Default manual duration: 300 seconds at 20 logical caller slots/second.
- Supports explicit duration and rate overrides.
- Includes status/read, mutation, local fetch, idle-state eviction, linked-worktree topology churn, and final lifecycle checks.
- Precomputes an immutable plan before fixture execution. Status callers share only when their one-second wave, worktree, planned common/worktree generation, and idle segment match.
- Submits each status group's callers synchronously behind its worktree gate; separate status groups and mutations are chained per worktree, while fetch/topology events form common-context barriers and unrelated contexts retain concurrency.
- Manual only; it is not part of normal PR/package suites.

For the default seed 8755, 6,000 logical callers/API submissions contain 3,279 status callers in 1,869 groups. The complete plan expects 4,590 scheduled operations, 4,754 Git commands, and generation movement 3,116. Its reviewed command equation is `1 environment + 39 fixture-setup + 6 discovery + 4649 workload + 0 lock-recovery + 59 cleanup = 4754`.

### `cap-sweep`

- Test-only coordinator caps: 2, 4, 6, 8, and 12.
- Replays one identical seeded fixture and submission order for every cap.
- Reports throughput, latency, CPU, and memory deltas without changing production defaults or declaring an optimal cap.

## Metrics and report contract

Schema version 2 reports:

- schema version, seed, profile, resolved config, environment, platform/architecture, and Git/Bun/Node versions;
- session entities, mapping evidence, and independent per-scenario logical caller counters separately from coordinator API submissions, underlying scheduled operations, and Git commands;
- distinct startup, pathological fan-out, mixed-workload, lock-recovery, soak, and cap-sweep scenario counters as applicable;
- underlying queue/service/total p50/p95/p99/max with one sample per started scheduled operation;
- all-waiter observed-total p50/p95/p99/max with one exact sample per coordinator API submission, including every pathological fan-out waiter;
- active/peak top-level operations and direct Git children, plus final harness-owned submission/child counts, explicitly excluding Git helpers and external processes;
- global and per-common read/network peaks derived from coordinator stats plus harness task ownership;
- process CPU user/system, RSS/heap start/peak/end, Linux FD start/end, and event-loop delay percentiles;
- mutation generations, expected/unexpected errors, lock failures/retries, retained contexts/worktrees, and final active/pending/network/status/clone state;
- executable safety-guard counts/evidence, complete Git-command category/class accounting, fixture cleanup result, and deterministic assertion results;
- for soak, the immutable pre-execution caller-type counts, status-group count/size distribution, scheduled-event count, generation expectation, and Git-command equation.
- configured per-child timeout plus timeout, graceful/forced termination, and close/reap counts.

JSON is written to stdout. A human summary may be written to stderr. A report file is written only when the caller supplies `--output <path>`.

## Blocking assertions

- Exact session, worktree, scenario-caller, API-submission, scheduled-operation, Git-command, coalescing, mutation, and fetch counts for the selected configuration.
- Soak runtime API/scheduled/status-group/generation/Git counts equal the pre-execution plan; no expected value is derived from observed timing or coalescing.
- Entity mapping has exact zero API-submission/scheduled-operation/Git-command deltas.
- All-waiter latency sample counts equal API submissions by class; underlying latency sample counts equal started scheduled operations by class.
- Every direct spawn belongs to the closed `environment`, `fixture-setup`, `discovery`, `workload`, `lock-recovery`, or `cleanup` category set. Category/class sums, success/failure totals, and profile equations equal the complete Git-command total.
- Every direct spawn passes executable cwd/path operand, sanitized environment, disabled prompt/hook/auto-GC, and local-only remote checks before spawn.
- Configured global/per-context read and network caps, conflict ordering, fairness, and generation movement.
- Exact expected lock/overload counts and zero unexpected errors.
- Final active, pending, network, status, clone queue, and clone destination counts are zero.
- Retained maps stay within configured bounds and become empty after explicit eligible idle eviction.
- Linux FD count returns within a documented tolerance of 3; non-Linux reports FD as unsupported.
- No harness-owned coordinator submission or Git child remains and disposable fixture cleanup succeeds.
- Normal profiles have zero child timeouts. Any timeout is unexpected, receives one harness-owned termination attempt, and is closed/reaped before child/operation metrics release; force escalation occurs only if graceful termination does not close the child.

Latency and throughput are advisory unless a future separately approved paired base/head mode provides a relative gate.

## Generated-artifact policy

- Never commit benchmark JSON, temporary repositories/remotes, `.git` directories, logs, traces, profiles, or machine-specific baselines.
- Never write output by default.
- An explicit output must resolve to one new file outside the workspace; existing files are never overwritten. The earlier failed soak report is non-passing, superseded, and never reused as evidence.
- Generated report paths are local and non-durable, never required filenames or committed artifacts. Exact final-run paths are retained only in the handover evidence section, not in reusable templates.
- Temporary fixtures are created under the operating-system temp directory and removed in `finally`.

## Commands

```bash
bun run perf:git:pr-real
bun run perf:git:target-real
bun run perf:git:target-real:dev
bun run perf:git:soak -- --duration-ms 300000 --rate 20
bun run perf:git:cap-sweep
bun run test:perf:git
```

`--duration-ms` and `--rate` are accepted only with `--profile soak`; every other profile rejects them. `--git-child-timeout-ms` configures the per-child timeout for any profile and defaults to 60,000ms.

## Final-code full-profile evidence

- Target PASS: 30,962 API submissions, 1,262 scheduled operations, 2,876 Git commands, 30,000/300 pathological fan-out waiter/underlying samples, generation movement 1,324, zero child timeouts, zero unexpected errors, and successful cleanup.
- Corrected default soak PASS: 6,000 API submissions, 4,590 scheduled operations, 4,754 Git commands, 3,279 status callers in 1,869 groups, generation movement 3,116, zero child timeouts, zero unexpected errors, and successful cleanup.
- Focused harness PASS: 12/12. Harness type-check and lint PASS.
- The earlier failed soak report remains explicitly non-passing, is superseded by the final corrected soak, and must never appear as PR evidence.

Normal package test commands do not invoke full `target-real`, `soak`, or `cap-sweep` profiles.

## Implementation result

- Added the standalone harness, executable PR smoke, deterministic web/VS Code parity fixture, all four profiles, package scripts, harness-only type-check/lint, and owning documentation.
- Hardened every Git child with executable pre-spawn cwd/path/local-remote/environment/configuration guards inside the unique fixture boundary, tracked submission/child settlement, and outer `finally` cleanup. Declarative safety booleans were removed.
- Schema v2 separates entity mapping and scenario callers from API submissions, adds exact all-waiter latency beside underlying latency, and blocks on complete closed Git-command equations.
- The soak correction replaces machine-timed incidental coalescing with immutable status waves/groups and explicit worktree/common barriers. A programmatic-only delay seam proves the same plan under fast and deliberately variable status durations; it is not exposed through the CLI.
- Local deterministic validation passed for `pr-real`, reduced `target-real`, cap sweep, the normal reduced soak, and variable-duration reduced soaks. The final focused suite passed 12/12, including exact default-plan assertions, timeout/reap probes, CLI validation, and full-profile discovery guards; harness type-check/lint passed.
- Final-code target and corrected-soak artifacts passed with the exact reviewed counts, generations, zero timeout/unexpected-error state, and successful cleanup recorded above. Final hardening adds a 60-second configurable child timeout with owned termination/reap accounting, rejects soak-only flags on other profiles, and prevents focused test discovery from admitting full profiles.
- The earlier failed default soak remains non-passing, superseded, and excluded from PR evidence.

## PR body template

```md
## Summary
- Add a standalone Git execution performance harness with deterministic PR assertions.
- Cover real local Git smoke, full target topology, manual soak, and cap sweep profiles.
- Keep production scheduler behavior and defaults unchanged.

## Validation
- `bun run test:perf:git` — `<result>`
- `bun run perf:git:pr-real` — `<result>`
- `bun run perf:git:target-real:dev` — `<result>`
- `bun run perf:git:soak -- --duration-ms 10500 --rate 2` — `<result>`
- `<type/lint/syntax command>` — `<result>`

## Performance notes
- Profile/schema/seed: `<profile>` / `2` / `<seed>`
- Entity mapping: `<sessions>` → `<identities>` → `0 API submissions / 0 scheduled operations / 0 Git commands`
- Scenario counters: `<scenario: logical callers / API submissions / scheduled operations / Git commands>`
- Soak plan: `<status callers / groups / group-size counts / expected scheduled operations / generation movement>`
- Child timeout: `<default/override / timeouts / termination attempts / graceful / forced / reaped>`
- Pathological fan-out latency counts: `<all waiters>` / `<underlying tasks>`
- Git-command equation: `<closed category equation and exact class/success/failure totals>`
- Runtime safety guards: `<passed guard counts; zero failures>`
- Deterministic assertions: `<pass/fail>`
- Advisory latency/resource summary: `<summary>`
- Full target: `<PASS/FAIL — API / scheduled / Git; fan-out waiter/underlying; generation; timeout/error/cleanup state>`
- Default soak: `<PASS/FAIL — API / scheduled / Git; status callers/groups; generation; timeout/error/cleanup state>`
- Superseded evidence: `<identify any non-passing report and confirm exclusion>`

## Artifacts
- No generated benchmark report or temporary Git fixture committed.
```

## Current Phase 4 PR validation

```md
## Validation
- `bun run test:perf:git` — PASS (12/12)
- `bun run perf:git:target-real` — PASS
- `bun run perf:git:soak` — PASS
- `bun run perf:git:type-check` — PASS
- `bun run perf:git:lint` — PASS

## Full-profile evidence
- Target: PASS — 30,962 API / 1,262 scheduled / 2,876 Git; 30,000 waiter / 300 underlying fan-out; generation 1,324; zero timeouts/unexpected errors; cleanup passed.
- Soak: PASS — 6,000 API / 4,590 scheduled / 4,754 Git; 3,279 status callers / 1,869 groups; generation 3,116; zero timeouts/unexpected errors; cleanup passed.

## Artifacts
- Generated reports are local-only, non-durable, and not committed; local paths are intentionally omitted from the PR body and are not future-run template values.
- The earlier failed soak report is NON-PASSING, superseded by the final corrected soak, and excluded from PR evidence.
```

## Stop conditions

- Stop if the harness requires a production telemetry hook, scheduler/service behavior change, dependency, CI workflow, committed generated report, machine-specific baseline, or VS Code built-in API import.
- Stop if any path, remote, environment, Git configuration, output boundary, or command category cannot be checked executably before spawn/write.
- Do not call the existing 30,000-caller synthetic tests representative concurrency.
- Do not make an absolute latency percentile PR-blocking.
