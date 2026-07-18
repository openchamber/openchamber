# Phase 6 — Shared Web/VS Code Git Execution Core

Status: **complete (2026-07-18)**

## Goal

Replace the duplicated web and VS Code implementations of Git context resolution, execution coordination, and structured execution errors with one runtime-neutral core while preserving each runtime's existing service adapters, operation inventories, public responses, and execution boundaries.

## Behavioral contract

- Users continue to invoke normal Git actions through the existing Git UI, HTTP routes, and VS Code bridge messages; no new configuration or manual/internal input is introduced.
- User-authored values such as branch names, commit messages, paths, and worktree options continue to enter through the existing web service or VS Code facade. Repository identity, generations, queue state, and conflict lanes remain system-derived internal values.
- Web/Electron continue to use the web Git service. VS Code continues to acquire one outer lease before its built-in Repository API/raw fallback decision. Hosted and Capacitor mobile continue to delegate Git work to their connected server.
- Existing route payloads, `RuntimeAPI` payloads, `BridgeResponse` envelopes, compatibility fallbacks, cancellation semantics, and Git-owned lock/fsmonitor behavior remain unchanged.
- No queue, lease, identity, generation, profile, or raw scheduler control is exposed to normal users.

## Architectural decision

### Canonical runtime module

Keep the canonical runtime-neutral ESM implementation at the existing published web-server paths:

- `packages/web/server/lib/git/execution-errors.js`
- `packages/web/server/lib/git/context-resolver.js`
- `packages/web/server/lib/git/execution-coordinator.js`

Add matching sidecar declarations at the same paths with `.d.ts` extensions. The declarations define the shared TypeScript contract without introducing a build step for the Node-executed web server.

The existing classes become explicit exports so the current VS Code module surface can be preserved. Factory functions remain the primary construction API.

### VS Code adapter

Retain these existing VS Code module paths as thin, explicitly typed re-export facades:

- `packages/vscode/src/git-execution-errors.ts`
- `packages/vscode/src/git-context-resolver.ts`
- `packages/vscode/src/git-execution-coordinator.ts`

They import the canonical `.js` modules by repository-relative source path. VS Code's existing esbuild step bundles the shared implementation into `dist/extension.js`, so the packaged extension has no runtime dependency on `@openchamber/web` and no package-manifest dependency is added.

### Why this ownership is the smallest complete change

- `@openchamber/web` publishes and executes its server JavaScript directly; keeping the canonical files under `packages/web/server` guarantees they remain in the existing package archive without generated copies or a new server compilation step.
- A new workspace package would add package/version/publication ownership and dependency changes for three implementation files. That is unnecessary for the two current consumers and remains outside Phase 6.
- `packages/ui` is a browser-facing shared UI package and must not own Node Git execution internals.
- Keeping the VS Code module names preserves all current extension-host imports and lets its package tests and type-check continue to validate the adapter boundary.
- Electron already starts the web backend in-process and therefore receives the canonical core through `@openchamber/web`; mobile surfaces continue to use their server and require no local scheduler copy.

## Shared and runtime-specific boundaries

### Shared core

- Structured execution error codes, constructors, details, and structural recognition.
- Canonical repository/worktree discovery, path normalization, single-flight behavior, bounds, waiter-local cancellation, and diagnostics.
- Conflict scheduling, fairness, limits, clone reservations, generations, status in-flight sharing, lease coverage, cancellation/timeout cleanup, idle pruning, and diagnostics.
- `GIT_OPERATION_KIND` and `GIT_READ_ONLY_ENV`, because they are direct coordinator contracts.

### Package-local adapters

- Web `service.js`, route behavior, simple-git/raw command ownership, validation compatibility, and web operation/owner inventories.
- VS Code `git-execution-runtime.ts`, `git-execution-service.ts`, execution scope, built-in Repository API/raw fallback, unresolved-directory fallback identity, background worktree scheduling, and direct-owner inventory.
- Both `operation-classification` modules. Their service names and valid profile domains differ: web additionally owns pure/global-read/clone-reservation operations, while VS Code owns extension-specific worktree attachment and fallback behavior. Phase 6 must not force these tables into one schema merely because their storage shape is similar.

## Required semantic reconciliation

The implementations are close but not byte-equivalent. Extraction must establish one explicit contract before deleting either copy:

