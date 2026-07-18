# Phase 6 Shared Git Execution Core Implementation Plan

Status: **complete (2026-07-18)**

## Change strategy

Perform one behavior-preserving cross-workspace extraction with a narrowly documented correction for falsy Promise rejection reasons. Keep web and VS Code service/runtime adapters in place, preserve existing import paths, and avoid package/dependency/build-system changes.

## Work packages

### 0. Reconfirm baseline and provenance

Before source edits:

1. Re-run the required existing-PR branch provenance gate against the actual PR base and head remotes.
2. Confirm the working tree is clean and the branch still tracks the intended PR head.
3. Run the focused resolver/coordinator suites and the deterministic harness parity test from unchanged source.
4. Record exact baseline results in the canonical handover. Do not create a temporary report file in the repository.

Stop if the branch diverged, unrelated files appeared, or any baseline contract is already failing.

### 1. Define the canonical JavaScript and declaration contracts

Use the existing web modules as the canonical runtime files:

- `packages/web/server/lib/git/execution-errors.js`
- `packages/web/server/lib/git/context-resolver.js`
- `packages/web/server/lib/git/execution-coordinator.js`

Add:

- `packages/web/server/lib/git/execution-errors.d.ts`
- `packages/web/server/lib/git/context-resolver.d.ts`
- `packages/web/server/lib/git/execution-coordinator.d.ts`

Declaration requirements:

- Export the same runtime values that the JavaScript modules actually expose.
- Define `GitExecutionErrorCode`, error details, resolver results/options/stats, coordinator options/context/leases/stats, status shapes, and generic task/result signatures.
- Use `unknown` and generics rather than `any` or blind casts in the public declarations.
- Keep private queue/map/state structure private; only current callable/observable contracts belong in declarations.
- Type `GIT_READ_ONLY_ENV` as the immutable literal `{ GIT_OPTIONAL_LOCKS: '0' }`.
- Preserve the current VS Code class and factory names by exporting the existing resolver/coordinator classes from canonical JavaScript.

Do not add a barrel export or expose these server internals from the web package's public `server/index` API.

### 2. Reconcile the known implementation drift at the shared level

Apply only these reviewed semantic decisions while the implementation still has full local tests:

1. Add the VS Code implementation's private success sentinel to canonical coordinator operation and clone settlement. Reject with the exact reason for every rejected task, including falsy reasons.
2. Retain the web implementation's runtime argument checks for operation booleans, required worktree identity, injected timers, queue timeout, and canonical clone destination type/value.
3. Retain structural stable-code execution-error recognition. The VS Code declaration supplies narrowing; runtime recognition must not depend on one bundle's class identity.
4. Keep web's existing internal idle-state representation and all currently observable diagnostics/counts unless a combined test proves a mismatch.
5. Make no change to default limits, conflict rules, fairness, network accounting, generation timing, status keys/projection, clone reservation ownership, or idle pruning.

Add focused tests proving that both repository operations and clone reservations preserve falsy rejection reasons and completely release active/pending/network/destination state afterward.

### 3. Replace VS Code copies with thin typed facades

Rewrite the existing VS Code implementation files as explicit re-exports from `../../web/server/lib/git/`:

- `git-execution-errors.ts`
- `git-context-resolver.ts`
- `git-execution-coordinator.ts`

Requirements:

- Preserve all current runtime export names and type export names used by VS Code production/tests.
- Use explicit value and type re-exports so an accidental canonical export does not silently broaden the VS Code facade.
- Leave no copied queue, resolver, error, timer, path, or limit logic in these three TypeScript files.
- Add no `@openchamber/web` dependency. The source-relative ESM import is bundled by the existing extension build.
- Keep `git-execution-runtime.ts`, `git-execution-service.ts`, and `git-execution-scope.ts` package-local and behaviorally unchanged except for any import-type adjustment required by the declarations.

### 4. Preserve runtime-specific classification and consumers

Do not merge either operation table in this phase.

Web consumers to verify:

- `packages/web/server/lib/git/service.js`
- web resolver/coordinator/service tests
- web FS, skills-catalog, and notification service delegates
- Electron's in-process `@openchamber/web` backend

