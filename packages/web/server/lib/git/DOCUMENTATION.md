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
- `isGitRepository(directory)`: Check if a directory is a Git repository. A repository whose root is the home directory or a filesystem root (`C:\`, `/`) answers `false` (`unsupportedRepositoryRootReason`): such a repository covers the whole disk, every status read would walk it, and it is nearly always an accidental `git init`. All Git surfaces then show the non-repository state for that directory.
- `getGlobalIdentity()`: Get global Git user.name, user.email, and core.sshCommand.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check if local Git identity is configured.
- `setLocalIdentity(directory, profile)`: Set local Git identity (userName, userEmail, authType, sshKey/host).
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.

### Status and Diff Operations
- `getStatus(directory, { mode })`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state. `mode: 'light'` skips the diff stats. One read runs per directory at a time and at most four run across directories (`serial-refresh.js`): a call made while a read is running waits for one follow-up read that starts after the call, so no caller gets a snapshot older than its request, and every caller that arrives during one read shares that single follow-up at the widest mode any of them asked for. Clients refresh after every completed agent tool call and from several surfaces at once; on a large repository (a status read is a dozen Git processes walking the working tree) this bound is what keeps identical `git status` processes from piling up side by side. A slot is held only while the read is alive: every process the read spawns is killed after two minutes without output (one minute for the untracked-directory listing, thirty seconds for the repository probe), so a Git process that hangs, which happens on Windows, fails that read instead of holding a slot until someone kills it by hand. On Windows the listing is ended with `taskkill /T`, because the spawned `git.exe` is Git for Windows' launcher and killing it alone leaves the real `git` child walking the tree as an orphan. Untracked files are listed with `-unormal` and each new directory is then expanded to its files with a bounded `ls-files` listing (`UNTRACKED_DIRECTORY_EXPANSION_LIMIT`, 1000): up to that many files the result equals `-uall`; beyond it the directory stays one `dir/` entry, because `-uall` would walk a forgotten build or dependency directory in full on every read. A nested repository stays a `dir/` entry as before.
- `getTrackingBranch(directory)`: Upstream of the checked-out branch as `remote/branch` (the same value as `status.tracking`, including an upstream whose remote ref is gone), or `null` when HEAD is detached or unborn or no upstream is configured. Reads refs and config only. Callers that need just the tracking name (GitHub PR status polling, PR creation) use this instead of `getStatus`.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or entire working tree with full Git blob identities. Untracked symbolic links are represented as link entries without following their targets.
- `getPathDiff(directory, { path, staged, contextLines })`: `getDiff` for one path, returning `{ diff, submodule }`. `submodule` is `null` for ordinary paths. For a gitlink it is `{ headCommit, indexCommit, worktreeCommit, hasTrackedChanges, hasUntrackedFiles, hasConflict }`, because a submodule that only gained untracked files shows as modified in status while its patch is empty. `worktreeCommit` is `null` when the submodule is not checked out. An unmerged gitlink has no single index commit, so it reports `hasConflict: true` with `indexCommit: null`. Exposed as `GET /api/git/diff`.
- Paths come from an earlier status listing and can stop resolving. Per-path operations reject with `error.code`: `path_not_found` when the path is absent from the working tree, index, and HEAD (for example, a file removed after the listing), `nested_repository` when the path is a directory holding its own `.git` that is not a submodule (status lists it as `dir/`), and `untracked_directory` when the path is a directory status kept as one `dir/` entry because it holds more untracked files than the expansion bound. `GET /api/git/diff` and `GET /api/git/file-diff` answer these with 404, 422 and 422 and a `{ error, code }` body instead of 500. Entry existence is read from `ls-files --stage` and `ls-tree` modes, not `cat-file -e`: a gitlink's commit is not in the parent's object store, and simple-git reports that silent exit 1 as success.
- `getRangeDiff(directory, { base, head, path, contextLines, includeWorkingTree })`: Compare the merge base of the exact selected refs with `head`. With `includeWorkingTree: true`, compare with the checked-out branch's current files instead, including committed, staged, unstaged, and untracked work in one net diff. This mode rejects a head that is not the checked-out branch. Exposed as `GET /api/git/range-diff`; omit `path` for the whole comparison.
- `getRangeFiles(directory, { base, head, includeWorkingTree })`: List changed paths using the same comparison as `getRangeDiff`. A successful empty list means the final files match the merge base, even if staging and working-tree changes cancel each other out.
- Both range operations honor refs literally. A local `main` is never replaced with `origin/main`, and an unavailable ref fails rather than choosing a different remote. The UI picker sends qualified refs to distinguish local and remote branches with matching display names.
- Working-tree comparisons use the real index read-only. A private temporary copy receives intent-to-add entries for untracked paths so Git computes additions, deletions, recreations, and renames together. Current contents come from the working tree, symlinks remain links, ignored files stay excluded, and temporary files are removed on success or failure.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs and symbolic links as their link-target text). For a submodule, both sides are Git's `Subproject commit <sha>` text (HEAD against the worktree checkout, or against the index when `staged`) and the result carries the same `submodule` state as `getPathDiff`; other paths return no `submodule`, which the route sends as `null`.
- `listUntrackedPaths(directory)`: List individual untracked file paths honoring ignore rules. Much cheaper than `getStatus` when that is all a caller needs. Deliberately not `--directory`: collapsed directory entries end in a slash and are rejected by the per-file diff helpers, so a caller would silently lose every file inside a new directory.
- `getUntrackedDiffs(directory, filePaths, { concurrency, contextLines })`: Diffs for untracked files against an empty tree. Resolves the repository context once instead of per file (`getDiff` re-resolves every call, costing an extra `rev-parse` each time) and bounds how many diff processes run at once. Returns one entry per input path in order; unreadable paths yield `''` rather than failing the batch.
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath, options)`: Revert a file. Default scope `all` discards staged and working-tree changes; scope `working` discards only unstaged/working-tree changes.
- `stageFile(directory, filePath)`: Add one file path to the index.
- `unstageFile(directory, filePath)`: Remove one file path from the index while preserving working-tree content.
- `applyHunk(directory, filePath, options)`: Apply a single-hunk patch via `git apply`. `options.action` is `stage` (`git apply --cached`), `unstage` (`git apply --cached --reverse`), or `discard` (`git apply --reverse` in the working tree). Inside the index mutation queue, the server verifies that the complete patch exactly matches one current three-context-line hunk for that file and scope, then runs `--check` before applying. Applicability alone cannot prove an unstaged change: old staged or committed hunks can reverse cleanly too. Stale, historical and multi-file patches fail with a refresh error. Temporary patch files are removed on success and failure; hunk content retains CRLF bytes.

### Branch Operations
- `getBranchBase(directory, branch)`: Read a named creation source from reflog. After a rebase, the creation source is no longer a current parent record, so return `null` and let the user choose a base. Explicit per-runtime, directory, and branch choices in the shared UI outrank detection.
- `getBranches(directory)`: Get list of local and remote branches (filtered to active remote branches).
- `getUnpushedBranchCounts(directory, branchNames)`: Count commits ahead of each locally known upstream for up to five supplied local branches. This reads local refs only and omits branches without an upstream.
- `createBranch(directory, branchName, options)`: Create and checkout a new branch.
- `createTag(directory, tagName, commitHash)`: Create a lightweight tag at the requested commit. The web route requires a full commit SHA, rejects option-like tag names, and the service executes `git tag -- <name> <commit>` with bounded argv.
- `checkoutBranch(directory, branchName)`: Checkout an existing branch. A remote-tracking name (`origin/main`, or the `remotes/`-prefixed form) resolves to the local branch of that name, created with `--track` when it does not exist yet, because the branch selector offers remote branches as places to work rather than commits to inspect — a literal checkout of the remote ref would detach HEAD. A local branch whose own name looks like a remote ref wins over that resolution, and anything unresolvable is checked out as requested. The returned `branch` is the branch that was actually checked out, which callers should report instead of the requested name.
- `deleteBranch(directory, branch, options)`: Delete a branch (supports force flag).
- `renameBranch(directory, oldName, newName)`: Rename a branch and preserve upstream tracking.
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

`push` leaves an unspecified destination to Git, including `branch.<name>.pushRemote`
and `remote.pushDefault`. Its missing-upstream fallback uses that same destination;
an explicit remote overrides configuration. `pushed` contains only refs changed by
the operation, derived from Git's porcelain flags, including first publication,
fast-forward and forced updates. Each entry's `remote` is the destination remote
name, not a ref. A successful no-op returns an empty array; rejected pushes throw.
Commit & Push and Sync share the same fetch/pull/push flow in web, Electron and
mobile, and never infer publication from an upstream `ahead` count. Fetch follows
the selected upstream while push routing remains independent. VS Code does not
mount these Git panels and keeps its separate extension-host Git implementation.

### Log Operations
- `getLog(directory, options)`: Get commit history with stats (supports maxCount, from, to, file filters).
- `getCommitFiles(directory, commitHash)`: Get file changes for a specific commit relative to its first parent, or the empty tree for a root commit. NUL-delimited paths preserve whitespace; renamed files return their destination in `path` and source in `previousPath`.
- `getCommitDiff(directory, { hash, path, previousPath, contextLines })`: Get the same commit's patch, with optional file filtering and context depth. `previousPath` keeps a rename's old and new paths in the per-file patch. Reads committed objects only, never the working tree. Exposed as `GET /api/git/commit-diff`; an unavailable hash fails rather than returning an empty diff.
- `getGitHistory(directory, options)`: Graph history pages. Explicit requests require at least one validated ref and remain capped at 32 refs; `{ all: true }` is the only supported all-refs selector and maps to an internally authored `--all` argument instead of enumerating refs.
- `getCommitFiles(directory, { commitHash, parentHash })`: Normalized raw commit metadata. `parentHash: null` is valid only for root commits; a merge requires the selected parent. Rename paths, object ids, binary flags, symlink/gitlink kinds, and Git order are retained. The legacy string-hash form remains supported.
- `getCommitFileDiff(directory, { commitHash, parentHash, originalPath, modifiedPath })`: Reads only requested before/after blob sides. Null sides are authoritative; missing objects fail and combined blob size is capped at 8 MiB.
- `getCommitFileDiff(directory, hash, filePath, isBinary)`: Legacy positional compatibility form for existing commit walkthrough callers.

### Merge, rebase, cherry-pick, and revert operations
- `rebase(directory, options)`: Start a rebase onto a target branch.
- `abortRebase(directory)`: Abort an in-progress rebase.
- `continueRebase(directory)`: Continue a rebase after conflict resolution.
- `merge(directory, options)`: Merge a branch into current branch.
- `abortMerge(directory)`: Abort an in-progress merge.
- `continueMerge(directory)`: Continue a merge after conflict resolution.
- `abortCherryPick(directory)`: Abort an in-progress cherry-pick.
- `continueCherryPick(directory)`: Continue a cherry-pick after conflict resolution.
- `abortRevert(directory)`: Abort an in-progress revert.
- `continueRevert(directory)`: Continue a revert after conflict resolution.
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
- `buildGitEnv()`: Build Git environment with SSH_AUTH_SOCK resolution and `GIT_TERMINAL_PROMPT=0` (unless the server was started with it set): the server has no terminal a user could answer, so a Git command that would ask for a username or password fails instead of waiting forever on a console nobody sees. Credential helpers, including GUI ones, still run before Git would prompt.
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
- `diffStats`: Scope-aware per-file line stats, `{ staged, working }`. `staged` is HEAD → index (`git diff --cached --numstat`), `working` is index → working tree (`git diff --numstat`). A partially staged file appears in both maps with its own scope's counts; the two are never summed together. Untracked and working-tree-added files are counted into `working`; files added to the index are counted into `staged`.
- `mergeInProgress`: Object with `{ head, message }` if merge in progress.
- `rebaseInProgress`: Object with `{ headName, onto }` if rebase in progress.
- `cherryPickInProgress`: Object with `{ head }` if a cherry-pick is in progress.
- `revertInProgress`: Object with `{ head }` if a revert is in progress.

### Operation routes and errors
- `POST /api/git/cherry-pick/abort` and `POST /api/git/revert/abort` return `{ success }`.
- `POST /api/git/cherry-pick/continue` and `POST /api/git/revert/continue` return `{ success, conflict, conflictFiles? }`.
- Git operations that cannot start because another operation is active return 409 with `{ error, code: 'operation_in_progress' }`.
- A hard reset with uncommitted changes and no `force` returns 409 with `{ error, code: 'reset_hard_dirty' }`.

### Branches Response
- `all`: Local branches plus every branch each reachable remote reports via `ls-remote --heads`, formatted as `remotes/<remote>/<branch>`. This is a union: local remote-tracking refs deleted on the remote are pruned, and branches that exist on the remote without a local tracking ref (never fetched) are still included, so a freshly pushed branch appears without requiring a fetch. A remote that fails to answer keeps its locally known branches in the list: "we could not ask" must not be reported as "these branches are gone", because callers use this list to decide whether a base branch exists at all.
- `current`: Current branch name.
- `branches`: Per-branch detail keyed by branch name, as reported by `git branch`. Remote-only entries in `all` — branches `ls-remote` reported that were never fetched — have **no** entry here, because `git branch` never saw them. Consumers must treat a missing detail entry as normal and read the name from `all`.
- Never-fetched remote-only branches also have no local ref, so any operation that resolves one locally has to account for that: `checkoutBranch` fetches the single branch (`git fetch <remote> <branch>`) before creating the tracking branch, and the range helpers (`getRangeDiff`, `getRangeFiles`) reject an unresolvable ref with `Ref "<ref>" is not available locally. Fetch it before comparing.` instead of surfacing git's "ambiguous argument".
- `defaultBranches`: Each remote's default branch, keyed by remote name. Read from the local `remotes/<name>/HEAD` symbolic ref; for a remote that has none — clone writes it, a hand-added remote may not — the remote itself is asked once with `ls-remote --symref`. A remote that answers neither is absent rather than guessed, and consumers fall back to conventional branch names. Omitted entirely by runtimes that do not provide this Git metadata.

### Runtime availability of range diffs
- `GET /api/git/range-diff` is served by the OpenChamber web server, so it is available to web, desktop, and mobile clients. The shared `GitAPI.getGitRangeDiff` is therefore optional: web supplies the HTTP implementation, and VS Code does not implement it because the extension host serves Git through its own bridge rather than these routes. Features built on range diffs (currently the AI diff walkthrough) are not offered in VS Code.
- Commit comparison uses the same server boundary through optional `GitAPI.getGitCommitDiff`. Desktop Changes, mobile Changes, and the existing walkthrough surface share branch/commit comparison semantics. Mobile Changes uses the same selectors and `useGitComparison` file-list owner, with a read-only list-to-detail flow. VS Code keeps its existing modes because its Git bridge does not provide these comparison operations. The HTTP operations are available to web, Electron, hosted mobile, and Capacitor clients.

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
- `status.diffStats` follows the same scopes (`staged`, `working`), so a staged row shows HEAD → index counts and an unstaged row shows index → working-tree counts. A file with edits in both scopes reports each part in its own row instead of one combined total.
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
