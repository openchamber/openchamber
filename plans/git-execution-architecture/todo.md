# Git Execution Architecture Todo

## Phase 1

- [x] Read repository rules, required skills, package/module documentation, PR #2232 implementation, and nearby tests.
- [x] Establish baseline: 49 service tests + 5 route tests pass.
- [x] Implement injected bounded Git context resolver.
- [x] Implement conflict-aware bounded coordinator with fairness, structured overload/cancellation, generations, cleanup, and safe re-entry behavior.
- [x] Replace the PR #2232 promise-chain queue for the Phase 1 status/mutation paths.
- [x] Apply `GIT_OPTIONAL_LOCKS=0` only to read-class status/diff subprocesses.
- [x] Add generation-aware full/light in-flight status coalescing and waiter-local cancellation.
- [x] Add deterministic resolver/coordinator tests and the seeded pathological 30,000-caller fan-out guard.
- [x] Add focused service integration coverage without changing route contracts.
- [x] Update Git module documentation to implemented truth and label later phases.
- [x] Run focused tests, syntax checks, web type-check/lint, and dead-code analysis required by project guidance.
- [x] Update this todo and the session handover with exact results and remaining work.

## Phase 2

- [x] Re-read Phase 1 durable state, required skills/docs, and independent reviewer findings.
- [x] Inventory exported Git service operations and OpenChamber-owned web-server Git subprocess owners.
- [x] Add machine-checked operation and bypass classification.
- [x] Extend explicit coordinator profiles, network limits, clone reservations, queue timeout, lease coverage, and admission pruning.
- [x] Migrate every remaining Git service operation using outer leases and unscheduled cores.
- [x] Migrate FS clone/list/search, skills-catalog Git, and notification branch lookup ownership.
- [x] Add authoritative `isGitRepository` service coverage and documentation.
- [x] Add profile, compound, network, topology, cancellation, generation, external-lock, inventory, and mixed-scale tests.
- [x] Update Git and affected owning FS/skills/notifications documentation to implemented truth.
- [x] Run focused tests/syntax, web type-check/lint, and no-install dead-code analysis.
- [x] Update Phase 2 plan/todo/handover with exact files/results and leave Phase 3 unstarted.

### Verification/review closure

- [x] Add executable skills-catalog scan/install reservation, fallback, release timing, concurrency, and cleanup tests.
- [x] Release the fast-create topology lease before background worktree attachment admission; test pending to ready/failed behavior.
- [x] Preserve structured execution failures from worktree validation and prove core helpers reuse the outer lease without optional-lock mutation leakage.
- [x] Make coordinator diagnostics side-effect-free while retaining admission/drain idle pruning.
- [x] Cover `/api/fs/list` abort timeout fail-open behavior and remove stale feature-route composition arguments.
- [x] Record the legacy `getWorktrees` empty-on-failure risk without changing its public contract.
- [x] Run combined focused tests, syntax, web type-check/lint, and root-scoped no-install dead-code analysis; update exact canonical results.

## Phase 3

- [x] Re-read repository rules, required skills, VS Code docs/package scripts, and all canonical Phase 1/2 state.
- [x] Inventory `gitService.ts`, bridge raw Git owners, filesystem ignore probes, skills-catalog cloning, direct imports, and existing tests.
- [x] Reject raw-only coordination and document the safe top-level facade strategy.
- [x] Create the Phase 3 phase and implementation artifacts before source implementation.
- [x] Add typed bounded context resolution and conflict-aware execution coordination with deterministic/scale tests.
- [x] Add machine-checked service-operation and direct-owner classification.
- [x] Add the service facade before built-in/raw choice and coordinate fast-create attachment/bootstrap.
- [x] Migrate bridge conflict details, filesystem ignore probes, and skills-catalog clone ownership.
- [x] Preserve and test legacy clean/empty contracts and combined bridge-test isolation.
- [x] Update VS Code owning documentation with guarantees, limits, cancellation semantics, and bypasses.
- [x] Run focused combined tests, type-check, lint, production build, and root-scoped no-install dead-code analysis.
- [x] Record exact results and remaining risks in the canonical handover.

### Verification/review closure

- [x] Add the real dependency-injected `git-execution-service.test.ts` and executable delegation coverage.
- [x] Replace sole regex/string inventory proof with runtime export reflection and TypeScript AST raw-owner scanning.
- [x] Strengthen the seeded pathological 30,000-caller fan-out mutation, network, generation, cleanup, bounds, and identity assertions.
- [x] Repair `bridge-git-special-runtime.ts` callback indentation without changing behavior.
- [x] Document skills clone network-token release versus retained destination/temporary-repository ownership.
- [x] Run focused and full VS Code validation plus root no-install Knip; run web regression only if shared web files change.
- [x] Correct every Phase 3 validation command, file count, result, and completion statement to final truth.

### Initial validation (superseded by schema v2 closure)

