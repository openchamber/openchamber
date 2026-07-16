# Phase 4 Implementation Plan

Status: **complete; final-code full-profile evidence passes (2026-07-16)**

## Work packages

### 0. Independent-review contract corrections

- Bump the report schema and remove the aggregate caller field that mechanically mirrors submissions. Declare scenario callers independently and prove entity mapping performs zero coordinator submissions, scheduled operations, or Git commands.
- Record bounded report distributions for every waiter's observed total latency separately from underlying queue/service/total samples.
- Enforce fixture, path operand, local remote, child environment/configuration, and explicit output boundaries before spawn/write; report executed guard evidence rather than constants.
- Require every Git spawn to name one closed category and operation class. Compare complete observed category/class maps and totals with reviewed per-profile expectations.

### 0a. Deterministic soak status waves

- Replace the flat status-slot assumption with one seeded immutable plan containing logical caller slots, status groups, generation epochs, idle segments, scheduled events, and exact API/scheduled/Git expectations.
- Submit every status group's callers synchronously behind its dependency gate so one group always creates exactly one underlying status task regardless of Git duration.
- Chain separate groups and worktree mutations per worktree; treat fetch/topology work as a barrier for every worktree in its common context while retaining unrelated-context concurrency.
- Exercise repeated short soaks with deliberately variable test-only status delays and hard exact count assertions.

Implemented result: the seed/config now creates one frozen plan before fixture execution. The default seed fixes 6,000 callers/API submissions, 3,279 status callers, 1,869 status groups, 4,590 scheduled operations, 4,754 Git commands, and 3,116 generation movement. Per-worktree tails order separate status groups and local mutations; fetch/topology events replace every tail in their common context with one shared barrier without serializing other common contexts.

### 0b. Final child/CLI/test-discovery hardening

- Give every direct Git child a report-visible, profile-configurable timeout with a conservative 60,000ms default. Start timing only after `spawn`; terminate only the dedicated POSIX process group or exact Windows child; wait 1,000ms before force escalation; reject only after actual `close` so metrics and operation state cannot release early.
- Count timeout, termination attempt, graceful/forced outcome, and close/reap balance. Treat timeout as an unexpected test failure while retaining outer fixture cleanup.
- Reject `--duration-ms` and `--rate` unless the selected profile is `soak`; cover pure parsing and executable CLI exit behavior.
- Route all focused tests through a bounded entrypoint that rejects full target and soaks over 30 seconds. Inventory root scripts so only `perf:git:target-real` and `perf:git:soak` are reviewed full-profile entrypoints.
- Keep canonical-realpath output tests portable. Do not add Windows symlink tests that depend on developer-mode/admin privileges.

Pre-hardening evidence established the reviewed target and corrected-soak counts before the child-runner change. The earlier failed soak remains non-passing, is superseded by the corrected result, and is excluded from PR evidence.

Implemented/verified result: the direct-child timer starts on `spawn`, normal POSIX children use dedicated process groups, timeout waits for actual `close` after graceful or forced termination, and only then does `GitRunner.run()` release command/child and coordinator operation state. The focused suite passed 12/12, including 200ms graceful/forced probes, CLI subprocess rejection, and focused/full-profile guards; harness type-check/lint passed. Final-code target passed with 30,962 API submissions, 1,262 scheduled operations, 2,876 Git commands, 30,000/300 fan-out waiter/underlying samples, generation movement 1,324, zero timeouts/unexpected errors, and successful cleanup. Final-code corrected soak passed with 6,000 API submissions, 4,590 scheduled operations, 4,754 Git commands, 3,279 status callers in 1,869 groups, generation movement 3,116, zero timeouts/unexpected errors, and successful cleanup. Generated artifacts are local, non-durable, and uncommitted; exact final paths live only in the handover evidence section.

### 1. Standalone harness contract

- Add `scripts/perf/git-execution.ts` with an `import.meta.main` CLI and exported test entrypoint.
- Parse explicit profile/seed/output/development/soak overrides without adding a CLI dependency.
- Emit one JSON report to stdout and write a file only for `--output`.
- Keep absolute timing advisory and deterministic assertions blocking.

### 2. Disposable real-Git fixture

