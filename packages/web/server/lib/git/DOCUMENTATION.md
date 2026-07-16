# Git Module Documentation

## Purpose
This module provides Git repository operations for the web server runtime, including repository management, branch/worktree operations, status/diff queries, commit handling, and merge/rebase workflows.

## Entrypoints and structure
- `packages/web/server/lib/git/`: Git module directory containing all Git-related functionality.
  - `index.js`: Public API entry point imported by `packages/web/server/index.js`.
  - `routes.js`: Express route registration for `/api/git/*` endpoints.
  - `service.js`: Core Git operations (repository, branch, worktree, commit, merge/rebase, status/diff, log).
  - `context-resolver.js`: Canonical, injected, bounded repository/worktree identity discovery.
  - `execution-coordinator.js`: Bounded process-local conflict scheduling and in-flight status coalescing.
  - `execution-errors.js`: Structured internal overload, cancellation, queue-timeout, and re-entry errors.
  - `operation-classification.js`: Closed resource and runtime-owner classification for every exported service operation and owned web-server Git path.
  - `credentials.js`: Git credentials management.
  - `identity-storage.js`: Git identity (user.name, user.email) storage.

## Public API

The following functions are exported and used by the web server:

### Repository Operations
- `isGitRepository(directory)`: Return `false` for a missing path or an existing path authoritatively diagnosed as outside a repository. Spawn, permission, malformed-discovery, and other infrastructure failures throw rather than masquerading as `false`.
- `getGlobalIdentity()`: Get global Git user.name, user.email, and core.sshCommand.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check if local Git identity is configured.
- `setLocalIdentity(directory, profile)`: Set local Git identity (userName, userEmail, authType, sshKey/host).
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.

