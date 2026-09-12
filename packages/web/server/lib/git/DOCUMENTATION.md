# Git Module Documentation

## Purpose
This module provides Git repository operations for the web server runtime, including repository management, branch/worktree operations, status/diff queries, commit handling, and merge/rebase workflows.

## Entrypoints and structure
- `packages/web/server/lib/git/`: Git module directory containing all Git-related functionality.
  - `index.js`: Public API entry point imported by `packages/web/server/index.js`.
  - `routes.js`: Express route registration for `/api/git/*` endpoints.
  - `service.js`: Core Git operations (repository, branch, worktree, commit, merge/rebase, status/diff, log).
  - `credentials.js`: Git credentials management.
  - `identity-storage.js`: Git identity (user.name, user.email) storage.

## Public API

The following functions are exported and used by the web server:

### Repository Operations
- `isGitRepository(directory)`: Check if a directory is a Git repository.
- `getGlobalIdentity()`: Get global Git user.name, user.email, and core.sshCommand.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check if local Git identity is configured.
- `setLocalIdentity(directory, profile)`: Set local Git identity (userName, userEmail, authType, sshKey/host).
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.

### Status and Diff Operations
- `getStatus(directory)`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or the entire working tree with full Git blob identities. Untracked symbolic links are represented as link entries without following their targets.
- `getRangeDiff(directory, { base, head, path, contextLines, includeWorkingTree })`: Get diff between two refs. Uses three-dot `base...head` semantics, so work merged into `head` from `base` is excluded and only the branch's own changes are returned. An explicit local base wins; a bare base with no local ref resolves to `origin/<base>` when available. With `includeWorkingTree: true`, the checked-out branch's staged, unstaged, and untracked changes are compared through a private index without mutating the real index. A path absent from the working tree may still be compared when it exists at the merge base, preserving committed deletions. Exposed as `GET /api/git/range-diff` (`path` optional; omit it for the whole range).
- `getRangeFiles(directory, { base, head, includeWorkingTree })`: Get list of changed files between two refs, optionally including the checked-out branch's staged, unstaged, and untracked changes without mutating the real index.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs and symbolic links as their link-target text).
- `listUntrackedPaths(directory)`: List individual untracked file paths honoring ignore rules. Much cheaper than `getStatus` when that is all a caller needs. Deliberately not `--directory`: collapsed directory entries end in a slash and are rejected by the per-file diff helpers, so a caller would silently lose every file inside a new directory.
- `getUntrackedDiffs(directory, filePaths, { concurrency, contextLines })`: Diffs for untracked files against an empty tree. Resolves the repository context once instead of per file (`getDiff` re-resolves every call, costing an extra `rev-parse` each time) and bounds how many diff processes run at once. Returns one entry per input path in order; unreadable paths yield `''` rather than failing the batch.
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath, options)`: Revert a file. Default scope `all` discards staged and working-tree changes; scope `working` discards only unstaged/working-tree changes.
- `stageFile(directory, filePath)`: Add one file path to the index.
- `unstageFile(directory, filePath)`: Remove one file path from the index while preserving working-tree content.
- `applyHunk(directory, filePath, options)`: Apply a single-hunk patch via `git apply`. `options.action` is `stage` (`git apply --cached`), `unstage` (`git apply --cached --reverse`), or `discard` (`git apply --reverse` in the working tree). The submitted patch must exactly equal one canonical hunk from the current diff, then a `--check` runs before mutation so stale or shifted hunks fail with a clear "refresh and try again" error. The patch target path must match the requested file.

### Branch Operations
- `getBranches(directory)`: Get list of local and remote branches (filtered to active remote branches).
- `getUnpushedBranchCounts(directory, branchNames)`: Count commits ahead of each locally known upstream for up to five supplied local branches. This reads local refs only and omits branches without an upstream.
- `createBranch(directory, branchName, options)`: Create and checkout a new branch.
- `createTag(directory, tagName, commitHash)`: Create a lightweight tag at the requested commit. The web route requires a full commit SHA, rejects option-like tag names, and the service executes `git tag -- <name> <commit>` with bounded argv.
- `checkoutBranch(directory, branchName)`: Checkout an existing branch. A remote-tracking name (`origin/main`, or the `remotes/`-prefixed form) resolves to the local branch of that name, created with `--track` when it does not exist yet, because the branch selector offers remote branches as places to work rather than commits to inspect — a literal checkout of the remote ref would detach HEAD. A local branch whose own name looks like a remote ref wins over that resolution, and anything unresolvable is checked out as requested. The returned `branch` is the branch that was actually checked out, which callers should report instead of the requested name.
- `deleteBranch(directory, branch, options)`: Delete a branch (supports force flag).
- `renameBranch(directory, oldName, newName)`: Rename a branch and preserve upstream tracking.
- `getBranchBase(directory, branch)`: Resolve a branch's creation source from its reflog. Rebased branches return `{ base: null }`, because their original creation source is no longer authoritative.
- `getRemotes(directory)`: Get list of configured remotes.

### Worktree Operations
- `getWorktrees(directory)`: List all git worktrees for a repository. Worktrees Git marks `prunable` remain in the list so callers can remove their stale metadata. A directory outside any repository (or one that does not exist) is an authoritative empty list; any other git failure throws so callers keep their last known topology instead of clearing it. `GET /api/git/worktrees` answers such a failure with 500.
- `observeWorktreeTopology(directory)`: Compare the repository's registered linked-worktree set with the last one seen for it and notify `subscribeWorktreeTopologyChanges` listeners when it changed. The set is fingerprinted from the `worktrees` directory under the common Git directory (mtime plus entry names), so the check is a stat and a readdir; the common directory is resolved with `git rev-parse --git-common-dir` once per requested directory and cached. The first observation only records a baseline. Never throws.
- `subscribeWorktreeTopologyChanges(listener)`: Listener receives `{ directories, at }`, where `directories` are every directory of that repository the server has observed, so clients can map them onto registered projects. Returns an unsubscribe function.
- `validateWorktreeCreate(directory, input)`: Validate worktree creation parameters (mode, branchName, startRef, upstream config).
- `createWorktree(directory, input)`: Create a new worktree (supports 'new' and 'existing' modes, upstream setup). When the current tracked branch has no unpublished commits, the UI supplies its remote-tracking ref and this operation fetches that branch once before creating the worktree. A failed fetch falls back to the local branch and reports `sourceFetchFailed`; other remote start refs still require an existing local ref when their fetch fails. After populating the worktree, the repository's `post-checkout` hook runs once with git's standard arguments (null ref as previous HEAD, the checked-out HEAD, and flag `1`) from the worktree directory, mirroring `git worktree add` without `--no-checkout`; a missing or non-executable hook is skipped and a failing hook is logged as a warning, never failing worktree creation or the session bootstrap.
- `removeWorktree(directory, input)`: Remove a worktree (optionally delete local branch).
- `isLinkedWorktree(directory)`: Check if directory is a linked worktree (not primary).

### Worktree topology change tracking
There is no filesystem watcher and no polling. The server notices worktree changes in two ways, and both scale with what users are doing rather than with the number of registered projects:
- Its own `createWorktree` and `removeWorktree` publish a change right after `git worktree add` / `git worktree remove` succeed (creation notifies before background population and setup scripts run).
- `GET /api/git/status` for a repository and `GET /api/git/worktrees` with a non-empty listing call `observeWorktreeTopology` beside the response. Clients request status while they work in a repository, and a completed agent tool call already triggers a status refresh, so a worktree added by an agent or from a terminal is noticed on the next such request; nothing runs while the app is idle.

`feature-routes-runtime.js` forwards each change to connected control-event clients as `openchamber:worktree-changed` with `{ directories, at }`. A repository nobody sends status or listing requests for is not observed until the next ordinary listing. `git worktree move` rewrites files inside an entry without touching the `worktrees` directory and is not detected. Tracking state is bounded: 500 directory-to-repository entries, 200 repositories, 100 directories per repository, least recently used dropped first.

### Worktree creation from a GitHub pull request
The UI provisions `pr-<owner>` via `ensureRemoteName`/`ensureRemoteUrl`
(HTTPS clone URL preferred over SSH) and checks out
`remotes/pr-<owner>/<head>`. A missing head URL or unreachable fork fails with
a clear error before a worktree is kept. If upstream fetch fails during
bootstrap, tracking is left unset rather than writing `branch.*.remote` /
`branch.*.merge` for a ref that was never fetched.

### Commit and Remote Operations
- `commit(directory, message, options)`: Create a commit from the current index. `options.stageFiles` may be provided with `options.files` by older callers to stage only selected unstaged rows before committing, but the shared Git panel now stages/unstages explicitly before commit.
- `pull(directory, options)`: Pull changes from remote.
- `push(directory, options)`: Push changes to remote (auto-sets upstream if needed).
- `fetch(directory, options)`: Fetch changes from remote.
- `removeRemote(directory, options)`: Remove a configured remote (except `origin`).
- `deleteRemoteBranch(directory, options)`: Delete a remote branch.

### Log Operations
- `getLog(directory, options)`: Get commit history with stats (supports maxCount, from, to, file filters). A `to` ref without `from` is passed as the positional log ref, preserving its file and max-count filters.
- `getGitHistory(directory, options)`: Graph history pages. Explicit requests require at least one validated ref and remain capped at 32 refs; `{ all: true }` is the only supported all-refs selector and maps to an internally authored `--all` argument instead of enumerating refs.
- `getCommitFiles(directory, request)`: Get normalized file changes in two forms. The request form `{ commitHash, parentHash }` requires the authoritative first parent for non-root commits (`null` only for a true root) and returns `status`/`originalPath`; the legacy string form compares the commit with its first parent (or the empty tree for a root) and returns `changeType`/`previousPath`. Both preserve rename paths, full 40- or 64-character blob IDs, binary flags, symlink/gitlink kinds, and deterministic Git order.
- `getCommitDiff(directory, { hash, path, previousPath, contextLines })`: Get a committed patch for the existing comparison walkthrough. `previousPath` keeps both sides of a rename in a filtered patch.
- `getCommitFileDiff(directory, request)`: Get before/after content for a specific file preview using `{ commitHash, parentHash, originalPath, modifiedPath }`. Returns `{ status: 'ready', original, modified }` for accepted previews or `{ status: 'too-large', totalBytes, maxBytes }` when combined blob sizes exceed 8 MiB. The backend treats null sides as authoritative, validates expected objects and repository-relative paths, measures blobs with `git cat-file -s`, then reads permitted sides concurrently with `git cat-file -p`.

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
- `runPostCheckoutHook(directory)`: Invoke the worktree's `post-checkout` hook after population, because `git worktree add --no-checkout` and the bootstrap's `git reset --hard` never run git hooks. Runs with git's standard arguments and the worktree as cwd; skips missing/non-executable hooks and never throws on hook failure.
- And various other internal helpers for Git command execution and parsing.

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

### Branches Response
- `all`: Local branches plus every branch each reachable remote reports via `ls-remote --heads`, formatted as `remotes/<remote>/<branch>`. This is a union: local remote-tracking refs deleted on the remote are pruned, and branches that exist on the remote without a local tracking ref (never fetched) are still included, so a freshly pushed branch appears without requiring a fetch. A remote that fails to answer keeps its locally known branches in the list: "we could not ask" must not be reported as "these branches are gone", because callers use this list to decide whether a base branch exists at all.
- `current`: Current branch name.
- `branches`: Per-branch detail keyed by branch name, as reported by `git branch`. Remote-only entries in `all` — branches `ls-remote` reported that were never fetched — have **no** entry here, because `git branch` never saw them. Consumers must treat a missing detail entry as normal and read the name from `all`.
- Never-fetched remote-only branches also have no local ref, so any operation that resolves one locally has to account for that: `checkoutBranch` fetches the single branch (`git fetch <remote> <branch>`) before creating the tracking branch, and the range helpers (`getRangeDiff`, `getRangeFiles`) reject an unresolvable ref with `Ref "<ref>" is not available locally. Fetch it before comparing.` instead of surfacing git's "ambiguous argument".
- `defaultBranches`: Each remote's default branch, keyed by remote name. Read from the local `remotes/<name>/HEAD` symbolic ref; for a remote that has none — clone writes it, a hand-added remote may not — the remote itself is asked once with `ls-remote --symref`. A remote that answers neither is absent rather than guessed, and consumers fall back to conventional branch names. Omitted entirely by runtimes that do not provide this Git metadata.

### Runtime availability of range diffs
- `GET /api/git/range-diff` is served by the OpenChamber web server, so it is available to web, desktop, and mobile clients. The shared `GitAPI.getGitRangeDiff` is therefore optional: web supplies the HTTP implementation, and VS Code does not implement it because the extension host serves Git through its own bridge rather than these routes. Features built on range diffs (currently the AI diff walkthrough) are not offered in VS Code.

### Runtime availability of commit comparison
- Commit-file metadata and previews use the OpenChamber web server in web, Electron, hosted mobile, and Capacitor. VS Code provides the same parent-aware operations through its Git bridge, although the shared `DiffView` does not offer Commit scope there.

### Staged and unstaged change handling
- Desktop Changes floats a compact action capsule after each hunk's last changed row,
  including single-hunk files. Whole-file controls remain in the Git panel.
  `getPatchHunkAnchors` uses the canonical patch's final changed row and side, so a hunk
  ending in deletions is anchored after those deletions rather than above them.
  Zero-height Pierre annotation slots anchor the capsule over following context
  without a separate band. At EOF the capsule lifts inside the code column;
  a one-line code column has a minimum hit-target height. React controls mount only
  for currently rendered slots and only after their rendered diff and anchor
  identities match the current props. Comment annotations remain independent.
- The canonical three-line-context action patch stays separate from the full-file
  display patch. Their bytes must be identical, or their file headers and full
  blob identities must match, including when reusing a cached action patch.
  Mismatch leaves actions unavailable until Retry obtains a matching pair.
  Successful hunk mutations invalidate
  every mounted view of that path through `sessionEvents.requestGitRefresh`.
  Actions remain unavailable until the refresh succeeds. Last turn, Branch and
  Commit snapshots never expose hunk mutations. Mobile uses its separate Changes
  surface and VS Code does not mount these controls.
- Untracked patches from `getDiff` and `getUntrackedDiffs` use `git diff --no-index` with separate stdout, stderr, and process exit status. Exit codes 0 and 1 return stdout only, so line-ending warnings never become patch text or request failures. Other exits and process failures reject the single-file request; the batch keeps an empty entry for the failed path and preserves the other results.
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
- `bootstrapStatus`: Background setup state. The legacy `status` remains `pending`, `ready`, or `failed`, while `phase` reports `directory-created`, `git-ready`, or `setup-ready`. Fast create starts at `pending`/`directory-created`; population and upstream Git completion advances to `pending`/`git-ready` before setup/start scripts; completed setup is `ready`/`setup-ready`. A missing in-memory state falls back to `ready`/`setup-ready`; clients continue to accept legacy status responses that omit `phase`.
- `sourceFetchFailed`: Present when the automatic source-branch fetch failed and creation fell back to the tracked local branch.
- Fast-create background failures remove OpenCode sandbox metadata for directories that never became Git worktrees, and remove the pre-created directory only if it is still empty. User-created files are never recursively deleted by this cleanup.
- Worktree removal waits for any active create/bootstrap task for that directory before deleting it, preventing a background Git or setup task from restoring removed state or racing filesystem cleanup.
- Worktree bootstrap retries transient `index.lock` conflicts. If the lock remains byte-for-byte and metadata-identical across the retry window, it is treated as stale, removed, and population continues automatically; changing locks are left untouched and reported as failures.
- Worktree population enables Git `core.longpaths` (local repo config plus `-c core.longpaths=true` on `git reset --hard`) so deeply nested checkouts under the managed data-dir worktree root do not fail on Windows MAX_PATH with "Filename too long". Path-component limits that the filesystem itself rejects still fail bootstrap, with a clearer path-length guidance message.

### Log Response
- `all`: Array of commit objects with hash, date, message, author info, stats.
- `latest`: Latest commit object or null.
- `total`: Total number of commits.

### Git history route errors
- `GET /api/git/history` returns history service errors as `{ error: string, code?: string }` with the service status code.
- Stale history cursors return `409` with `{ error: 'stale cursor', code: 'stale_git_history_cursor' }` so HTTP runtimes can restart pagination from page one.
- Other history failures omit `code` unless the Git service provided one.

### Commit File Metadata Response
- `files`: Array in Git diff order.
- Each file entry contains:
  - `path`: destination path.
  - `originalPath`: source path for renames only.
  - `status`: `A`, `M`, `D`, or `R`. Type changes (`T`) normalize to `M`.
  - `kind`: `file`, `symlink`, or `gitlink`, derived from raw modes (`120000` and `160000`).
  - `originalObjectId` / `objectId`: omitted on null sides (adds/deletes).
  - `insertions` / `deletions`: line counts, or `0/0` for binary files, symlinks, and gitlinks.
  - `isBinary`: true only for regular files with `-/-` numstat output.

### Commit File Preview Route Contract
- `GET /api/git/commit-files` expects `directory`, `commitHash`, and `parentHash` query fields.
- `GET /api/git/commit-file-diff` expects `directory`, `commitHash`, `parentHash`, `originalPath`, and `modifiedPath` query fields.
- Web/Electron HTTP adapters serialize `null` parent/path values as the explicit root marker `__ROOT__`; routes decode that marker back to `null`.
- Web routes require full 40-character SHA-1 or 64-character SHA-256 commit hashes. Abbreviated SHAs are rejected at the route boundary.

## Notes for Contributors

### Adding a New Git Operation
1. Add the function to `packages/web/server/lib/git/service.js`.
2. Export the function if it's part of the public API.
3. Use `createGit(directory)` to get a simple-git instance with the correct environment. `directory` is required (`baseDir`); never omit it so commands cannot inherit `process.cwd()`.
4. Use `runGitCommand(cwd, args)` for direct git command execution with better error handling.
5. Use `runGitCommandOrThrow(cwd, args, fallbackMessage)` for commands that must succeed.
6. Return consistent error messages; use `parseGitErrorText(error)` to extract meaningful git errors.
7. Update this file with the new function in the appropriate API section.

### SSH Key Handling
- SSH keys are escaped and validated via `escapeSshKeyPath` to prevent command injection.
- On Windows, paths are converted to MSYS format (`C:/path` → `/c/path`).
- SSH_AUTH_SOCK is automatically resolved via `resolveSshAuthSock` (checks GPG agent, gpgconf).

### Working directory (simple-git)
- Repository operations always pass an explicit `baseDir` (the opened project/directory path) into simple-git. Omitting `baseDir` would default to `process.cwd()`, which breaks when the server was launched from a neutral directory (e.g. `$HOME`) while the opened project lives elsewhere.
- Global identity reads use the user home directory as `baseDir` (they do not need a repository).
- A `GitError` / non-repository result from status or check must not abort project/session enumeration: routes return a soft non-repo payload and log a warning.

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
- `git diff --no-index` treats numeric exit code `1` as an ordinary difference. Spawn, buffer, and other process failures have no numeric Git exit code and must remain failures.
- Use `console.error` for logging Git operation failures.
- Return structured objects for operations that need partial success reporting (e.g., merge/rebase conflicts).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Consider edge cases: non-Git directories, missing remotes, conflict states, concurrent worktree operations.