- Create repositories, linked worktrees, and bare remotes only beneath one OS temporary root.
- Route every Git child through one wrapper that sanitizes inherited Git/credential environment variables, sets `GIT_CONFIG_NOSYSTEM=1`, disables terminal/credential prompts, uses an isolated global config, disables hooks and auto-GC, counts commands/children, and captures failures.
- Remove external lock files in local `finally` blocks, wait for harness-owned submissions/children, and remove the fixture root in the outer `finally`.
- Assert no harness-owned submission or child remains and cleanup succeeds.

### 3. Metrics and assertions

- Record queue/service/total latency distributions by operation class.
- Sample CPU, RSS/heap, Linux FDs, event-loop delay, coordinator stats, top-level task ownership, and harness-owned Git children.
- Snapshot entity mapping deltas, declare scenario callers independently, and track API submissions, scheduled operations, and Git commands separately.
- Record exact all-waiter observed totals independently from underlying queue/service/total samples.
- Assert exact cardinalities/coalescing, latency sample counts, closed command equations, runtime safety guards, caps, ordering/fairness, generations, expected errors, drain, map bounds/eviction, FDs, submissions, children, and cleanup.

### 4. Profile implementations

- `pr-real`: fast real-Git smoke with reads, writes, local fetch, linked identity, lock failure/retry, fairness, drain, and cleanup.
- `target-real`: exact 30,000 session records, 200 common directories, 100 extra linked worktrees, 300 startup statuses, pathological 30,000 callers → 300 status tasks, 600 mutations, 60 local fetches, and lock recovery.
- `soak`: manual 300-second/20-operations-per-second seeded mixed workload with explicit duration/rate overrides, topology churn, idle eviction, and lifecycle checks.
- `cap-sweep`: identical seeded fixture at caps 2/4/6/8/12 with comparative advisory deltas only.

### 5. Runtime parity boundary

- Use web coordinator/resolver primitives for real Git because they are host-neutral server modules.
- Run an identical deterministic coordinator fixture against web and VS Code implementations and compare exact results/stats.
- Do not import VS Code's built-in Git/Repository API or extension-host-only modules.

### 6. Executable tests and commands

- Add `scripts/perf/git-execution.test.ts` using the harness API.
- Run `pr-real` in the focused test and assert the report contract.
- Run deterministic web/VS Code parity assertions without real VS Code host APIs.
- Add root package scripts for PR smoke, full target, reduced target development, soak, cap sweep, focused test, and harness type-check.
- Ensure existing package suites do not invoke full target/soak/cap-sweep profiles.

### 7. Documentation and closure

- Update `packages/web/server/lib/git/DOCUMENTATION.md` with profile commands, runtime boundary, entity-versus-caller semantics, report/artifact policy, and PR template reference.
- Update canonical plan/todo/phase/implementation/handover state with exact commands/results.
- Run no-install dead-code inspection because executable source files and package scripts are added.

## Expected files

- `scripts/perf/git-execution.ts` (new)
- `scripts/perf/git-execution.test.ts` (new)
- `scripts/perf/tsconfig.json` (new, harness-only type-check)
- `package.json`
- `packages/web/server/lib/git/DOCUMENTATION.md`
- `plans/git-execution-architecture/plan.md`
- `plans/git-execution-architecture/todo.md`
- `plans/git-execution-architecture/phases/phase-4.md` (new)
- `plans/git-execution-architecture/implementation/phase-4-impl.md` (new)
- `plans/git-execution-architecture/handovers/session-2026-07-16.md`

## Validation plan

```bash
bun test scripts/perf/git-execution.test.ts
bun run perf:git:pr-real
bun run perf:git:target-real:dev
bun run perf:git:soak -- --duration-ms 10500 --rate 2
bun run perf:git:cap-sweep
bun run perf:git:type-check
bun run perf:git:lint
bun run --cwd packages/web type-check
bun run --cwd packages/web lint
bunx --no-install knip@5.80.0 --no-exit-code --include files,exports,nsExports,types,nsTypes,enumMembers,duplicates
```

The schema v1 full-target/default-soak note is superseded by the schema v2 closure and deterministic soak correction below. Build remained unnecessary because executable production/package output behavior did not change; this phase adds a standalone test harness only.

## Initial closure (schema v1; superseded)

- Focused harness: 3 passed, 0 failed; `pr-real`: passed in 679.397ms; reduced target: passed in 769.455ms.
- Cap sweep: passed in 847.579ms with exact 800/800 generation movement across 1,200 operations.
- Reduced soak: passed in 10730.271ms with 21 operations, explicit idle eviction, and exact 14/14 generation movement.
- Harness type-check/lint, focused coordinator tests, web/VS Code package checks, and docs validation passed.
- No-install Knip remained noisy and non-blocking at 184 unused files, 303 unused exports, 175 unused exported types, and five hints; it reported no harness path.
- No generated report, temporary Git fixture, profile, trace, dependency, production hook, or CI workflow was added.

