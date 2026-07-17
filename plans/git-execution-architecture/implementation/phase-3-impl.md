# Phase 3 Implementation Plan

Status: **completed, including verification/review closure (2026-07-16)**

## Work packages

### 1. Package-local execution primitives

- Add typed structured execution errors, a dependency-injected bounded context resolver, and a conflict-aware coordinator under `packages/vscode/src/`.
- Preserve Phase 1/2 identity, conflict, generation, fairness, network, clone-reservation, count-bound, and lazy-cleanup invariants without importing the web implementation.
- Add deterministic unit tests, including a seeded pathological 30,000-caller fan-out fixture that asserts exact completion, mutation/network counts, generations, cleanup, every bound, and no session-derived identities while fairness remains independently covered; it is not representative session concurrency.

### 2. Closed operation and owner classification

- Classify all 51 imported function exports in `gitService.ts` as bootstrap, memory, read, worktree write, common write, common+target write, or topology write, with explicit network usage.
- Add an internal classification for worktree attachment/bootstrap.
- Record extension-host direct owners and intentional bypasses in one immutable inventory.
- Reflect the actual imported module function exports semantically, require each exactly once, and scan direct child-process Git ownership through the TypeScript compiler AST. Source-string checks remain supplemental.

### 3. Service facade and background work

- Add a typed facade that resolves context and acquires the operation's outer lease before calling `gitService.ts`. Expose an injected factory for executable tests while production uses one explicit default core dependency table.
- Add a real facade suite for built-in/raw same-lease behavior, optional-lock scope, status sharing, post-parent worktree admission, structured errors, ordinary fallback, and table-driven delegation of all 51 classified operations.
- Preserve all function signatures and result shapes exposed to bridge handlers.
- Coalesce only `getGitStatus` in flight, with full/light projection and mutation generations.
- Keep `getWorktreeBootstrapStatus` memory-only and repository detection in bounded bootstrap discovery.
- Inject background scheduling for fast worktree attachment and bootstrap so neither escapes the coordinator; keep user-authored start commands documented outside the claim.

### 4. Other extension-host Git owners

- Split raw process execution into an unscheduled primitive and a scheduled execution runtime.
- Route conflict details and filesystem `check-ignore` observations through scheduled reads.
- Keep arbitrary `api:fs:exec` and Git child-process helpers as explicit bypasses.
- Wrap skills-catalog cloning in destination/network reservations while preserving `git --version`, auth-result, timeout, fallback, installation, and cleanup behavior.

### 5. Compatibility and verification

- Preserve built-in Repository API-first behavior, raw fallback behavior, RuntimeAPI payloads, BridgeResponse envelopes, and documented legacy clean/empty results.
- Fix the existing combined bridge-test mock leakage through explicit special-runtime Git dependency injection rather than weakening or splitting validation.
- Update `packages/vscode/src/DOCUMENTATION.md` with exact guarantees and limits.
- Run focused tests, `bun run type-check`, `bun run lint`, `bun run build`, and root-scoped no-install Knip; report any pre-existing/noisy findings separately.

## Expected files

- `packages/vscode/src/git-execution-errors.ts` (new)
- `packages/vscode/src/git-context-resolver.ts` (new)
- `packages/vscode/src/git-execution-coordinator.ts` (new)
- `packages/vscode/src/git-operation-classification.ts` (new)
- `packages/vscode/src/git-execution-runtime.ts` (new)
- `packages/vscode/src/git-execution-service.ts` (new)
- focused tests for resolver, coordinator, classification, facade/raw ownership, and skills clone reservation
- `packages/vscode/src/gitService.ts`
- `packages/vscode/src/bridge-git-process-runtime.ts`
- `packages/vscode/src/bridge-git-runtime.ts`
- `packages/vscode/src/bridge-git-special-runtime.ts`
- `packages/vscode/src/bridge.ts`
- `packages/vscode/src/bridge-fs-helpers-runtime.ts`
- `packages/vscode/src/skillsCatalog.ts`
- `packages/vscode/src/DOCUMENTATION.md`
- canonical Phase 3 plan/todo/handover artifacts

## Risks and controls

- **Built-in/raw split:** lease in the facade before the core chooses either path.
- **Nested deadlock:** only facade entrypoints schedule; core-to-core calls are direct. Incompatible explicit re-entry fails.
- **Background escape:** worktree attachment/bootstrap receive separately admitted operations queued behind the initiating topology lease.
- **Admitted cancellation:** do not claim to cancel built-in promises; keep their lease until settlement.
- **Status staleness:** in-flight only, generation keyed, no completed cache.
- **Temporary clone races:** canonical destination reservation plus global network cap; release/cleanup tested.
- **Test isolation:** use dependency injection for specialized bridge Git reads instead of relying on cross-file module mocks.

## Validation commands

```bash
bun test src/bridge-git-runtime.test.js src/bridge-git-special-runtime.test.js src/git-execution-service.test.ts
bun test src
bun run type-check
bun run lint
bun run build
bunx --no-install knip@5.80.0 --no-exit-code --include files,exports,nsExports,types,nsTypes,enumMembers,duplicates
```

The final focused command covers the bridge/facade follow-up. Its production-listener case runs the real provider dispatch graph in an isolated Bun process so cross-file module mocks cannot replace production dependencies. Combined execution must remain green; per-file-only success is insufficient because the baseline exposed cross-file mock leakage.

## Completion result

The exact focused command above completed with 17 tests, 0 failures, and 173 assertions. Its isolated production-listener case completed with 1 test, 0 failures, and 7 assertions. The package-wide combined suite (`bun test src`) completed with 84 tests, 0 failures, and 837 assertions across 18 files. `bun run type-check`, `bun run lint`, and `bun run build` passed; the production build retained only the existing non-blocking KaTeX font-resolution, mixed-import, and large-chunk warnings.

Root-scoped no-install Knip returned the established noisy baseline of 189 unused files, 304 unused exports, 176 unused exported types, and five configuration hints. No new Phase 3 finding remained; Knip retained its stale cached-install warning. The conditional shared-web regression was not run because no shared web file changed.
