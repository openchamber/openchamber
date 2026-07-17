# Phase 1 Implementation Plan

## Planned files

- `packages/web/server/lib/git/context-resolver.js`
  - Dependency-injected discovery, canonicalization, single-flight, global discovery pool, structured non-repository result, and statistics.
- `packages/web/server/lib/git/context-resolver.test.js`
  - Relative paths, aliases, symlinks, linked worktrees, Windows case folding, confirmed non-repositories, single-flight, overload, and cleanup/bounds.
- `packages/web/server/lib/git/execution-coordinator.js`
  - Explicit read/worktree-write/common-write conflict model, limits, fairness, generations, status in-flight coalescing, cancellation, cleanup, and diagnostics.
- `packages/web/server/lib/git/execution-coordinator.test.js`
  - Deferred deterministic conflict/fairness/backpressure/re-entry/status tests plus the seeded pathological 30,000-caller fan-out guard.
- `packages/web/server/lib/git/service.js`
  - Remove the promise-chain queue; integrate resolver/coordinator into Phase 1 operations; isolate read-only environment; keep compound cores non-reentrant.
- `packages/web/server/lib/git/service.test.js`
  - Preserve existing integration tests and add focused read-environment/identity or operation behavior coverage where observable without fragile internals.
- `packages/web/server/lib/git/DOCUMENTATION.md`
  - Document implemented ownership/invariants/limits and explicitly defer remaining operation, network/topology, and VS Code work.

## Sequence

1. Implement and test the resolver in isolation.
2. Implement and test coordinator conflict/resource semantics in isolation.
3. Add the synthetic scale test using injected immediate/deferred work, not real Git processes.
4. Integrate a single module-owned resolver/coordinator in `service.js` and delete the PR #2232 promise-chain queue.
5. Split scheduled wrappers from operation cores where needed so compound paths do not reacquire their own lease.
6. Give status/diff Git clients and direct subprocesses a read-only environment override; leave mutation clients unchanged.
7. Preserve route contracts and rerun baseline tests.
8. Run syntax checks, focused tests, package checks, and dead-code analysis; record exact results.

## Validation commands

```bash
bun test server/lib/git/context-resolver.test.js server/lib/git/execution-coordinator.test.js
bun test server/lib/git/service.test.js server/lib/git/routes.test.js
node --check server/lib/git/context-resolver.js
node --check server/lib/git/execution-coordinator.js
node --check server/lib/git/service.js
bun run type-check
bun run lint
bun run dead-code
```

The final command runs at repository root. Its report is non-blocking but must be inspected.

## Implemented outcome

The planned slice is complete. One additional focused internal file was required:

- `packages/web/server/lib/git/execution-errors.js` centralizes the internal overload, cancellation, and incompatible re-entry error codes/classes used by resolver and coordinator.

No route, UI, dependency, package export, persistence, Electron bridge, or VS Code file changed.

### Exact implementation files

- `packages/web/server/lib/git/context-resolver.js`
- `packages/web/server/lib/git/context-resolver.test.js`
- `packages/web/server/lib/git/execution-coordinator.js`
- `packages/web/server/lib/git/execution-coordinator.test.js`
- `packages/web/server/lib/git/execution-errors.js`
- `packages/web/server/lib/git/service.js`
- `packages/web/server/lib/git/service.test.js`
- `packages/web/server/lib/git/DOCUMENTATION.md`

### Final validation

```text
bun test server/lib/git/context-resolver.test.js server/lib/git/execution-coordinator.test.js server/lib/git/service.test.js server/lib/git/routes.test.js
77 pass, 0 fail, 193 assertions

node --check (execution-errors, context-resolver, execution-coordinator, service, routes)
pass

Node ESM import smoke (context-resolver, execution-coordinator, service)
pass

bun run type-check  # packages/web
pass

bun run lint        # packages/web; configured src TS/TSX scope
pass

bunx --no-install knip@5.80.0 --no-exit-code --include files,exports,nsExports,types,nsTypes,enumMembers,duplicates
completed with the existing repository baseline (189 unused files, 354 unused exports, 176 unused exported types); no new Git execution module was reported; cached Knip warned that its installation is stale
```