VS Code consumers to verify:

- `git-execution-runtime.ts`
- `git-execution-service.ts`
- bridge Git and filesystem runtime adapters
- skills-catalog clone reservations
- all resolver/coordinator/runtime/service/classification tests

Keep web's pure/global-read/clone profiles and service delegates package-local. Keep VS Code's built-in/raw fallback, unresolved-directory identity, worktree attachment, and direct-owner AST inventory package-local. Similar table entries are not sufficient evidence for shared ownership.

### 5. Convert parity evidence into shared-core provenance evidence

Update `scripts/perf/git-execution.ts` and `scripts/perf/git-execution.test.ts` so they:

1. Load the canonical web modules directly and through the VS Code adapter paths.
2. Assert that resolver/coordinator factories, operation kinds, read-only environment, error codes, and constructors resolve to the intended canonical runtime values.
3. Retain deterministic scenario execution through both loader paths as adapter/bundling coverage, but label it `web-direct` versus `vscode-adapter` rather than independent implementation parity.
4. Keep the existing real-Git web execution profiles, safety guards, exact accounting, artifact policy, and profile limits unchanged.
5. Fail if a future VS Code implementation copy replaces the re-export facade.

Do not rerun or rewrite the Phase 5 historical/current/current+fsmonitor evidence: that benchmark measures the web service architecture before this extraction and remains valid historical evidence.

### 6. Preserve and extend test coverage

- Keep the full canonical web resolver/coordinator suites.
- Keep the existing VS Code suites running through the facade in this first extraction commit; test deduplication is not required to achieve one production implementation and would unnecessarily mix cleanup with the migration.
- Add cross-path identity/provenance assertions and the falsy-rejection cleanup cases.
- Run web service tests because the canonical module remains in its production path.
- Run VS Code runtime/service/classification and bridge suites because the bundled adapter crosses a package and JavaScript/TypeScript boundary.
- Do not weaken the synthetic 30,000-caller bounds/fairness/generation coverage in either package.

### 7. Update owning documentation and durable state

Update:

- `packages/web/server/lib/git/DOCUMENTATION.md` with canonical ownership, TypeScript declaration, VS Code bundling, and runtime-boundary details.
- `packages/vscode/src/DOCUMENTATION.md` to replace the old absolute prohibition on importing web Git modules with the narrow exception for the runtime-neutral shared core; keep service adapters and execution ownership extension-local.
- `plans/git-execution-architecture/plan.md`, `todo.md`, this phase/implementation artifact, and the latest handover with implemented truth and exact validation.

Do not update public product docs because user-visible Git behavior and configuration do not change.

### 8. Validate from narrow to cumulative

Focused behavior:

```bash
bun run --cwd packages/web test -- server/lib/git/context-resolver.test.js server/lib/git/execution-coordinator.test.js server/lib/git/operation-classification.test.js server/lib/git/service.test.js
bun test packages/vscode/src/git-context-resolver.test.ts packages/vscode/src/git-execution-coordinator.test.ts packages/vscode/src/git-execution-runtime.test.ts packages/vscode/src/git-execution-service.test.ts packages/vscode/src/git-operation-classification.test.ts
bun run test:perf:git
bun run perf:git:pr-real
```

JavaScript syntax and declaration consumers:

```bash
node --check packages/web/server/lib/git/execution-errors.js
node --check packages/web/server/lib/git/context-resolver.js
node --check packages/web/server/lib/git/execution-coordinator.js
bun run perf:git:type-check
bun run vscode:type-check
```

Cross-workspace contract and affected builds:

```bash
bun run type-check
bun run lint
bun run build:web
bun run vscode:build
bun run docs:validate
bun run dead-code
git diff --check
```

Packaging check:

1. Run the existing `bun run pack:web` flow with output directed to or immediately moved under an OS temporary boundary.
2. Inspect the archive list for all three canonical `.js` files and all three `.d.ts` sidecars.
3. Confirm `bun run vscode:build` embeds/resolves the shared modules and does not leave a runtime `@openchamber/web` requirement.
4. Remove the generated archive and build-only inspection artifacts before completion; commit none of them.