- Focused bridge/facade follow-up: 17 passed, 0 failed, 173 assertions.
- Isolated production-listener case: 1 passed, 0 failed, 7 assertions.
- Full `bun test src`: 84 passed, 0 failed, 837 assertions across 18 files.
- Type-check and lint: passed with no diagnostics.
- Production build: passed with the existing non-blocking KaTeX font-resolution, mixed-import, and large-chunk warnings.
- Root no-install Knip: established noisy baseline of 189 unused files, 304 unused exports, 176 unused exported types, five configuration hints, and the stale-install warning; no new Phase 3 finding remained.
- Conditional shared-web regression: not run because no shared web file changed.

## Phase 4

- [x] Re-read canonical plans, repository/package scripts, performance/change skills, benchmark conventions, owning Git docs, and both coordinator/resolver APIs.
- [x] Create the Phase 4 phase and implementation blueprint before harness source changes.
- [x] Add the standalone real-Git harness, hardened disposable fixture, metrics/report contract, and CLI profiles.
- [x] Add deterministic web/VS Code coordinator parity and focused executable `pr-real` coverage.
- [x] Add package scripts for PR smoke, target, reduced development target, soak, cap sweep, focused tests, and harness type-check.
- [x] Label existing synthetic 30,000-caller tests and docs as pathological fan-out correctness guards; distinguish them from 30,000 session entities.
- [x] Update owning Git documentation with commands, runtime boundary, metrics/assertions, artifact policy, and PR body template.
- [x] Run focused harness/PR smoke, reduced target, type/syntax/lint, relevant package checks, and no-install dead-code inspection.
- [x] Record exact results, defaults, remaining concerns, and independent `target-real` readiness in the latest handover.

### Final validation

- Focused harness: 3 passed, 0 failed across one file.
- `pr-real`: passed in 679.397ms with 30 logical sessions, 8 submissions/underlying operations, 31 Git commands, exact generation movement 8, one expected lock failure/retry, and complete cleanup.
- Reduced `target-real --development`: passed in 769.455ms with 600 logical sessions, 6 worktree identities, 623 submissions, 29 underlying operations, 75 Git commands, and exact generation movement 34.
- Cap sweep: passed in 847.579ms across caps 2/4/6/8/12 with 1,200 identical-fixture operations, exact generation movement 800, zero unexpected errors, and no production-default change.
- Reduced soak (`--duration-ms 10500 --rate 2`): passed in 10730.271ms with 21 operations, topology and forced-idle churn, exact generation movement 14, and complete drain/cleanup.
- Harness type-check/lint, web and VS Code coordinator tests, both package type-check/lint pairs, and documentation validation passed.
- Root no-install Knip remained a noisy non-blocking baseline: 184 unused files, 303 unused exports, 175 unused exported types, and five configuration hints; no harness path was reported.
- [x] Independent tester: full target and corrected default soak passed with exact schema-v2 counts in unique external artifacts. The earlier failed soak remains non-passing and excluded from PR evidence.

### Independent tester review closure

- [x] Replace aggregate caller duplication with explicit entity mapping, scenario caller counters, coordinator API submissions, underlying scheduled operations, and Git commands.
- [x] Add all-waiter observed total latency while retaining separately labeled underlying queue/service/total latency.
- [x] Replace declarative safety booleans with executable pre-spawn fixture/path/remote/output/environment guards and report guard evidence.
- [x] Require a closed Git-command category at every spawn and block on exact category/class equations and totals per profile.
- [x] Add schema/counter/latency/safety/accounting regression tests and update owning docs, handover, and PR template.
- [x] Run focused tests, `pr-real`, reduced target, cap sweep, short soak, harness type-check/lint, and docs validation; record exact replacement results and full-profile rerun scope.

### Deterministic soak-wave correction

- [x] Reproduce the accounting flaw from the flat paced plan and trace status coalescing to the worktree/shape/generation in-flight key.
- [x] Precompute seeded status groups by wave, worktree, generation epoch, and idle segment; make one immutable plan drive execution and exact expectations.
- [x] Gate same-worktree groups and mutations in plan order, and make fetch/topology operations common-context barriers without serializing unrelated contexts.
- [x] Add repeated real-Git short-soak coverage across seeds and variable status durations.
- [x] Run focused profiles/static checks, replace stale default-soak equations, and request only a third unique default-soak artifact.

### Schema v2 review-closure validation

