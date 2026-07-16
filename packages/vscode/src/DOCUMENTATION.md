# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.

- `bridge-git-process-runtime.ts`
  - Unscheduled Git process primitive and environment setup (`execGit`), including SSH agent socket resolution.
  - It is called directly only by context discovery and by tasks that already own a classified lease.

- `git-context-resolver.ts`
  - Resolves canonical Git common/worktree identities through bounded, dependency-injected raw discovery.

- `git-execution-coordinator.ts`
  - Owns process-local read/write/topology conflicts, fairness, network capacity, clone reservations, generations, status coalescing, bounds, and cleanup.

- `git-operation-classification.ts`
  - Closed machine-checked inventory for every imported function export from `gitService.ts` and every direct extension-host Git owner/bypass.
  - Tests reflect the real module exports semantically and use the TypeScript AST to identify raw child-process Git owners; source-string checks are supplemental only.

- `git-execution-runtime.ts`
  - Composes the resolver, coordinator, raw observation helper, and pre-repository clone reservations.

- `git-execution-service.ts`
  - Scheduled facade used by bridge handlers.
  - Acquires one outer lease before `gitService.ts` chooses the built-in VS Code Repository API or raw fallback.
  - Exposes an injected factory for executable facade tests while production uses one explicit default core dependency table.

- `git-execution-scope.ts`
  - Async operation scope that applies `GIT_OPTIONAL_LOCKS=0` only to raw subprocesses inside genuine read operations.

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.

- `skillsCatalog.ts`
  - Keeps `git --version` as a capability probe.
  - Runs clone fallback, temporary-repository commands, local scan/install work, and cleanup under one bounded canonical destination reservation.
  - Releases only the scarce network token after clone completes; destination and temporary-repository ownership remain held until local work and cleanup finish.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.

## Git execution contract

### Ownership and identity

The VS Code bridge does not import web-server Git modules. Its execution boundary is package-local because the extension host is a distinct runtime.

`bridge-git-runtime.ts` reaches Git only through `git-execution-service.ts`. The facade resolves identity and acquires a lease before calling the existing service core. The core may then use VS Code's built-in Repository API or raw Git fallback without leaving that lease. Validation, fallback, recovery, and cleanup are therefore one compound operation rather than separately admitted subprocesses.

Canonical identities are:

- common context: canonical `git-common-dir`;
- worktree context: canonical Git directory plus canonical top-level.

Subdirectories, symlink aliases, linked worktrees, relative discovery output, and Windows identity casing converge on those keys. Discovery is globally capped at two operations, single-flight only while in progress, and retains no completed repository cache. If PATH-based discovery fails but the built-in VS Code Git extension may still work, normal service calls use a canonical directory-local fallback identity so legacy behavior remains bounded rather than being rejected before the built-in path runs.

### Profiles and limits

- Read: at most two per common context; excludes a same-worktree write.
- Worktree write: exclusively owns one linked worktree's index, HEAD, and working tree.
- Common write: serializes common ref/config mutations; compound variants also own their target worktree.
- Topology write: barrier for every operation in its common context.
- Network: modifier capped at one per common context and two globally.
- Clone: canonical destination reservation before a repository identity exists.

Default hard bounds are:

- global active operations: `min(8, max(2, availableParallelism))`;
- 64 pending operations per common context and 2,048 globally;
- 512 retained common contexts and 4,096 retained worktree identities;
- 2,048 in-flight status entries;
- 256 queued clones, 16 queued per destination, and 256 destination identities.

Earlier conflicting writes block later reads, preventing writer starvation without imposing total FIFO head-of-line blocking across unrelated linked worktrees. Mutation generations advance on admission and every settlement, including failure, queued cancellation, and queue timeout. Idle state is lazily pruned during ordinary admission/drain work; diagnostics are side-effect-free and no perpetual timer is installed.

### Status, environment, and cancellation

Status sharing is in-flight only and keyed by common/worktree identity, full/light shape, and mutation generations. Full work may satisfy a light waiter; light work never satisfies full. Failures are removed immediately. There is no completed status snapshot, watcher, or durable result cache because the extension host cannot authoritatively observe every external Git mutation.

Only raw subprocesses inside classified reads receive operation-local `GIT_OPTIONAL_LOCKS=0`. Mutations, built-in Repository calls, and read probes inside a mutation compound do not inherit that environment override.

Queued work can be cancelled or time out before admission. A running built-in VS Code Repository API promise cannot be reliably cancelled; once admitted, its lease remains held until the promise settles. Cancelling one status waiter does not cancel shared work or other waiters.

### Background worktree work

Fast worktree creation returns the existing pending result after directory creation. Attachment is then admitted as a separate topology operation queued behind the initiating topology lease. Reset/upstream/bootstrap work receives a separate common+target lease after attachment. Admission or execution failure updates the existing bootstrap failure state and runs the existing cleanup path. User-authored start commands can invoke arbitrary processes and remain an explicit non-guarantee rather than being parsed into scheduler profiles.

### Direct raw owners and bypasses

- Conflict-detail probes hold one scheduled raw-read lease across all related commands.
- Filesystem list/search `check-ignore` probes use scheduled raw reads. Their existing timeout is waiter-local: timeout returns the existing fail-open result while admitted Git work keeps its lease until settlement.
- Skills-catalog clone uses a bounded destination/network reservation. After clone, it releases only network capacity while retaining exclusive destination/temporary-repository ownership through local scan/install work and cleanup, so another clone cannot race cleanup. `git --version` remains an unscheduled pre-repository capability probe.
- Arbitrary `api:fs:exec`, including its existing narrow rev-parse result cache, is user-authored shell execution and is outside the coordinator claim.
- Git hooks, credential/transport helpers, external Git processes, and child processes started by user commands are not individually scheduled.
- Git lock files remain authoritative across processes; no cross-process serialization is claimed.

### Verification guarantees

The closed operation inventory is executable: every real imported `gitService.ts` function export must appear exactly once, and all 51 classified facade operations are table-driven through the scheduled facade. Direct process ownership is independently checked with the TypeScript compiler AST so formatting or aliases cannot silently evade the inventory.

Seeded coordinator coverage drives a pathological 30,000-caller fan-out across 200 common contexts and 300 worktrees. It is a correctness/coalescing guard, not a model of 30,000 simultaneously active session entities. It asserts exact completion, mutation, and network counts; generation movement; resolver/coordinator cleanup; every configured bound; and the absence of session-derived identities. Deterministic writer and topology-barrier fairness remain independently tested so scale coverage does not substitute for ordering guarantees.

Phase 4 schema v2 models the requested 30,000 session entities, zero-work entity mapping, startup callers, pathological fan-out waiters, coordinator API submissions, underlying scheduled operations, and Git commands as distinct dimensions. It records every waiter's observed total latency separately from underlying task queue/service/total latency. Real Git runs through the web coordinator/resolver against executable disposable-fixture safety guards; the VS Code modules receive identical deterministic parity assertions only. The harness never imports the built-in VS Code Git API outside Extension Host.

### Compatibility

RuntimeAPI payloads and `BridgeResponse` envelopes are unchanged. Internal queue, identity, lease, generation, and lane values are never exposed to users.

Legacy clean/empty fallbacks are intentionally preserved:

- raw status failure returns the existing clean/empty status;
- raw branch failure returns the existing empty branch collection;
- worktree listing failure logs and returns `[]`;
- range-file and commit-file listing failures return empty collections;
- file-diff fallback returns empty original/modified content.

These compatibility paths are documented behavior for Phase 3, not evidence that a failed fetch is authoritative repository emptiness.
