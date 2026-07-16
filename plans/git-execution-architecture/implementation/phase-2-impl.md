# Phase 2 Implementation Plan

Status: **complete; verification/review closed (2026-07-16)**

## Work packages

### 1. Classification and coordinator resources

- Add a single machine-checked operation classification source for all exported Git service operations and direct-runtime bypass ownership.
- Extend `execution-coordinator.js` with explicit read, worktree-write, common-write, and topology profiles plus a network modifier.
- Add globally bounded canonical clone/destination reservations.
- Add queue timeout errors where callers provide queue timeout/abort signals.
- Add throttled lazy idle pruning on normal admission.
- Make lease coverage rules include base profile, worktree, common, topology, and network ownership.

### 2. Service migration

- Route every exported operation through its classification before any owned Git subprocess.
- Split exported wrappers from unscheduled cores for compound/delegating paths such as status/diff collection, stash pop, worktree validation/create/bootstrap, integration, merge/rebase continuation, and clone setup.
- Keep mutation clients on the normal environment; apply optional locks through the outer observational context only.
- Preserve local-only status probes as local reads; do not label them network operations.
- Preserve original errors, partial conflict responses, rollback, and cleanup behavior.

### 3. Other web-server Git owners

- `fs/routes.js`: replace direct clone spawn with the Git service's bounded clone operation; keep destination existence and response behavior stable.
- `fs/search.js`: replace direct `check-ignore` spawning with a classified observation.
- `skills-catalog/git.js`: schedule clone destinations and temporary-repository commands while preserving timeout/result objects and auth handling.
- `notifications/template-runtime.js`: obtain branch state through the classified Git service operation.
- Update FS/skills/notifications owning docs only where their implementation truth changes.

### 4. Tests and inventory enforcement

- Coordinator tests: every profile, profile combinations, network caps, topology barriers, cross-worktree progress, FIFO fairness, cancellation, queue timeout, lock-error propagation, generation invalidation, clone bounds, lazy pruning, and safe re-entry.
- Resolver/service tests: authoritative `isGitRepository`, representative compound operations, fallback/cleanup, and unchanged response contracts.
- Inventory test: exported service functions exactly match the classification table; direct Git runtime files exactly match migrated owners or documented bypasses.
- Replace the all-status scale fixture with a pathological fan-out guard of 30,000 logical callers comprising 29,400 coalesced observations and 600 mixed worktree/common mutations across 200 common contexts and 300 identities; do not treat it as representative session concurrency.

## Expected files

- `packages/web/server/lib/git/operation-classification.js` (new)
- `packages/web/server/lib/git/operation-classification.test.js` (new)
- `packages/web/server/lib/git/execution-coordinator.js`
- `packages/web/server/lib/git/execution-coordinator.test.js`
- `packages/web/server/lib/git/execution-errors.js`
- `packages/web/server/lib/git/context-resolver.js` / tests if explicit invalidation or authoritative failure coverage requires it
- `packages/web/server/lib/git/service.js`
- `packages/web/server/lib/git/service.test.js`
- `packages/web/server/lib/git/DOCUMENTATION.md`
- `packages/web/server/lib/fs/routes.js`, `routes.test.js`, `search.js`, and `DOCUMENTATION.md`
- `packages/web/server/lib/skills-catalog/git.js` and `DOCUMENTATION.md` plus focused tests
- `packages/web/server/lib/notifications/template-runtime.js`, test, and `DOCUMENTATION.md`
- Canonical Phase 2 planning/handover artifacts only under `plans/git-execution-architecture/`

## Validation

```bash
bun test server/lib/git/context-resolver.test.js server/lib/git/execution-coordinator.test.js server/lib/git/operation-classification.test.js server/lib/git/service.test.js server/lib/git/routes.test.js
bun test server/lib/fs/routes.test.js server/lib/fs/search.test.js
bun test server/lib/skills-catalog/git.test.js server/lib/notifications/template-runtime.test.js
node --check <every changed runtime .js file>
bun run type-check
bun run lint
bunx --no-install knip@5.80.0 --no-exit-code --include files,exports,nsExports,types,nsTypes,enumMembers,duplicates
```

Use the cached Knip only with `--no-install`; inspect whether any new file/export is reported separately from the existing baseline.

Final result: 145 focused tests passed with 647 assertions across 10 files; runtime syntax, web type-check, and web lint passed. Root-scoped cached no-install Knip reported 189 unused files, 304 unused exports, and 176 unused exported types with its stale-cache warning.

Verification closure also requires:

- executable `skills-catalog/git.test.js` scan/install coverage using the real clone coordinator with controlled Git results;
- post-lease fast-create background admission and deterministic pending-to-ready/failed polling;
- structured worktree-validation execution errors, one outer lease, and unscheduled core probes using that lease;
- side-effect-free `getStats()` with fake-clock admission/drain pruning tests;
- abort-aware `/api/fs/list` timeout cleanup and removal of stale Git-spawn composition arguments;
- documentation of legacy `getWorktrees` empty-on-failure behavior without changing that public contract.

## Risks and controls

- **Broad migration:** classification is machine-checked and changes stay inside existing server owners.
- **Deadlock:** one outer lease, direct cores, and immediate incompatible-reentry errors.
- **Network head-of-line blocking:** network is a capacity modifier; only the base resource profile controls conflicts.
- **Fast worktree creation:** background Git attachment/bootstrap receives its own classified lease; user-authored start scripts are explicitly outside the scheduler claim.
- **Stale topology identity:** invalidate only removed/pruned worktree identities; resolver retains no completed positive context cache.
- **External mutation/processes:** preserve Git errors and rely on Git locks; no false cross-process guarantee.