1. Preserve every existing conflict, fairness, limit, generation, status-sharing, cancellation, cleanup, and identity assertion from both suites.
2. Adopt an explicit success sentinel for operation and clone settlement so a task rejection with `undefined`, `null`, `false`, `0`, or an empty string remains a rejection. The current VS Code implementation already does this; the web truthiness check is a correctness defect and must receive a focused regression test.
3. Preserve the web implementation's runtime validation for boolean options, worktree identities, clone destination identity, injected timers, and nullable omitted queue timeouts. Typed VS Code callers already satisfy these checks.
4. Keep execution-error recognition structural by stable code so errors remain recognizable across module/bundle boundaries. The declaration must expose the type guard without requiring `instanceof` identity.
5. Preserve the resolver's confirmed-non-repository versus infrastructure-failure distinction, canonical path outputs, Windows case folding, bounded maps/queue, and waiter-local cancellation.
6. Preserve existing export names and type-only imports for every current consumer. Any intended export-surface difference must be documented and tested before a wrapper replaces its implementation.
7. Treat test-coverage differences as evidence to combine, not as permission to weaken either runtime's contract.

If baseline tests reveal a material behavioral conflict not covered by this reconciliation, stop and update this plan before selecting a winner.

## Entry conditions

- The existing PR branch is clean, current with its head remote, and contains only the Git execution work package.
- Current focused web, VS Code, and deterministic parity checks are green before extraction.
- Source implementation is separately authorized; this planning phase alone does not authorize a commit, push, PR update, dependency, or package-layout change.
- No new dependency, workspace package, generated source copy, or server build step is required.

## Exit criteria

- Exactly one resolver, coordinator, and error implementation remains.
- VS Code's three former implementation modules contain only explicit re-exports/types and no scheduler/resolver/error logic.
- Web/Electron and VS Code service-level behavior remains covered through their existing adapters.
- The performance harness identifies web-direct and VS Code-adapter loading of the same implementation rather than claiming parity between independent algorithms.
- Focused tests, real-Git smoke, workspace type-check/lint, affected builds, package-content inspection, documentation validation, and dead-code inspection pass.
- Owning web and VS Code documentation describes the implemented shared-core boundary accurately.
- The implementation is isolated from the benchmark commits and is committed/published only after the normal provenance and publication gates.

## Result

- The existing web ESM files are now the only resolver, coordinator, and execution-error implementation. Their classes are explicit exports and three strict `.d.ts` sidecars define the shared TypeScript contract.
- The three VS Code modules retain their old import paths as explicit typed re-export facades. The production extension build embeds the canonical implementation and contains no source-relative or runtime `@openchamber/web` reference.
- Web and VS Code service adapters, classifications, raw command ownership, fallbacks, and public envelopes remain package-local and unchanged.
- Canonical operation and clone settlement now uses an explicit success sentinel. A focused regression proves `undefined`, `null`, `false`, `0`, and empty-string rejection reasons remain rejections and release all owned capacity.
- The deterministic harness now blocks on identity of the shared classes, factories, constants, error codes/guard, and all four error constructors before replaying the fixture through web-direct and VS Code-adapter paths.
- The full VS Code run exposed that `bridge-fs-runtime.test.js` globally replaced the entire child-process module. Its test mock now preserves unmocked native exports and overrides only `exec`, allowing all runtime tests to coexist without changing production behavior.
- No dependency, manifest, workspace, UI, route, persistence, CI, generated source, scheduler default, fsmonitor behavior, commit, push, or PR body changed.

## Non-goals

- No public route, bridge, `RuntimeAPI`, payload, UI, setting, persistence, or authentication change.
- No operation reclassification, scheduler-default tuning, completed-result cache, watcher, fsmonitor management, telemetry, or cross-process serialization claim.
- No migration of service implementations, Git command primitives, built-in VS Code Git behavior, runtime fallbacks, or user-authored process bypasses.
- No new workspace package, package dependency, framework, generated artifact, CI workflow, or `../opencode` change.
- No PR conflict resolution in this phase.

## Stop conditions

- Stop if the shared files cannot be included in the published web archive or bundled VS Code extension without a dependency/generated-copy change.
- Stop if a wrapper changes a current runtime export, a service/route/bridge contract, or package-specific fallback semantics.
- Stop if deterministic cleanup, fairness, status sharing, generation movement, or bounds differ after extraction.
- Stop if validation fails and continuing would require broader refactoring, scheduler behavior changes, dependency changes, or unrelated cleanup.