### Independent-review closure

- Schema v2 removes aggregate caller duplication and reports explicit entity mapping, scenarios, API submissions, scheduled operations, and Git commands.
- Every API waiter contributes one exact observed-total sample; underlying queue/service/total remains one sample per task that starts.
- One pre-spawn guard enforces fixture cwd/path operands, sanitized Git/credential environment, prompt/hook/auto-GC policy, and registered local remotes. Explicit output is a new canonical file outside the workspace and cannot overwrite retained output.
- Every spawn requires a closed category and operation class. Per-profile category/class maps, success/failure counts, sums, and equations are blocking.
- Final local profiles at that closure point: `pr-real` 607.106ms/31 Git commands; reduced target 786.507ms/75 commands; cap sweep 831.788ms/1 command; short soak 10749.398ms/71 commands. Full target and default soak were then assigned for independent schema v2 rerun; the later soak result/correction supersedes only that soak expectation.
- Final focused suite passed 6 tests in 2.27s; harness type-check/lint and docs validation passed. Root no-install Knip retained the noisy 184-file/303-export/175-type baseline plus five hints and no harness finding.

### Deterministic soak-wave correction

- Root cause: the flat paced plan counted every status caller as one task/Git command, while the production coordinator coalesces same-worktree/shape/generation callers only while the first task remains in flight. Real Git duration therefore changed the observed count.
- Fix level: harness planner/executor. One immutable plan now owns status waves, planned generations, idle segments, dependency gates, scheduled-operation expectations, generation movement, and the command equation. Production coordinator/service behavior remains unchanged.
- Focused suite: 8 passed, 0 failed in 7.56s. It hard-codes the full default plan and runs seed 8755 with both normal and `[0, 75, 5, 120]ms` status timing plus seed 4660 with `[120, 0, 35, 5]ms`; every run matched its plan.
- `pr-real`: passed in 670.287ms with 8 API/scheduled operations and 31 Git commands. Reduced target: passed in 742.835ms with 623 API submissions, 29 scheduled operations, and 75 Git commands. Cap sweep: passed in 869.287ms with 1,200 API/scheduled operations, one Git command, and generation movement 800.
- Normal reduced soak (`10500ms`, rate 2): passed in 10681.433ms with 21 callers/API submissions, 11 status callers in 10 groups, 20 scheduled operations, 70 Git commands, two topology operations, one idle eviction, and generation movement 14. The same plan passed with variable status delays in 10748.303ms.
- Harness type-check/lint passed; docs validation passed for 387 pages and 43 sidebar links. Root no-install Knip retained 184 unused files, 303 unused exports, 175 unused exported types, and five hints, with no harness finding.
- At the deterministic-wave correction point, the target path/accounting had not changed, so only the corrected five-minute soak required a third artifact. That run passed. The later child-runner hardening required both full profiles to rerun from final code; both now pass with the stable evidence recorded above. The earlier failed soak remains non-passing, superseded evidence.

## Risks and controls

- **Entity/concurrency conflation:** schema v2 reports entity mapping, independent scenario callers, API submissions, scheduled operations, and Git commands; label 30,000 caller fan-out pathological.
- **Machine noise:** deterministic counts/lifecycle block; latency is advisory.
- **Unsafe Git behavior:** one executable pre-spawn guard checks every direct child cwd/path contract, sanitized environment, disabled prompts/hooks/auto-GC, and registered local-only remote; explicit output is one new canonical file outside the workspace.
- **Runtime coupling:** web real-Git adapter plus pure coordinator parity; no VS Code built-in API import.
- **Test-suite expansion:** only the focused `*.test.ts` runs under test discovery; expensive profiles require explicit package commands.
- **Artifacts:** stdout by default, explicit output only, no committed reports or fixtures.

## Stop points

1. Stop before any production scheduler/service change or telemetry hook.
2. Stop before dependency, CI workflow, or generated-artifact introduction.
3. Stop if a real-Git fixture cannot cleanly recover from lock failure and remove its root.
4. Stop if deterministic parity differs between web and VS Code coordinators; report the mismatch rather than normalizing it away.
