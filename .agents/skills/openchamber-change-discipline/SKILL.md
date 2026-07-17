---
name: openchamber-change-discipline
description: Use when implementing, fixing, refactoring, or otherwise modifying OpenChamber source code, dependencies, exports, build configuration, generated assets, package contracts, or module ownership.
---

# OpenChamber Change Discipline

## Core Principle

Make the smallest complete change and validate at the narrowest level that covers the real risk.

Identify existing behavior covered by tests or callers; preserve it unless the requested change explicitly replaces it.

## Before Editing

1. Read the nearest `DOCUMENTATION.md` and package `README.md` when present.
2. Inspect nearby implementation and tests before introducing a pattern.
3. Load every additional project skill whose trigger matches the change.
4. Classify the highest applicable change risk below.
5. Identify affected consumers, runtimes, persisted data, and public exports.

When instructions materially conflict, stop and resolve the conflict instead of silently choosing one.

## Risk Classification

| Risk | Examples | Planning consequence |
|---|---|---|
| Local implementation | Private helper or component behavior in one package | Preserve observable behavior; validate the owning package |
| Module contract | Exported API/type or documented module invariant | Inspect consumers; update contract tests and owning docs |
| Cross-workspace contract | Shared UI/runtime/package shape consumed by multiple workspaces | Trace every actual consumer and runtime; validate across workspaces |
| Persisted or external behavior | Stored settings/data, routes, IDs, files, CLI output | Define compatibility, round-trip, failure, and conversion behavior for existing consumers |
| Platform/runtime behavior | Electron, VS Code, mobile, relay, native or packaged behavior | Run the relevant runtime/build/integration validation |

Apply every matching category. Do not escalate local work into workspace-wide ritual, and do not treat a type-only export as local merely because it emits no JavaScript.

## Mandatory Rules

- Identify existing behavior covered by tests or callers; preserve it unless explicitly replaced.
- Do not add dependencies unless explicitly requested.
- Do not add compatibility paths without a concrete persisted or external consumer.
- Enforce security and correctness in core logic, not only UI controls or prompts.
- Never add, persist, or log secrets, bearer tokens, pairing data, or sensitive user content.
- Make data loss, partial failure, rollback, and fallback behavior explicit.
- Update owning documentation when module ownership, contracts, or invariants change.
- Complete the cumulative validation required by every applicable risk category.

## Engineering Preferences

- Prefer the smallest correct change; avoid drive-by refactors.
- Keep orchestration entrypoints thin and move domain logic to focused modules.
- Prefer explicit dependencies and dependency injection over hidden module coupling.
- Follow local TypeScript types; avoid `any`, blind casts, and guessed payload shapes.
- Prefer early returns and explicit branches over nested conditionals.

## Review Prompts

Before broadening a change, ask:

- Is the new abstraction reused or merely possible to reuse?
- Is the code in the package that owns the behavior?
- Does the change alter shared UI contracts across web, desktop, VS Code, or mobile?
- Does it change persisted data, IDs, routes, exports, generated files, or package entrypoints?
- Can failure leave optimistic state, caches, files, or remote state stranded?

For partial or destructive flows, answer explicitly:

- What remains valid after the first failure?
- What is rolled back or cleaned up?
- What can be retried or resumed safely?
- What does the user observe?

For persisted data, require a migration only when existing stored data needs conversion. Test downgrade compatibility only when older application versions are a concrete supported consumer. "Rollback" means preserving/restoring valid state after a failed write or migration unless a broader contract explicitly says otherwise.

Do not hide a required architectural migration behind a local heuristic. Do not turn a local fix into a speculative rewrite.

## Validation Matrix

Use `package.json` scripts as the command source of truth.

| Change | Minimum validation |
|---|---|
| Executable source | Focused tests plus package-scoped type-check and lint |
| Cross-workspace/shared contract | Workspace-wide type-check and lint plus affected builds/tests |
| Added/deleted/renamed source file, export/type/entrypoint/import shape | `bun run dead-code` in addition to relevant checks |
| Persisted or external contract | Compatibility and round-trip tests; conversion/malformed-old-data tests when old data needs migration; failed-write/migration rollback tests |
| Dependency or lockfile | Workspace-wide checks and affected builds |
| Generated asset | Regeneration check plus consumer build/test |
| Docs-only or isolated config | Narrow syntax/schema/link validation; do not run unrelated full suites |
| Platform/runtime behavior | Relevant runtime build or manual/integration check; static checks are insufficient |

Use a sufficiently long timeout for broad checks. Report exactly what ran and what did not.

Choose affected builds/tests by tracing real consumers and runtime boundaries, not by running everything reflexively.

For type-only shared contracts, validate compile-time consumers. Add runtime serialization tests when the contract crosses a process, persistence, network, or untyped JavaScript boundary.

## Test Design

- Prefer observable contracts, state transitions, failure handling, rollback, and operation counts.
- Test private helpers through public/module behavior when that captures the risk clearly.
- Assert internal map shape, helper calls, or call order only when that structure/order is itself a contract.
- Keep refactor tests resilient to equivalent internal implementations.
- For behavior-preserving refactors, establish the current behavior before changing structure.

## Completion Standard

- Implement the behavior end to end, including rollback and cleanup.
- Run focused regression tests for the changed contract.
- Preserve unrelated changes encountered in shared files.
- Re-read the owning docs and update them when the implementation changed their truth.
- Do not claim runtime, relay, performance, or platform correctness from type-check/lint alone.

## Common Failure Modes

| Failure | Correction |
|---|---|
| Refactoring nearby code while fixing one bug | Keep the diff scoped unless the nearby change is required |
| Adding a helper used once | Keep direct code until reuse or composability is real |
| Swallowing an error for smoother UX | Preserve the failure signal and handle presentation separately |
| Updating a bridge without all runtimes | Load the runtime/API skill and make parity explicit |
| Running only broad checks | Add focused tests that exercise the changed behavior |
| Running only focused checks after a shared-contract change | Add workspace-wide validation |