Validation is blocking for deterministic behavior, exact cleanup/bounds, type resolution, build resolution, package contents, and documentation truth. Existing documented non-blocking build/dead-code warnings may remain only if the output matches the established baseline and contains no new shared-core finding.

## Expected source diff

### Canonical core

- Modify the three existing web implementation modules only as required for exports and rejection correctness.
- Add three sidecar declaration files.
- Extend existing web tests; do not move the web service or route layer.

### VS Code

- Replace three implementation modules with thin re-export facades.
- Make only declaration-driven import adjustments in runtime/service code if type-check requires them.
- Extend existing tests with adapter identity/provenance assertions; retain runtime-specific tests.

### Harness and documentation

- Update the existing execution harness/test terminology and shared-module provenance assertion.
- Update the two owning module documents and canonical Phase 6 planning state.

No package manifest, lockfile, workspace list, dependency, UI, public API, route, persistence, CI, or generated source file should change. If one becomes necessary, stop and request approval for the expanded design.

## Implemented result

- Exported the canonical resolver/coordinator classes and added the three reviewed declaration sidecars without changing the web server's execution model.
- Replaced the three duplicated VS Code implementation files (1,657 lines before extraction) with 34 lines of explicit value/type facades.
- Added the falsy-rejection success sentinel and cleanup regression at the shared/root level.
- Added exact shared-runtime identity evidence to the existing deterministic harness while retaining its schema-v2 `parity` detail key for report compatibility.
- Preserved both package test suites as direct versus adapter evidence and repaired the one global child-process test mock that prevented the full suite from exercising the real runtime test.
- Updated web and VS Code owning documentation; no public product documentation changed.

Validation completed from final source:

- Baselines before extraction: web core 38/38, VS Code core 24/24, performance harness 12/12.
- Web focused core/classification/service: 108/108; web routes: 5/5.
- VS Code focused core/runtime/service/classification: 42/42; full `bun test src`: 89/89 with 865 expectations across 18 files.
- Performance harness: 12/12. `pr-real`: PASS in 738.061ms with 8 API/scheduled operations, 31 Git commands, exact shared-identity evidence, zero timeouts/unexpected errors, and cleanup passed.
- Harness and VS Code TypeScript checks, harness/VS Code/web lint, and workspace-wide type-check/lint passed.
- Web and VS Code production builds passed with the established KaTeX, mixed-import, and large-chunk warnings only. The VS Code extension bundle was 504.2KB and contained the canonical core without a runtime web-package reference.
- Web package inspection included all three canonical `.js` files and all three `.d.ts` sidecars; the temporary archive was removed.
- Documentation validation passed for 387 pages and 43 sidebar links.
- Dead-code inspection retained 184 unused files, 303 unused exports, five configuration hints, and reported 177 unused exported types. The two additions are the intentionally preserved VS Code facade types `GitExecutionCoordinatorOptions` and `GitOperationKind`; no source file or runtime export was newly orphaned.

## Fix level and duplicate handling

- Fix level: shared/root-level, because the same resolver/coordinator/error behavior is currently implemented twice and both runtime adapters depend on it.
- Duplicate production logic removed: resolver, coordinator, and structured errors.
- Duplicate tests intentionally retained for the first migration as cross-runtime adapter/build evidence.
- Runtime-specific logic intentionally left separate: service adapters, operation inventories, fallbacks, background scheduling, command primitives, and public compatibility handling.

## Commit and publication boundary

After all validation passes and only with explicit publication authorization:

1. Re-run existing-PR provenance against the final base/head refs.
2. Review the entire base-to-head diff and the focused Phase 6 diff.
3. Create one separate implementation commit, suggested title: `refactor(git): share execution core across runtimes`.
4. Do not combine conflict resolution, benchmark changes, dependency changes, unrelated cleanup, or PR-body edits into that commit.
5. Before any push/PR update, verify that PR #2276's title/body describes the new shared-core commit and final validation; update it only when publication is explicitly allowed.

Planning-document edits alone do not authorize the implementation commit, push, or PR mutation.
