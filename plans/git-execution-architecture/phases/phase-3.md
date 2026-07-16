# Phase 3 — VS Code Extension-Host Git Execution Parity

Status: **completed, including verification/review closure (2026-07-16)**

## Goal

Give every OpenChamber-owned Git operation in the VS Code extension host an explicit, bounded process-local execution owner while preserving existing `RuntimeAPIs`, `BridgeResponse` envelopes, built-in VS Code Git integration, raw fallback behavior, and legacy clean/empty failure results.

## Architecture decision

A raw-subprocess-only coordinator is rejected. `gitService.ts` normally asks VS Code's built-in Repository API to perform an operation and only then falls back to raw Git. Scheduling only `execGit()` would therefore leave the preferred path outside the conflict model and could admit a raw fallback after another conflicting operation had started.

Phase 3 instead adds a package-local facade in front of `gitService.ts`:

1. The facade resolves canonical repository context and acquires one outer lease.
2. The existing service core chooses built-in Repository API or raw fallback while that lease remains active.
3. Validation, fallback, conflict recovery, and cleanup remain inside the same lease.
4. Core-to-core calls stay unscheduled and never reacquire a nested lease.
5. Fast worktree attachment and bootstrap are admitted as separate classified background work only after the initiating topology operation can release.

This is safe because the exhaustive import inventory found only `bridge-git-runtime.ts` and `bridge-git-special-runtime.ts` importing `gitService.ts`. Both migrate to the facade; internal calls within `gitService.ts` remain direct core calls. No web-server module or shared UI contract is imported.

## Resource model

- **Bootstrap discovery:** dependency-injected raw `rev-parse` discovery, globally capped at two and single-flight per canonical alias. It runs outside repository execution so discovery cannot recursively schedule itself.
- **Read:** up to two observations per common context; excludes a same-worktree write. Genuine raw reads receive operation-local `GIT_OPTIONAL_LOCKS=0`.
- **Worktree-local write:** owns one linked worktree's index, HEAD, and working tree while allowing unrelated linked worktrees to progress.
- **Common/ref/config write:** serializes shared refs/config mutations. Compound operations may additionally own their target worktree.
- **Topology barrier:** excludes all operations in the common context while worktree topology changes.
- **Network modifier:** one operation per common context and two globally; it augments rather than replaces the base profile.
- **Clone reservation:** before repository identity exists, canonical temporary destinations are exclusive and bounded.

## Owned runtime inventory

- `gitService.ts`: core implementation; all 51 imported function exports receive a closed classification and are reached by RuntimeAPI handlers through the scheduled facade.
- `bridge-git-process-runtime.ts`: unscheduled process primitive only; context discovery calls it directly.
- `git-execution-runtime.ts`: scheduled raw read owner for conflict-details and filesystem ignore probes.
- `bridge-git-runtime.ts`: standard RuntimeAPI handlers delegate to the service facade.
- `bridge-git-special-runtime.ts`: PR range reads delegate to the facade; direct conflict-detail subprocesses use the scheduled raw owner.
- `bridge-fs-runtime.ts` and `bridge-fs-helpers-runtime.ts`: `check-ignore` observations use the scheduled raw owner. Arbitrary `api:fs:exec` remains a user-authored shell bypass, including its existing narrow rev-parse cache.
- `skillsCatalog.ts`: `git --version` remains a capability probe; clone uses a bounded destination/network reservation and temporary-repository commands execute under the reservation's destination ownership.

## Explicit non-guarantees and compatibility

- Git hooks, credential helpers, transport helpers, external Git processes, and user-authored worktree start commands are not individually scheduled.
- Git lock files remain authoritative across processes; this coordinator is process-local only.
- A running VS Code Repository API promise cannot be reliably cancelled. Cancellation and queue timeout apply before admission; the lease remains held until admitted built-in work settles.
- No completed status cache, snapshot service, or watcher is introduced. Status sharing is generation-aware and in-flight only; full work may satisfy light waiters, never the reverse.
- Legacy clean/empty results remain unchanged for status, branches, worktrees, range-file listing, commit-file listing, and file-diff fallback paths.
- Existing route payloads, response shapes, and user-visible Git affordances remain unchanged. Internal identities, lanes, generations, and queue state are not exposed.

## Acceptance criteria

1. Every imported `gitService.ts` function export has exactly one machine-checked classification, proven through semantic reflection of the real module rather than regex alone.
2. Every extension-host-owned Git subprocess is delegated to a classified owner or appears in the explicit bypass inventory.
3. The facade acquires a lease before built-in Repository API/raw fallback choice.
4. Read, worktree, common, common+target, topology, network, and clone conflicts/caps have deterministic tests.
5. Context aliases, linked worktrees, symlinks, relative output, and Windows case folding converge on canonical identities.
6. Only genuine raw observations receive `GIT_OPTIONAL_LOCKS=0`; built-in operations and mutations do not receive synthetic environment changes.
7. Status coalescing is full/light aware, generation-aware, bounded, in-flight only, and waiter cancellation is local.
8. Seeded scale coverage is a pathological 30,000-caller fan-out guard across 200 common contexts and 300 worktree identities while asserting exact completion, mutation/network counts, generations, cleanup, every bound, and no session-derived identities; it does not model representative session concurrency, and deterministic writer/topology fairness remains independently covered.
9. Focused VS Code tests, package type-check, lint, production build, and root-scoped no-install Knip are inspected and reported.

## Completion

- Every one of the 51 imported service function exports and each direct extension-host Git owner/bypass has a machine-checked classification. Real exports are reflected semantically, raw process ownership is scanned through the TypeScript compiler AST, and all 51 facade operations have table-driven executable delegation coverage.
- A real dependency-injected facade suite proves admission before built-in/raw choice, same-lease fallback, observation-only optional locks, full/light status sharing, post-parent worktree admission, structured-error propagation, and ordinary repository fallback.
- Standard and specialized bridge paths, filesystem ignore probes, fast-create background work, and skills-catalog clone ownership use the package-local execution boundary without changing RuntimeAPI or `BridgeResponse` contracts.
- The strengthened pathological fan-out fixture completed 30,000 callers across 200 common contexts and 300 worktrees with exact completion, 600 mutations, 60 network operations, generation movement, resolver/coordinator cleanup, every configured bound, and no session-derived identities. It is not representative session concurrency; deterministic writer and topology fairness remain independently tested.
- Final bridge/facade follow-up: 17 tests passed with 173 assertions; its isolated production-listener case passed 1 test with 7 assertions.
- Final package validation: 84 tests passed with 837 assertions across 18 files; extension and webview type-check, lint, and production build passed.
- Root-scoped no-install Knip reported the established noisy baseline: 189 unused files, 304 unused exports, 176 unused exported types, and five configuration hints. It also warned that `--no-install` used a stale cached Knip installation; no Phase 3 symbol remained in the report.
- The production build retained existing non-blocking KaTeX font-resolution, mixed static/dynamic import, and large-chunk warnings.
- The conditional shared-web regression was not run because no shared web file changed.

## Stop conditions

- Stop rather than partially migrate if a service path must reacquire an incompatible lease.
- Do not claim cancellation of an admitted built-in Repository operation.
- Do not add completed-result caching without authoritative external Git invalidation.
- Do not import web runtime modules, alter shared UI contracts, add dependencies, or claim cross-process ordering.
