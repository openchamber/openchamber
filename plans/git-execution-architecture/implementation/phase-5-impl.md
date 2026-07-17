# Phase 5 Implementation Plan

Status: **complete (2026-07-18)**

## Work packages

### 1. Architecture-neutral runner

- Add a standalone comparison harness under `scripts/perf/`.
- Materialize the historical `service.js` with `git show` after proving the baseline is the direct parent of the architecture commit.
- Run historical/current modules in isolated workers so module singletons, environment, queues, and caches cannot cross-contaminate results.

### 2. Real-Git fixture and workload

- Create deterministic local seed/bare repositories, 200 clones, and 100 linked worktrees under one temporary boundary per worker.
- Build 30,000 session records without invoking the service.
- Execute status, staged mutation, and local fetch operations only through exports shared by both service versions.
- Keep the 30,000-caller fan-out behind a separate explicit profile and submit fixed 600-caller waves for safe legacy comparison. Retain the exact simultaneous burst only in the current-architecture guard.

### 3. Correctness and measurements

- Validate per-worktree status identity and final staged paths with direct oracle Git excluded from workload counts.
- Record per-operation latency distributions and overall workload throughput.
- Prepend a temporary POSIX shim to PATH; log one start record and `exec` the real Git binary so both implementations receive the same low-overhead launch counter.
- Snapshot exact Git launches per scenario and report the direct-child scope/caveat.

### 4. Focused tests and discovery guard

- Test profile cardinalities, CLI validation, baseline-parent verification, output boundaries, and a reduced real-Git current/current comparison.
- Prove no normal test script invokes representative target or pathological fan-out.

### 5. Validation and evidence

```bash
bun test scripts/perf/git-service-comparison.test.ts
bun run perf:git:compare:smoke
bun run perf:git:compare:target
bun run perf:git:type-check
bun run perf:git:lint
bun run docs:validate
bun run dead-code
```

- Run the pathological profile only after the representative target is stable and with an explicit long timeout.
- Keep raw reports local and uncommitted; curate only reviewed before/after evidence.

## Expected files

- `scripts/perf/git-service-comparison.ts`
- `scripts/perf/git-service-comparison.test.ts`
- `package.json`
- `packages/web/server/lib/git/DOCUMENTATION.md`
- canonical Phase 5 plan/todo/phase/implementation/handover artifacts

## Non-goals

- No shared web/VS Code production module yet.
- No VS Code built-in Git API benchmark; its child processes are owned by VS Code and cannot be counted through this web-service runner.
- No production scheduler/default changes, dependencies, CI, or machine-specific latency threshold.

## Implemented result

- Added the standalone service comparison harness, focused tests, package scripts, owning documentation, curated evidence, and canonical Phase 5 state.
- Historical/current workers validate their unique temporary boundary, service source hash, fixed profile, executable, and cleanup target before creating or deleting fixture data.
- Both workers use authoritative Git topology checks, per-worktree status identity checks, final staged-state oracles, local-only fetches, exact launch accounting, advisory latency distributions, and outer cleanup.
- Focused suite passed 5/5; the existing execution harness remained 12/12. Harness type-check/lint, docs validation, diff check, and non-blocking dead-code inspection passed/ran as recorded in the handover.
- Final representative and pathological evidence is curated in `reviews/benchmark-report.md`; raw JSON remains local and uncommitted.