### Status and Diff Operations
- `getStatus(directory)`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or entire working tree.
- `getRangeDiff(directory, { base, head, path, contextLines })`: Get diff between two refs.
- `getRangeFiles(directory, { base, head })`: Get list of changed files between two refs.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs).
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath, options)`: Revert a file. Default scope `all` discards staged and working-tree changes; scope `working` discards only unstaged/working-tree changes.
- `stageFile(directory, filePath)`: Add one file path to the index.
- `unstageFile(directory, filePath)`: Remove one file path from the index while preserving working-tree content.
- `applyHunk(directory, filePath, options)`: Apply a single-hunk patch via `git apply`. `options.action` is `stage` (`git apply --cached`), `unstage` (`git apply --cached --reverse`), or `discard` (`git apply --reverse` in the working tree). The patch is written to a temp file; a `--check` runs first so a stale hunk fails with a clear "refresh and try again" error instead of a partial mutation. The patch target path must match the requested file.

### Branch Operations
- `getBranches(directory)`: Get list of local and remote branches (filtered to active remote branches).
- `createBranch(directory, branchName, options)`: Create and checkout a new branch.
- `checkoutBranch(directory, branchName)`: Checkout an existing branch.
- `deleteBranch(directory, branch, options)`: Delete a branch (supports force flag).
- `renameBranch(directory, oldName, newName)`: Rename a branch and preserve upstream tracking.
- `getRemotes(directory)`: Get list of configured remotes.

### Worktree Operations
- `getWorktrees(directory)`: List all git worktrees for a repository.
- `validateWorktreeCreate(directory, input)`: Validate worktree creation parameters (mode, branchName, startRef, upstream config).
- `createWorktree(directory, input)`: Create a new worktree (supports 'new' and 'existing' modes, upstream setup).
- `removeWorktree(directory, input)`: Remove a worktree (optionally delete local branch).
- `isLinkedWorktree(directory)`: Check if directory is a linked worktree (not primary).

`getWorktrees` retains a legacy compatibility behavior: it logs and returns `[]` for Git/discovery failures. This can make failure look like an authoritative empty list. Do not copy that behavior into new APIs; changing it requires a separately gated external-contract change.

### Commit and Remote Operations
- `commit(directory, message, options)`: Create a commit from the current index. `options.stageFiles` may be provided with `options.files` by older callers to stage only selected unstaged rows before committing, but the shared Git panel now stages/unstages explicitly before commit.
- `pull(directory, options)`: Pull changes from remote.
- `push(directory, options)`: Push changes to remote (auto-sets upstream if needed).
- `fetch(directory, options)`: Fetch changes from remote.
- `removeRemote(directory, options)`: Remove a configured remote (except `origin`).
- `deleteRemoteBranch(directory, options)`: Delete a remote branch.

### Log Operations
- `getLog(directory, options)`: Get commit history with stats (supports maxCount, from, to, file filters).
- `getCommitFiles(directory, commitHash)`: Get file changes for a specific commit.
- `getCommitFileDiff(directory, hash, filePath, isBinary)`: Get before/after content for a specific file in a commit. Returns `{ original, modified, isBinary }`. Runs `git show <hash>^:<path>` and `git show <hash>:<path>` in parallel; returns empty strings on failure (added/deleted/root-commit edge cases).

### Merge and Rebase Operations
- `rebase(directory, options)`: Start a rebase onto a target branch.
- `abortRebase(directory)`: Abort an in-progress rebase.
- `continueRebase(directory)`: Continue a rebase after conflict resolution.
- `merge(directory, options)`: Merge a branch into current branch.
- `abortMerge(directory)`: Abort an in-progress merge.
- `continueMerge(directory)`: Continue a merge after conflict resolution.
- `getConflictDetails(directory)`: Get detailed conflict information including operation type, unmerged files, and diff.

### Stash Operations
- `listStashes(directory)`: List stash entries with ref, message, relative time, and hash.
- `countStashFiles(directory, refs)`: Batch-count changed files for stash refs with bounded concurrency.
- `stashPush(directory, options)`: Stash changes, always including untracked files, with optional message.
- `stashApply(directory, options)`: Apply a stash by ref without removing it.
- `stashPop(directory, options)`: Apply a stash by ref and drop it only after a successful apply.
- `stashDrop(directory, options)`: Drop a stash by ref.

## Internal Helpers

The following functions are internal helpers used by exported functions:
- `buildSshCommand(sshKeyPath)`: Build SSH command string for git config.
- `buildGitEnv()`: Build Git environment with SSH_AUTH_SOCK resolution.
- `createGit(directory)`: Create simple-git instance with environment.
- `normalizeDirectoryPath(value)`: Normalize directory paths (supports ~ expansion).
- `cleanBranchName(branch)`: Remove refs/heads/ or refs/ prefixes.
- `parseWorktreePorcelain(raw)`: Parse `git worktree list --porcelain` output.
- `resolveWorktreeProjectContext(directory)`: Resolve project context (projectID, primaryWorktree, worktreeRoot).
- `resolveCandidateDirectory(...)`: Generate unique worktree directory candidates.
- `resolveBranchForExistingMode(...)`: Resolve branch for existing-mode worktree creation.
- `applyUpstreamConfiguration(...)`: Set upstream tracking for new branches.
- And various other internal helpers for Git command execution and parsing.

## Bounded execution architecture

### Scope and process boundary

This is a **process-local** coordinator. It prevents unsafe overlap among calls handled by one OpenChamber server process, while Git's own lock files remain authoritative across other processes. It does not claim cross-process serialization.

Every exported `service.js` operation appears exactly once in `GIT_SERVICE_OPERATION_CLASSIFICATION`; a test compares the table with the source exports. The current closed classification is:

- **Bootstrap discovery:** `resolvePrimaryWorktreeRoot`, `resolveWorktreeTopLevel`, `isGitRepository`, and `validateWorktreeDirectory`.
- **Pure or memory-only:** `resolveBaseRefForLog` and `getWorktreeBootstrapStatus`.
- **Global read:** `getGlobalIdentity`.
- **Repository read:** `getCommitSummaries`, `getIntegrateConflictDetails`, `isCherryPickInProgress`, `getRemoteUrl`, `getIgnoredPaths`, `getCurrentIdentity`, `hasLocalIdentity`, `getStatus`, `getDiff`, `getRangeDiff`, `getRangeFiles`, `getFileDiff`, `collectDiffs`, `listStashes`, `countStashFiles`, `getBranches`, `getWorktrees`, `previewWorktreeCreate`, `getLog`, `isLinkedWorktree`, `canonicalizeWorktreeState`, `getCommitFiles`, `getRemotes`, `getConflictDetails`, and `getCommitFileDiff`.
- **Worktree-local write:** `revertFile`, `applyHunk`, `stageFile`, `stageFiles`, `unstageFile`, `unstageFiles`, `checkoutCommit`, and `revertCommit`.
- **Common ref/config write:** `computeIntegratePlan`, `setLocalIdentity`, `stashDrop`, `push`, `deleteRemoteBranch`, `fetch`, `validateWorktreeCreate`, `deleteBranch`, `renameBranch`, and `removeRemote`.
- **Common write targeting one worktree:** `pull`, `stashPush`, `stashApply`, `stashPop`, `commit`, `createBranch`, `checkoutBranch`, `cherryPick`, `resetToCommit`, `rebase`, `abortRebase`, `merge`, `abortMerge`, `continueRebase`, and `continueMerge`.
- **Topology-exclusive write:** `integrateWorktreeCommits`, `abortIntegrate`, `continueIntegrate`, `createWorktree`, and `removeWorktree`.
- **Clone/destination reservation:** `cloneRepository` and `withGitCloneReservation`.

The internal `worktreeBootstrap` operation is a classified common write targeting its new worktree. User-authored worktree start commands run only after that lease and remain an explicit bypass.

### Canonical identities and discovery

- Common identity is the realpath-normalized `git rev-parse --git-common-dir`.
- Worktree identity contains both the realpath-normalized worktree Git directory and top-level.
- Identity normalization handles repository subdirectories, linked worktrees, symlink aliases, relative common-dir output, and Windows case-insensitive path identity.
- Only a confirmed "not a Git repository" diagnostic becomes `{ isRepository: false }` during discovery; `isGitRepository` additionally treats a path that does not exist as `false`. Spawn, permission, and malformed-output failures remain errors.
- Discovery has its own dependency-injected pool, is single-flight per canonical input alias, runs at most two tasks at once, and never enters the execution coordinator recursively.
- Discovery retains only bounded in-flight state and removes entries after success or failure.

### Conflict model and fairness

- Reads can overlap up to the per-common read cap, but no read overlaps a write for the same worktree.
- Local writes for distinct linked worktrees may progress independently.
- Common ref/config writes serialize with other common writes. A common write that targets a worktree also excludes reads and writes for that worktree, while unrelated linked-worktree observations/local work may progress.
- Topology writes are all-operation barriers for their common context.
- Network capacity is an independent modifier, not a total repository lock: one network operation per common context and two globally.
- A queued write blocks later conflicting reads, preventing writer starvation; unrelated worktree operations may bypass it, avoiding total-FIFO head-of-line blocking.
- Compound work must keep one outer lease and pass it into unscheduled core helpers. Those helpers execute temporally inside the admitted operation and must not reacquire a nested read lease. Compatible explicit reuse is allowed; incompatible re-entry fails with a structured error instead of waiting on itself.
- `validateWorktreeCreateCore` intentionally runs under the outer common/topology lease. It can derive/write the OpenCode project ID and may fetch a remote-tracking ref, so it is not a pure observation. Its local probes receive the existing lease and do not receive `GIT_OPTIONAL_LOCKS=0` while part of that mutation/network compound.

The former promise-chain queue keyed only by `git-common-dir` has been removed rather than layered underneath this coordinator.

### Limits and lifecycle

Default limits are conservative and explicit:

- active top-level operations: `min(8, max(2, os.availableParallelism()))`;
- active reads per common context: 2;
- active network operations per common context: 1;
- active network operations globally, including clones: 2;
- active discovery operations: 2;
- pending discovery operations: 2,048;
- in-flight discovery aliases/canonical contexts: 2,048 each;
- pending operations per common context: 64;
- pending operations globally: 2,048;
- retained common contexts: 512;
- retained worktree identities: 4,096;
- in-flight status entries: 2,048;
- pending clone reservations: 256 globally and 16 per destination;
- active clone destination identities: 256;
- idle generation state: 30-second lazy eviction, with least-recently-used idle eviction at admission limits.

No map or queue is keyed by session identity. Active/pending entries clean up on success, failure, overload, or queued cancellation.
`getStats()` is observational and never prunes or mutates coordinator state. Throttled idle pruning runs on normal admission and drain paths without a perpetual timer; hard count limits remain authoritative.

### Generations and status coalescing

- Worktree-local mutations advance the worktree generation on admission and again on completion, including failure or queued cancellation.
- Common and topology mutations advance the common generation on admission and completion. A common+target mutation invalidates status through that common generation.
- In-flight status identity includes common ID, worktree ID, requested light/full shape, and both relevant generations.
- Full work may satisfy a light waiter using a light response projection. Light work never satisfies a full waiter.
- Failed work is removed and never cached. Cancelling one status waiter rejects only that waiter and does not cancel shared work.
- General execution cancellation can remove queued work. Once a mutation starts, the coordinator lets it settle and reports its real result rather than pretending an abort stopped Git safely.
- Successful topology cleanup selectively evicts only retained worktree identities that became stale.
- There is deliberately no completed-result `SnapshotStore` or watcher. A process-local completed cache cannot safely detect Git changes made by another process.

### Read-only Git environment

Read-class operations create operation-scoped Git clients or subprocesses with:

```text
GIT_OPTIONAL_LOCKS=0
```

Mutation clients do not receive this override. It is not applied to the process environment globally.

### Structured internal failures

Coordinator/resolver overload, queued cancellation/timeout, and incompatible re-entry use internal errors with stable codes:

- `GIT_EXECUTION_OVERLOADED`
- `GIT_EXECUTION_CANCELLED`
- `GIT_EXECUTION_QUEUE_TIMEOUT`
- `GIT_EXECUTION_REENTRANCY`

No new public route error mapping was added. Existing routes keep their existing status codes and JSON envelopes.
`validateWorktreeCreate` preserves ordinary Git validation failures in its existing `{ ok: false, errors }` result, but rethrows `GIT_EXECUTION_*` control failures so overload, queue timeout, cancellation, and re-entry are not mislabeled as ordinary validation.

### Network and clone ownership

- `ls-remote`, fetch, pull, push, and clone consume network capacity. Full-status `remote get-url`, local config reads, `show-ref`, `rev-parse`, and comparisons against already-present remote-tracking refs are local config/ref reads and do not contact a remote.
- Clone reservations are canonicalized by destination before a repository identity exists. The same destination is exclusive and all clone queues/maps are bounded.
- `lease.releaseNetwork()` lets skills-catalog work release global network capacity after cloning while retaining exclusive ownership of its temporary destination for sparse-checkout/read work.

### Runtime owners and explicit bypasses

- `/api/fs/clone` delegates to `cloneRepository`; `/api/fs/list` and filesystem search delegate ignore checks to `getIgnoredPaths`.
- Skills-catalog clone and temporary-repository work runs inside `withGitCloneReservation`; its `git --version` check remains a capability-probe bypass.
- Notification branch lookup delegates to light `getStatus`.
- Git hooks, credential/transport helpers, external Git processes, user-authored `/api/fs/exec`, and user-authored worktree start commands are outside process-local scheduling. Git's own locks remain authoritative.

## Response Contracts

### Status Response
- `current`: Current branch name.
- `tracking`: Upstream branch (e.g., 'origin/main').
- `ahead`: Number of commits ahead of upstream.
- `behind`: Number of commits behind upstream.
- `upstreamComparison`: Optional comparison against `upstream/<current-branch>`, with `{ remote, branch, ahead, behind }`.
- `files`: Array of file objects with `path`, `index`, `working_dir` status codes.
- `isClean`: Boolean indicating if working tree is clean.
- `diffStats`: Object mapping file paths to `{ insertions, deletions }`.
- `mergeInProgress`: Object with `{ head, message }` if merge in progress.
- `rebaseInProgress`: Object with `{ headName, onto }` if rebase in progress.

### Staged and unstaged change handling
- `status.files` exposes both `index` and `working_dir` codes. Shared UI uses these as separate scopes: staged rows are derived from non-empty `index` statuses, while unstaged rows are derived from `working_dir` statuses and untracked files.
- A file with both staged and unstaged changes can appear in both UI sections. Staged rows request diffs with `staged: true`; unstaged rows request normal working-tree diffs.
- The shared Git panel exposes explicit staging actions. Unstaged rows use `stageFile`, staged rows use `unstageFile`, and commits operate on the current staged index.
- `stageFiles` remains supported for callers that need to stage a selected unstaged subset as part of commit. In that mode the server temporarily unstages unrelated index entries, stages `stageFiles`, commits from the index, then restores temporarily unstaged entries.
### Worktree Create/Remove Response
- `head`: HEAD commit SHA.
- `name`: Worktree name.
- `branch`: Local branch name.
- `path`: Absolute path to worktree directory.
- `directoryCreated`: Present when create returned after the target directory exists while background Git/bootstrap work continues.
- `bootstrapStatus`: Background setup status, with `pending`, `ready`, or `failed`.
- Fast create awaits completion of its outer topology operation before admitting background attachment. The response still reports `pending`; polling then observes authoritative `ready` or `failed` state without nested scheduler admission.
- Fast-create background failures remove OpenCode sandbox metadata for directories that never became Git worktrees, and remove the pre-created directory only if it is still empty. User-created files are never recursively deleted by this cleanup.

### Log Response
- `all`: Array of commit objects with hash, date, message, author info, stats.
- `latest`: Latest commit object or null.
- `total`: Total number of commits.

## Notes for Contributors

### Adding a New Git Operation
1. Add the function to `packages/web/server/lib/git/service.js`.
2. Export the function if it's part of the public API.
3. Add it to the closed operation table with its base profile and `none`, `conditional`, or `required` network usage.
4. Keep context discovery outside coordinator tasks. Reuse one execution lease/core helper for compound operations rather than reacquiring the same resource.
5. Use an operation-scoped read environment for read-class work; never apply optional-lock suppression to mutations.
6. Use `createGit(directory)` to get a simple-git instance with the correct normal environment.
7. Use `runGitCommand(cwd, args)` for direct Git command execution with better error handling.
8. Use `runGitCommandOrThrow(cwd, args, fallbackMessage)` for commands that must succeed.
9. Return consistent error messages; use `parseGitErrorText(error)` to extract meaningful Git errors.
10. Update this file with the operation's implemented lane and runtime scope.

### SSH Key Handling
- SSH keys are escaped and validated via `escapeSshKeyPath` to prevent command injection.
- On Windows, paths are converted to MSYS format (`C:/path` → `/c/path`).
- SSH_AUTH_SOCK is automatically resolved via `resolveSshAuthSock` (checks GPG agent, gpgconf).

### Worktree Naming
- Worktree names are slugified via `slugWorktreeName`.
- Random names use adjectives/nouns from `OPENCODE_ADJECTIVES` and `OPENCODE_NOUNS` lists.
- Branches created for new worktrees use `openchamber/<worktree-name>` pattern.

### Cross-Platform Considerations
- Use `normalizeDirectoryPath` for all directory inputs to handle `~` and path separators.
- Use `canonicalPath` for path comparisons to handle case-insensitive filesystems (Windows).
- Windows Git commands use MSYS/MinGW paths; avoid direct Windows paths in git commands.

### Error Handling
- All exported functions should throw errors with descriptive messages.
- Use `console.error` for logging Git operation failures.
- Return structured objects for operations that need partial success reporting (e.g., merge/rebase conflicts).
- Do not expose internal identity, generation, or lane controls through normal routes.

### Testing
- Resolver/coordinator tests use injected deferred operations so concurrency, fairness, cancellation, operation counts, and map cleanup are deterministic.
- The synthetic scale tests model a pathological 30,000-caller fan-out across 200 common contexts and 300 worktree identities without spawning 30,000 Git processes. They are correctness/coalescing guards, not a claim that 30,000 session entities are simultaneously active callers.
- Run focused Git tests and syntax checks, then the package checks required for the touched executable surface.
- Consider edge cases: non-Git directories, missing remotes, conflict states, concurrent worktree operations.

### Performance validation harness

Phase 4 adds the standalone `scripts/perf/git-execution.ts` harness. Schema v2 keeps session entities, independently declared scenario callers, coordinator API submissions, underlying scheduled operations, and Git commands as separate report dimensions. The full target proves that mapping 30,000 session records onto 200 independent common directories plus 100 linked worktrees (300 identities) itself causes zero submissions, scheduled operations, and Git commands. Startup and the separate pathological 30,000-waiter fan-out are distinct scenario counters. Before a soak creates its fixture, one immutable seeded plan now fixes every caller slot, status group, scheduled event, generation movement, and Git-command equation.

```bash
bun run perf:git:pr-real
bun run perf:git:target-real
bun run perf:git:target-real:dev
bun run perf:git:soak -- --duration-ms 300000 --rate 20
bun run perf:git:cap-sweep
bun run test:perf:git
```

- `pr-real` is the fast real-Git reviewer smoke and targets less than 30 seconds on ordinary CI.
- `target-real` uses the exact requested topology/counts; `target-real:dev` is a reduced implementation check and must not be reported as full target evidence.
- `soak` defaults to a manual 300-second, 20-caller/second run and supports explicit duration/rate overrides. Status callers are grouped within deterministic one-second waves by worktree, planned common/worktree generation, and idle segment. Every group's callers are submitted synchronously behind a worktree dependency gate, so one group always creates one underlying status task. Separate groups and worktree mutations remain ordered per worktree; fetch/topology operations form barriers only for their common context.
- `cap-sweep` replays one fixture at test-only caps 2/4/6/8/12. It reports deltas without changing or recommending a production default.

`--duration-ms` and `--rate` are soak-only flags. The CLI rejects either flag for `pr-real`, `target-real`, or `cap-sweep` instead of silently ignoring it. Every profile defaults to a 60,000ms timeout for each individual Git child, reported as `config.gitChildTimeoutMs`; `--git-child-timeout-ms <positive-ms>` overrides it. The timer starts only after the child emits `spawn`. On POSIX, each child receives a dedicated harness-owned process group; timeout sends that group `SIGTERM`, waits 1,000ms for `close`, then uses `SIGKILL` only if it did not close. Windows targets only the exact spawned child. Metrics and coordinator operation state are released only after the direct child emits `close`; timeout is an unexpected test failure and outer fixture cleanup still runs.

At seed 8755, the default soak plan is fixed at 6,000 logical callers/API submissions. Its 3,279 status callers form 1,869 groups, yielding 4,590 total scheduled operations and 4,754 Git commands. The reviewed command equation is `1 environment + 39 fixture-setup + 6 discovery + 4649 workload + 0 lock-recovery + 59 cleanup = 4754`.

Real Git uses the web coordinator/resolver against disposable local repositories and bare remotes. Deterministic parity uses the same pure fixture against the VS Code coordinator/resolver; the harness never imports the VS Code built-in Git API outside Extension Host.

Reports include seed/profile/config/versions, entity mapping, scenario counters, API/scheduled/Git counts, the immutable soak-plan summary, scheduler and direct-child peaks, CPU/memory/FD/event-loop metrics, generations/errors, child timeout/termination/reap counts, final state, and cleanup. `latency.underlyingScheduledOperations` has queue/service/total samples only for tasks that start; `latency.allWaitersObservedTotalMs` has one exact total sample for every API waiter, including grouped soak callers and all 30,000 pathological callers. Exact plan/runtime sample and cardinality counts, zero normal-profile timeouts, timeout/reap balance, caps, fairness/conflicts, generations, expected errors, drain, bounds/eviction, FD tolerance, submission/direct-child cleanup, and fixture cleanup are blocking.

JSON goes to stdout. An explicit `--output <path>` must name one new canonical file outside the workspace; existing output is never overwritten. Never commit reports, machine baselines, temporary repositories/remotes, `.git` directories, logs, traces, or profiles. Generated report paths are local and non-durable, not reusable template values. The earlier failed soak report is non-passing, superseded by the final corrected soak, and excluded from evidence. Before every direct spawn, the harness checks cwd and command path operands inside the unique fixture, sanitized Git/GCM/askpass/SSH-agent environment, system-config/prompt/hook/auto-GC policy, and registered local-only remotes. Guard counts and failures are reported. Direct-child accounting still excludes Git helpers and external processes.

Every direct spawn must declare one closed category: `environment`, `fixture-setup`, `discovery`, `workload`, `lock-recovery`, or `cleanup`. Each profile reports and blocks on exact category and operation-class maps, success/failure counts, category/class sums, and a reviewed total equation. Soak expectations come from the same pre-execution immutable plan that drives execution, never from observed coalescing. Adding a setup command without updating the reviewed expectation fails validation.

Normal root/focused discovery uses `runFocusedGitExecutionProfile`, which rejects full `target-real` and any soak longer than 30 seconds before fixture creation. The focused suite also inventories root package scripts: `perf:git:target-real` and `perf:git:soak` are the only reviewed full-profile script entrypoints, and no test script invokes either.

PR bodies for harness changes should include:

```md
## Summary
- Describe the harness/profile or deterministic assertion change.
- Confirm production scheduler behavior/defaults are unchanged.