- Focused harness: 6 passed, 0 failed across one file.
- `pr-real`: passed in 607.106ms; entity mapping 30 → 2 → 0/0/0; 8 API submissions, 8 scheduled operations, 31 Git commands; command equation `1 + 20 + 2 + 6 + 2 + 0 = 31`; 30 successes/1 expected failure; all 31 direct children passed every child guard.
- Reduced target: passed in 786.507ms; entity mapping 600 → 6 → 0/0/0; startup 6/6/6/6; pathological fan-out 600 callers/600 API submissions/6 scheduled operations/6 Git commands; waiter/underlying fan-out latency counts 600/6; 623 API submissions, 29 scheduled operations, and 75 Git commands.
- Cap sweep: passed in 831.788ms; 1,200 scenario callers/API submissions/scheduled operations, one environment Git command, exact 800/800 generation movement, and complete safety/accounting evidence.
- Short soak (`--duration-ms 10500 --rate 2`): passed in 10749.398ms; 21 callers/submissions/scheduled operations, 71 Git commands, exact 14/14 generation movement, and exact per-class waiter/underlying sample counts.
- Full schema v2 `target-real` expectation: 30,000 entities → 300 identities → 0/0/0 mapping work; 30,962 API submissions, 1,262 scheduled operations, 2,876 Git commands; pathological waiter/underlying latency counts 30,000/300.
- Default schema v2 soak expectation at seed 8755 was 6,000 callers/submissions/scheduled operations and 6,164 Git commands. The independent failed soak proved that timing-dependent assumption invalid; it is superseded by the deterministic correction below.
- Final harness type-check/lint and documentation validation passed; docs validation covered 387 pages and 43 sidebar links.
- Root no-install Knip remained at the noisy non-blocking 184-file/303-export/175-type baseline plus five hints and the stale-install warning; no harness path was reported.

### Deterministic soak-wave validation

- Default seed 8755 plan: 6,000 callers/API submissions; 3,279 status callers in 1,869 groups; 4,590 scheduled operations; 4,754 Git commands; generation movement 3,116; command equation `1 + 39 + 6 + 4649 + 0 + 59 = 4754`.
- Focused harness: 8 passed, 0 failed in 7.56s, including hard exact default-plan assertions and repeated real-Git soaks for seed 8755 under normal/variable status duration plus seed 4660 under a second variable pattern.
- `pr-real`: 670.287ms/31 Git commands; reduced target: 742.835ms/75 Git commands; cap sweep: 869.287ms/one Git command and 800 generation movement.
- Normal short soak (`10500ms`, rate 2): 10681.433ms, 21 API submissions, 11 status callers/10 groups, 20 scheduled operations, 70 Git commands, two topology operations, one idle eviction, and generation movement 14. Variable-delay replay of the same plan passed in 10748.303ms.
- Harness type-check and lint passed. Documentation validation passed for 387 pages and 43 sidebar links. Root no-install Knip retained the established noisy 184-file/303-export/175-exported-type baseline plus five hints and did not report the harness.

### Final harness hardening

- [x] Add a configurable conservative per-Git-child timeout with harness-owned termination, graceful-to-force escalation, close/reap waiting, balanced metrics, and cleanup coverage.
- [x] Reject soak-only duration/rate flags for every non-soak CLI profile and cover parser plus executable CLI behavior.
- [x] Prove focused/root test discovery cannot admit full target or the five-minute soak; retain package scripts as the reviewed full-profile entrypoints.
- [x] Record independently verified target/corrected-soak PASS evidence and explicitly exclude the earlier failed soak from PR evidence.
- [x] Run focused tests, `pr-real`, timeout/short-soak regression, harness type-check/lint, docs validation, and no-install dead-code inspection.
- [x] Require independent final-code target/default-soak reruns because `GitRunner` changes.
- [x] Independently rerun full target and corrected five-minute soak from final code into new external artifacts; exact counts, zero child timeouts/unexpected errors, and cleanup all passed.

Final-code full-profile evidence:

- Target PASS: 30,962 API / 1,262 scheduled / 2,876 Git; fan-out 30,000 waiter / 300 underlying; generation 1,324; zero timeouts/unexpected errors; cleanup passed.
- Corrected soak PASS: 6,000 API / 4,590 scheduled / 4,754 Git; status 3,279 callers / 1,869 groups; generation 3,116; zero timeouts/unexpected errors; cleanup passed.
- Earlier failed soak: non-passing, superseded by the final corrected soak, and excluded from PR evidence.

Local hardening validation:

- Focused harness: 12 passed, 0 failed. Timeout probes covered graceful close and POSIX force escalation at a 200ms test timeout, one termination attempt, actual close/reap, balanced command/child/submission state, and successful fixture cleanup.
- `pr-real`: PASS with 8 API/scheduled operations, 31 Git commands, the 60,000ms default, and zero timeouts.
- Short soak (`10500ms`, rate 2): PASS with 21 API submissions, 20 scheduled operations, 70 Git commands, generation 14, the 60,000ms default, and zero timeouts.
- Harness type-check/lint passed. Docs validation passed for 387 pages and 43 sidebar links. Root no-install Knip retained 184 unused files, 303 unused exports, 175 unused exported types, and five hints with no harness finding.
- [x] Add executable web/VS Code `core.fsmonitor` pass-through coverage and document the manual-config/no-mutation contract.

## Blocked ideas

- [ ] Completed-result caching/SnapshotStore remains blocked until authoritative external Git invalidation exists.