## Validation
- `bun run test:perf:git` — `<result>`
- `bun run perf:git:pr-real` — `<result>`
- `bun run perf:git:target-real:dev` — `<result>`
- `bun run perf:git:soak -- --duration-ms 10500 --rate 2` — `<result>`
- `<type/lint/syntax command>` — `<result>`

## Performance notes
- Profile/schema/seed
- Entity mapping and per-scenario logical caller/API submission/scheduled operation/Git-command counts
- Soak status callers/groups, group-size counts, planned scheduled operations, and generation movement
- Git child timeout default/override plus timeout/termination/reap balance
- All-waiter versus underlying pathological fan-out latency sample counts
- Closed Git-command equation, category/class counts, and success/failure totals
- Executed safety-guard counts with zero failures
- Deterministic assertion result
- Advisory latency/resource summary
- Full target: `<PASS/FAIL — API / scheduled / Git; fan-out waiter/underlying; generation; timeout/error/cleanup state>`
- Default soak: `<PASS/FAIL — API / scheduled / Git; status callers/groups; generation; timeout/error/cleanup state>`
- Superseded evidence: `<identify any non-passing report and confirm exclusion>`

## Artifacts
- No generated report or temporary Git fixture committed.
```

Current Phase 4 results, ready to paste into the PR body:

```md
## Validation
- `bun run test:perf:git` — PASS (12/12)
- `bun run perf:git:target-real` — PASS
- `bun run perf:git:soak` — PASS
- `bun run perf:git:type-check` — PASS
- `bun run perf:git:lint` — PASS

## Full-profile evidence
- Target: PASS — 30,962 API / 1,262 scheduled / 2,876 Git; 30,000 waiter / 300 underlying fan-out; generation 1,324; zero timeouts/unexpected errors; cleanup passed.
- Soak: PASS — 6,000 API / 4,590 scheduled / 4,754 Git; 3,279 status callers / 1,869 groups; generation 3,116; zero timeouts/unexpected errors; cleanup passed.

## Artifacts
- Generated reports are local-only, non-durable, and not committed; local paths are intentionally omitted from the PR body and are not future-run template values.
- The earlier failed soak report is NON-PASSING, superseded by the final corrected soak, and excluded from PR evidence.
```

The full contract and generated-artifact policy live in `plans/git-execution-architecture/phases/phase-4.md`.

## Explicitly deferred work

1. **Completed-result caching:** remains blocked until an authoritative source can invalidate external Git mutations.
2. **Additional runtime parity decisions:** VS Code parity is implemented package-locally; any future runtime must either coordinate locally or intentionally delegate to the web server. Shared UI must not gain server execution internals.

Do not claim cross-process ordering and do not add completed-result status caching without authoritative external invalidation.
