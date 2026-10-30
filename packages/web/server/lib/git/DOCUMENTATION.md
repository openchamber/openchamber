# Git module documentation

## Purpose
This module provides Git repository operations for the web server runtime, including repository management, branch/worktree operations, status/diff queries, commit handling, and merge/rebase workflows.

## Entrypoints and structure
- `packages/web/server/lib/git/`: Git module directory containing all Git-related functionality.
  - `index.js`: Public API entry point imported by `packages/web/server/index.js`.
  - `routes.js`: Express route registration for `/api/git/*` endpoints.
  - `service.js`: Core Git operations (repository, branch, worktree, commit, merge/rebase, status/diff, log).
  - `credentials.js`: Git credentials management.
  - `identity-storage.js`: Git identity profile storage — signature (user.name, user.email, signing) plus the optional provider account and transport the identity authenticates with.
  - `identity-provisioning.js`: creates an identity for each connected provider account, backfills accounts connected before identities carried one, and repoints identities when re-authentication renews a credential.
  - `network-operation-plan.js`: strict, immutable plans for push, fetch, pull, clone, and checkout hydration.
  - `network-operation-registry.js`: bounded process-local operation state, execution joining, progress steps, cancellation, and terminal retention.
  - `network-operations.js`: transport resolution, Git process ownership, redaction, deadlines, clone checkout copying, cleanup, and execution.
   - `transport-config.js`: bounded effective Git transport and checkout-hydration configuration hashing for repository authority.
   - `submodule-discovery.js`, `lfs-discovery.js`, and `discovery-endpoint.js`: bounded pure parsers for committed checkout metadata and endpoint resolution.
  - `contributor-provenance-storage.js`: strict bounded persistence for contributor-fork worktree identity and push-safety authority.
  - `worktree-creation.js`: worktree creation with the server's authority checks, including the change-request pipeline (resolve, exact account, managed head transfer, contributor remote and provenance). `POST /api/git/worktrees` and the session service (`session.create` with `pullRequest`) both create through it; `registerGitRoutes` returns its `createWorktree` for that.
  - `contributor-remote.js`: the `forkRemoteName` rule shared by change-request source construction and contributor transfer. It preserves the `pr-<owner>` normalization and `pr-head` fallback.
  - `credential-resolver.js` and `credential-broker.js`: resolve opaque managed credential references and provide one-operation Git authentication without returning secrets to clients. The resolver takes `readTransportCredential` and `describeProvider` from the source-control provider registry, never a provider's store: an HTTPS reference resolves through its provider's neutral transport credential (`secret`, `user`, identity, status), the endpoint must sit on the descriptor's instance origin (only the default instances when the descriptor's `managedHttpsInstances` is `default-only`, as GitHub's is), and the Git username follows the descriptor's `httpsUsername` (`x-access-token` for GitHub, `oauth2` for GitLab, or the account login). A reference naming a provider id this build does not know parses, because references are persisted, and fails closed with `Managed provider account is unavailable` before any lookup or spawn.
   - `ssh-host-alias.js`: reads the server user's SSH configuration with `ssh -G`, passing the remote's explicit user through `-l` so `Match user` evaluates the same destination as Git. It answers whether a remote's host reaches an instance's host name, so a remote written with an alias (`forgejo:owner/repo.git`) can be matched to the origin it reaches. Answers are cached for a minute by lowercase host and case-sensitive user; the configuration is only read for hosts that are not already the instance's own. Resolver instances can select an isolated SSH configuration with `configFile`; the server singleton uses the server user's normal configuration.
  - `redaction.js`: bounded Git output and error redaction.
  - `helper-launch.js`: how Git reaches this module's helper scripts through `sh`, telling Electron to run as Node inside the command itself.
  - `repository-credential-runtime.js` and `repository-credential-helper.js`: the credential helper a repository's own `.git/config` names, so `git push` from any shell acts as the identity the repository was given.

## Public API

The following functions are exported and used by the web server:

### Repository Operations
- `isGitRepository(directory)`: Check if a directory is a Git repository. A repository whose root is the home directory or a filesystem root (`C:\`, `/`) answers `false` (`unsupportedRepositoryRootReason`): such a repository covers the whole disk, every status read would walk it, and it is nearly always an accidental `git init`. All Git surfaces then show the non-repository state for that directory.
- `repository-root.js` owns that home/disk-root rule (`unsupportedRepositoryRootReason`) and `vcsInitRefusal`, which the OpenCode routes and the VS Code bridge use to refuse OpenCode's `POST /api/vcs/init` in those places. It has no Git dependency so the VS Code extension can import it.
- `getGlobalIdentity()`: Get global Git user.name, user.email, and core.sshCommand.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check that both repository-local `user.name` and `user.email` are configured.
- `setLocalIdentity(directory, profile)`: Set repository-local `user.name` and `user.email`. Explicit SSH commit signing also sets `gpg.format`, `user.signingkey`, and `commit.gpgsign` when `signCommits` is true and `signingKey` is non-empty. Other signing settings remain unchanged.
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.
- `resolveRepositoryGitPaths(directory)`: Resolve the absolute Git directory, shared common directory, and bare-repository state without collapsing linked worktrees into separate repositories.
- `getRepositoryRemoteUrls(directory)`: Read fetch and push URLs through Git for worktree and bare repositories. Source-control callers must redact these values before returning them to clients.

Author-profile application never sets or unsets `core.sshCommand` or `credential.helper`. This includes legacy SSH/token/HTTPS fields. Applying the `global` profile is `clearLocalIdentity(directory)`: it unsets repository-local `user.name`, `user.email`, `user.signingkey`, `commit.gpgsign`, and `gpg.format` so the repository falls back to the person's own Git configuration, which OpenChamber reads but never writes. It succeeds on a machine that has no author of its own — "no override applies here" is true either way — and answers with the author it found, or with `profile: null`. Legacy `authType`, `sshKey`, and `host` values may remain in private profile records for migration, but profile routes reject those fields in client input and strip them from every response. Public edits merge into the private record so retained migration data is neither deleted nor accepted back from a client. VS Code `setGitIdentity` enforces the same author-and-signing boundary through both its Git extension API and raw-Git fallback. Web, Electron, hosted mobile, and Capacitor mobile use the server implementation.

An identity is one repository's complete answer: signature, provider account (`account: { provider, instance, accountId }`), and transport (`account`, `ssh` with `sshCredentialId`, or `anonymous`). A client cannot write an identity without an account or with the `system` transport; records written before identities carried an account are still read (absent transport means `system`) but no repository can choose them. Connecting an account creates its identity on the spot, named after the login and qualified by provider or host when that name is already taken — one person with the same username on GitHub and GitLab gets `ada` and `ada (GitLab)`, not `ada 2`. Connecting again after disconnecting reuses the identity that already carries that person's signature on that instance rather than minting a second one (GitHub without a public address gets its own no-reply address); accounts connected earlier are backfilled once, on the first identities read after startup rather than at route registration, so a slow or locked auth store cannot delay server start. The public profile DTO contains only `id`, `name`, `userName`, `userEmail`, `account`, `transport`, `sshCredentialId`, `signCommits`, `signingKey`, `color`, and `icon`. Renderer Git summary routes expose only author name/email, and remote routes expose redacted display URLs. Raw `core.sshCommand` values and remote credentials, query parameters, and fragments remain server-internal.

### Status and Diff Operations
- `getStatus(directory, { mode })`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state. `mode: 'light'` skips the diff stats. A read asks Git each question once: in the desktop app every Git process is forked from the Electron main process, which carries Chromium's open profile files into each fork, and endpoint security scanners rescan those files at every fork (#5481). One `rev-parse --git-dir --show-toplevel` answers both whether the directory is a supported repository and where its root is (`isGitRepository` uses the same probe), and one `rev-parse --git-path` locates `MERGE_HEAD`, `MERGE_MSG`, `rebase-merge` and `rebase-apply`, which are then checked as files; `MERGE_HEAD` is resolved only when its file exists. A `rev-parse --verify --quiet` probe through simple-git cannot replace that file check: simple-git reports its silent exit 1 as success. `unborn` is true when the branch has no commit yet (`rev-parse --verify --quiet HEAD` exits 1, probed alongside `git status`); Git otherwise reports such a branch like an empty one, and clients keep repositories nested under such a root reachable. One read runs per directory at a time and at most four run across directories (`serial-refresh.js`): a call made while a read is running waits for one follow-up read that starts after the call, so no caller gets a snapshot older than its request, and every caller that arrives during one read shares that single follow-up at the widest mode any of them asked for. Clients refresh after every completed agent tool call and from several surfaces at once; on a large repository (a status read is half a dozen or more Git processes walking the working tree) this bound is what keeps identical `git status` processes from piling up side by side. A slot is held only while the read is alive: every process the read spawns is killed after two minutes without output (one minute for the untracked-directory listing, thirty seconds for the repository probe), so a Git process that hangs, which happens on Windows, fails that read instead of holding a slot until someone kills it by hand. On Windows the listing is ended with `taskkill /T`, because the spawned `git.exe` is Git for Windows' launcher and killing it alone leaves the real `git` child walking the tree as an orphan. Untracked files are listed with `-unormal` and each new directory is then expanded to its files with a bounded `ls-files` listing (`UNTRACKED_DIRECTORY_EXPANSION_LIMIT`, 1000): up to that many files the result equals `-uall`; beyond it the directory stays one `dir/` entry, because `-uall` would walk a forgotten build or dependency directory in full on every read. A nested repository stays a `dir/` entry as before. A status read never writes the index (#2229): its commands run with `GIT_OPTIONAL_LOCKS=0`, and the working-tree stats come from `git diff-files -M --numstat`, because `git diff` rewrites a stale index even with that variable set. Otherwise each read holds `.git/index.lock` for as long as refreshing the index takes, and a `git commit` the user runs in a terminal at that moment fails with "index.lock: File exists". The cost is that the server never refreshes stale index timestamps itself, so after many files are touched without changes each read compares their contents until a command the user runs refreshes the index.
- `getTrackingBranch(directory)`: Upstream of the checked-out branch as `remote/branch` (the same value as `status.tracking`, including an upstream whose remote ref is gone), or `null` when HEAD is detached or unborn or no upstream is configured. Reads refs and config only. Callers that need just the tracking name (GitHub PR status polling, PR creation) use this instead of `getStatus`.
- `getCheckedOutBranch(directory)`: Short name of the checked-out branch, or `''` when HEAD is detached or the directory is not a repository. Other Git failures throw. One ref read; session knowledge calls it on every message a session sends.
- `getPathsWithoutChanges(directory, paths)`: Named paths with no uncommitted changes or which Git cannot resolve. Each path is checked literally with `status --porcelain --untracked-files=all` in the supplied directory, including staged, unstaged, deleted and untracked files.
- `isAncestorOfHead(directory, sha)`: Check whether a commit is reachable from the checked-out `HEAD`.
- `isPatchEquivalentOfHead(directory, sha)`: Check whether a commit has a patch-equivalent commit reachable from `HEAD`, for terminal PR history after a rebase. It runs a short bounded `git cherry` probe. Missing old objects cannot prove an association.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or entire working tree with full Git blob identities. Untracked symbolic links are represented as link entries without following their targets.
- `getPathDiff(directory, { path, staged, contextLines })`: `getDiff` for one path, returning `{ diff, submodule }`. `submodule` is `null` for ordinary paths. For a gitlink it is `{ headCommit, indexCommit, worktreeCommit, hasTrackedChanges, hasUntrackedFiles, hasConflict }`, because a submodule that only gained untracked files shows as modified in status while its patch is empty. `worktreeCommit` is `null` when the submodule is not checked out. An unmerged gitlink has no single index commit, so it reports `hasConflict: true` with `indexCommit: null`. Exposed as `GET /api/git/diff`.
- `getPathDiffs(directory, { paths, staged, contextLines, concurrency })`: `getPathDiff` for many paths of one side, resolving the repository once and running a bounded number of reads at a time. Returns one entry per input path in order, `{ path, diff, submodule }` or `{ path, error, code }` with `code` one of the path error codes below or `null`; one failed path never fails the others. Exposed as `POST /api/git/diffs` (body `{ paths, staged, context }`, at most 1000 paths per request), which the Changes find bar uses to read a working-tree changeset in one request.
- Paths come from an earlier status listing and can stop resolving. Per-path operations reject with `error.code`: `path_not_found` when the path is absent from the working tree, index, and HEAD (for example, a file removed after the listing), `nested_repository` when the path is a directory holding its own `.git` that is not a submodule (status lists it as `dir/`), and `untracked_directory` when the path is a directory status kept as one `dir/` entry because it holds more untracked files than the expansion bound. `GET /api/git/diff` and `GET /api/git/file-diff` answer these with 404, 422 and 422 and a `{ error, code }` body instead of 500. Entry existence is read from `ls-files --stage` and `ls-tree` modes, not `cat-file -e`: a gitlink's commit is not in the parent's object store, and simple-git reports that silent exit 1 as success.
- `GET /api/git/diff`, `GET /api/git/file-diff`, and `POST /api/git/diffs` answer a non-repository directory with HTTP 409 and `{ code: 'not_repository', error: 'This directory is not a Git repository.' }`, without warnings or errors in the server log. This applies both to plain folders and repositories whose `.git` disappeared. Request validation still runs first; unrelated Git failures remain 500. The HTTP adapter rejects these reads with the server message, which existing desktop/web and mobile diff error views display. A failed batch has no successful per-path entries.

- `getRangeDiff(directory, { base, head, path, contextLines, includeWorkingTree })`: Compare the merge base of the exact selected refs with `head`. With `includeWorkingTree: true`, compare with the checked-out branch's current files instead, including committed, staged, unstaged, and untracked work in one net diff. This mode rejects a head that is not the checked-out branch. Exposed as `GET /api/git/range-diff`; omit `path` for the whole comparison.
- `getRangeFiles(directory, { base, head, includeWorkingTree })`: List changed paths using the same comparison as `getRangeDiff`. A successful empty list means the final files match the merge base, even if staging and working-tree changes cancel each other out. With `includeWorkingTree: true` each entry also carries `revision`: the merge base plus the file's `lstat` signature (size, mtime and ctime in ns, mode, inode; `missing` for a deleted file). It moves exactly when that file's patch can change, so the Changes view re-reads a patch only after the merge base moved or the file was written. A same-size edit with the same line counts still moves it; a status refresh that wrote nothing does not.
- Both range operations honor refs literally. A local `main` is never replaced with `origin/main`, and an unavailable ref fails rather than choosing a different remote. The UI picker sends qualified refs to distinguish local and remote branches with matching display names.
- Working-tree comparisons use the real index read-only. When untracked paths exist, a temporary copy of the index receives intent-to-add entries so Git computes additions, deletions, recreations, and renames together. Current contents come from the working tree, symlinks remain links, ignored files stay excluded, and temporary files are removed on success or failure.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs and symbolic links as their link-target text). For a submodule, both sides are Git's `Subproject commit <sha>` text (HEAD against the worktree checkout, or against the index when `staged`) and the result carries the same `submodule` state as `getPathDiff`; other paths return no `submodule`, which the route sends as `null`.
- `listUntrackedPaths(directory)`: List individual untracked file paths honoring ignore rules. Much cheaper than `getStatus` when that is all a caller needs. Deliberately not `--directory`: collapsed directory entries end in a slash and are rejected by the per-file diff helpers, so a caller would silently lose every file inside a new directory.
- `getUntrackedDiffs(directory, filePaths, { concurrency, contextLines })`: Diffs for untracked files against an empty tree. Resolves the repository context once instead of per file (`getDiff` re-resolves every call, costing an extra `rev-parse` each time) and bounds how many diff processes run at once. Returns one entry per input path in order; unreadable paths yield `''` rather than failing the batch.
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath, options)`: Revert a file. Default scope `all` discards staged and working-tree changes; scope `working` discards only unstaged/working-tree changes.
- `stageFile(directory, filePath)`: Add one file path to the index.
- `unstageFile(directory, filePath)`: Remove one file path from the index while preserving working-tree content.
- `applyHunk(directory, filePath, options)`: Apply a single-hunk patch via `git apply`. `options.action` is `stage` (`git apply --cached`), `unstage` (`git apply --cached --reverse`), or `discard` (`git apply --reverse` in the working tree). Inside the index mutation queue, the server verifies that the complete patch exactly matches one current three-context-line hunk for that file and scope, then runs `--check` before applying. Applicability alone cannot prove an unstaged change: old staged or committed hunks can reverse cleanly too. Stale, historical and multi-file patches fail with a refresh error. Temporary patch files are removed on success and failure; hunk content retains CRLF bytes.

#### Why non-repository diffs fail explicitly

A stale status row can outlive its repository. Returning empty contents would replace a real comparison with an apparently successful empty diff and poison the client cache. A quiet 409 preserves the distinction and lets the existing error views explain why the comparison is unavailable.

### Branch Operations
- `getBranchBase(directory, branch)`: The branch's recorded parent, `branch.<name>.gh-merge-base` (the key `gh pr create` also reads as its default base), while it still names a ref; else a named creation source from the reflog. `createWorktree` records the parent when a new branch starts from another branch, so a stacked branch keeps its lower layer as its base through a rebase. After a rebase, the creation source is no longer a current parent record, so return `null` and let the user choose a base. A source that is the branch's own remote copy (`git switch feat` records `Created from refs/remotes/origin/feat`) is not a parent either and also returns `null`. Explicit per-runtime, directory, and branch choices in the shared UI outrank detection.
- `getBranches(directory, { remote })`: Get local branches and remote branches. The default (`remote: 'live'`, the Git panel's branch list) asks each remote with `ls-remote --heads`, described under the branch list below; `remote: 'local'` (route `?remote=local`) answers from local refs alone, as `git branch -a` does, for callers that need only the checked-out branch and its upstream (publishing, worktree creation). On a detached HEAD, git's `(HEAD detached at <ref>)` line is left out of `all` and `branches`: listed under the tag or commit name, it looked like a branch, and picking it checked out the same ref again. `current` still carries that name.
- Commit integration is local-only: it may fast-forward to an existing local upstream ref, but never fetches implicitly. Refresh remote-tracking refs through an explicit planned Fetch operation before integration when current remote state is required.
- Ordinary worktree validation and creation from a remote branch that has no local remote-tracking ref fetch that single branch first (`git fetch <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>`), because the branch list offers never-fetched remote branches. A failed fetch reports `Remote branch not found`. Upstream setup is local-only. Contributor worktrees retain their dedicated managed transfer and checkout-hydration operations and never take this fetch.
- `getUnpushedBranchCounts(directory, branchNames)`: Count commits ahead of each locally known upstream for up to five supplied local branches. This reads local refs only and omits branches without an upstream.
- `createBranch(directory, branchName, options)`: Create and checkout a new branch.
- `checkoutBranch(directory, branchName)`: Checkout an existing branch. A remote-tracking name (`origin/main`, or the `remotes/`-prefixed form) resolves to the local branch of that name, created with `--track` when it does not exist yet, because the branch selector offers remote branches as places to work rather than commits to inspect — a literal checkout of the remote ref would detach HEAD. A local branch whose own name looks like a remote ref wins over that resolution, and anything unresolvable is checked out as requested. The returned `branch` is the branch that was actually checked out, which callers should report instead of the requested name.
- `deleteBranch(directory, branch, options)`: Delete a branch (supports force flag).
- `renameBranch(directory, oldName, newName)`: Rename a branch and preserve upstream tracking.
- `getRemotes(directory)`: Get list of configured remotes.

### Worktree Operations
- `resolveWorktreeTopLevel(directory)`: `{ root, prefix }` from one `git rev-parse --show-toplevel --show-prefix`: the checkout root and where `directory` sits inside it (`''` at the root, `ai` for `<root>/ai`). When git fails the answer is `{ root: directory }` without `prefix`, so a failed read is never taken for "at the repository root"; `GET /api/git/toplevel` passes that through and callers of `prefix` treat its absence as unknown.
- `getWorktrees(directory)`: List all git worktrees for a repository. A directory outside any repository (or one that does not exist) is an authoritative empty list; any other git failure throws so callers keep their last known topology instead of clearing it. `GET /api/git/worktrees` answers such a failure with 500. A bare repository has no `--show-toplevel` answer, so the listing runs from the directory itself; the bare entry git lists for the repository's own directory is not a checkout and is left out of the result.
- Task titles: a worktree's task title is its branch's description (`branch.<name>.description`, the first line, at most 120 characters), so every client reads it, `git branch -m` carries it and deleting the branch drops it. `getWorktrees` returns it as `title` from one `git config --get-regexp` read; a failed read lists the worktrees without titles. `setWorktreeTaskTitle(directory, { title, by })` writes it: `by: 'user'` always (an empty title clears it) and forgets the agent's copy; `by: 'agent'` only while the description is empty or still the one the agent set (`branch.<name>.openchamberAgentTitle`), otherwise it answers `applied: false` with the user's title. A detached worktree has no branch and is refused with 409. A worktree made for a pull request or an issue starts with that item's title: `POST /api/git/worktrees` takes it as `taskTitle` and, once the worktree exists, `seedBranchTaskTitle` writes it as the agent's (so the agent may replace it with a short name, and a user's title is never overwritten). A branch whose name OpenChamber generated (Quick worktree's `agile-chipmunk`; the client sends it as `generatedBranchName`) is recorded with `markGeneratedBranchName` (`branch.<name>.openchamberGeneratedName` holds that very name, so a rename, which carries the record along, ends it). The dialog's branch for an issue, discussion or tracker item is generated too (`issue-180-merry-salamander`); the client sends the item part as `generatedBranchPrefix`, recorded in `branch.<name>.openchamberGeneratedPrefix`, and the rename keeps its item key, the way trackers name an issue's branch: the key goes in front of the last path segment of the agent's name (`fix/docs-catalog` → `fix/180-docs-catalog`, Linear's `issue-ENG-12-` → `fix/eng-12-docs-catalog`; a discussion keeps `discussion-12-` whole), and a name that already carries the key stays as it is. The issue number survives, and so does the repository's naming the agent followed. These records are written while a worktree made with `returnAfterDirectoryCreated` is still being set up by git in the background, which locks `.git/config` for its own writes; `writeGitConfigValue` therefore tries a write that hits that lock again for about a second and a half before giving up, else the record was silently lost and the branch never counted as generated. `readRenameableGeneratedBranch` returns the worktree's branch only while that record matches and the branch was never pushed (no upstream, no remote branch of that name): then the session context asks the agent to rename it after the task (`../session-knowledge`), which `work.name` does through `renameGeneratedWorktreeBranch`: it renames only such a branch, to a name `git check-ref-format --branch` accepts and no other branch holds, and answers null for any other branch. A write publishes a topology change so clients list again. `PUT /api/git/worktrees/title` is the user's rename.
- Pinned worktrees: the user pins a worktree's task to the top of the sidebar, kept beside its title in the branch's config (`branch.<name>.openchamberPinned`, the time it was pinned), for the same reasons. `getWorktrees` returns it as `pinnedAt` from one more `git config --get-regexp` read; a failed read pins nothing. `setWorktreePinned(directory, pinned)` (`PUT /api/git/worktrees/pin`, body `{ pinned }`) writes or clears it and publishes the topology change; pinning a pinned worktree keeps the first time. A detached worktree is refused with 409.
- `observeWorktreeTopology(directory)`: Compare the repository's registered linked-worktree set with the last one seen for it and notify `subscribeWorktreeTopologyChanges` listeners when it changed. The set is fingerprinted from the `worktrees` directory under the common Git directory (mtime, entry names and each entry's HEAD, so renaming a checked-out branch from a terminal counts as a change), so the check is a stat and a readdir; the common directory is resolved with `git rev-parse --git-common-dir` once per requested directory and cached. The first observation only records a baseline. Never throws.
- `subscribeWorktreeTopologyChanges(listener)`: Listener receives `{ directories, at }`, where `directories` are every directory of that repository the server has observed, so clients can map them onto registered projects. Returns an unsubscribe function.
- `validateWorktreeCreate(directory, input)`: Validate worktree creation parameters (mode, branchName, startRef, upstream config).
- `waitForActiveWorktreeBootstrap(directory)`: Join this process's tracked checkout, hydration, and setup tasks. It awaits the existing promises, including tasks registered by early-return creation, without polling status. With no tracked task it returns immediately; callers still check `getWorktreeBootstrapStatus` to distinguish success from failure or interrupted recovery. Completion says nothing about OpenCode's agent/config discovery.
- A new branch made from a named branch (`mode: 'new'` with a local or remote-tracking `startRef`) records that branch as its parent in `branch.<name>.gh-merge-base`. A write that fails leaves the reflog to answer and never fails the creation; deleting the branch removes the key with the rest of its config.
- `createWorktree(directory, input)`: Create a new worktree (supports 'new' and 'existing' modes, upstream setup). Population never runs repository hooks or executable content filters. Contributor-fork worktrees also skip stored project setup and request setup commands during creation; they remain Git-ready and require a later exact-checkout digest-bound trust operation before executable checkout content may run. A trusted hook runs only from an operation-private mode-`0700` directory as a verified mode-`0500` content snapshot. The executor never reopens the repository hook pathname after approval, preserves `GIT_DIR`, `GIT_WORK_TREE`, arguments, and working directory in the trust digest, and removes the snapshot under a fresh bounded cleanup deadline even after cancellation.
- `createWorktree(directory, input)`: Create a new worktree (supports 'new' and 'existing' modes, upstream setup). When the current tracked branch has no unpublished commits, the UI supplies its remote-tracking ref and this operation fetches that branch once before creating the worktree. A failed fetch falls back to the local branch and reports `sourceFetchFailed`; other remote start refs still require an existing local ref when their fetch fails. After populating the worktree, the repository's `post-checkout` hook runs once with git's standard arguments (null ref as previous HEAD, the checked-out HEAD, and flag `1`) from the worktree directory, mirroring `git worktree add` without `--no-checkout`; a missing or non-executable hook is skipped and a failing hook is logged as a warning, never failing worktree creation or the session bootstrap.
- `removeWorktree(directory, input)`: Remove a worktree (optionally delete local branch). The local branch is kept, and the removal still succeeds, when another checkout holds it or a remote's `refs/remotes/<remote>/HEAD` names it as the default branch; the delete dialogs (`canDeleteWorktreeBranch`, `packages/ui/src/lib/worktrees/worktreeStatus.ts`) do not offer the branch toggles for such a branch. `--force` discards uncommitted work, so callers that must keep it snapshot first. A directory that is not a registered worktree is deleted only when it sits inside the data-dir worktree root (`<opencode data>/worktree/<projectID>`), never inside a configured `worktree.directory`, which can be shared with other projects (`".."`); inside a configured folder only a registered worktree that git failed to delete is removed; the VS Code runtime (`packages/vscode/src/gitService.ts`) applies the same guard. A registered linked worktree is released through the caller-injected `input.disposeInstance` hook after the match is confirmed and before `git worktree remove`, while the directory path still resolves; disposal is best-effort, so a failing hook is logged as a warning and never fails the removal. `DELETE /api/git/worktrees` builds that hook from the OpenCode URL/auth helpers injected into `registerGitRoutes`. The hook evicts the worktree root and every running location inside it from `GET /api/debug/location`, because a project opened on a folder of its repository runs its sessions in `<worktree>/ai`, a location of its own; when the list cannot be read it still evicts the root and rethrows the list error. The VS Code bridge does the same. The primary workspace and the orphan fallback never dispose, because neither is a registered linked worktree. From the release until the removal settles the worktree counts as being removed (see *Worktree removal and the folder's OpenCode location*), and a busy failure releases the instance again before the next attempt. A failed `git worktree remove` (run with `-c core.longpaths=true`) that got as far as deleting is followed by a registration check: git drops the registration once it starts deleting, whatever stops it then, a busy folder or a path too long for git even with long paths on (#5734). A worktree git no longer registers is finished as an orphan through `fs.rm`, which handles paths past git's limit; only a still-registered worktree with a busy failure is retried. A refusal before any deletion (a locked worktree) exits 128, as every git `die` does, and is reported as it is without the check: a registration that vanished meanwhile for another reason must not get the untouched folder deleted.
- `waitForWorktreeRemoval(directory)`: resolves once no removal of a worktree holding `directory` is in progress, at once when none is. The OpenCode proxy awaits it before forwarding a directory-scoped request.
- `snapshotWorktree(directory, { ref })` (`POST /api/git/worktrees/snapshot`): Record the worktree's complete state (HEAD plus staged, unstaged and untracked-but-not-ignored files) as a commit whose parent is HEAD, stored at `ref`. Only `refs/openchamber/runs/<group>/<session>` refs are accepted, so snapshots never appear as branches or tags. A throwaway index (`GIT_INDEX_FILE`) keeps the real index, HEAD, branch and files untouched; the commit uses a fixed OpenChamber identity. Returns `{ ref, commit, head }`. Used by multi-run Keep and code fusion (`packages/ui/src/lib/multirun/DOCUMENTATION.md`); VS Code implements it in the bridge git runtime.
- `isLinkedWorktree(directory)`: Check if directory is a linked worktree (not primary).

### Worktree location
- New worktrees go under OpenCode's `worktree.directory` when it is set: relative paths resolve against the project's canonical checkout, absolute paths are used as-is, and a leading `~` means the user's home directory. OpenCode appends the worktree name to that folder, so only the name is added.
- The setting is read from the merged OpenCode configuration on the canonical checkout (`packages/web/server/lib/opencode/worktree-directory.js`, shared with the VS Code extension host through `packages/vscode/src/worktree-directory.ts`) so a linked worktree sees the project's saved value.
- When the setting is absent, or names no usable directory, worktrees keep landing in OpenChamber's data-dir folder keyed by project ID. Changing the setting only affects worktrees created afterwards; nothing is moved.
- `removeWorktree` deletes an unregistered leftover only under the data-dir root, so worktrees created before the setting was set stay removable while a shared configured folder such as `".."` can never make a sibling project eligible for deletion; a config read failure there falls back to the data-dir root instead of blocking the removal. Creation still fails loudly on an unreadable config so a worktree is never created in an unchosen folder.
- Both the web and VS Code readers merge a secondary user config file (`opencode.jsonc` beside `opencode.json`) as an override layer, as OpenCode does, so `worktree.directory` set there applies in every runtime.

### Worktree removal and the folder's OpenCode location

Any directory-scoped OpenCode request for a folder inside a worktree starts that
folder's location, with its local MCP servers, whose working directory is the
folder. On Windows a process whose working directory is a folder keeps that
folder from being deleted, so a location started again after the release makes
`git worktree remove` fail with "Permission denied" and leaves the empty folder
behind (#4111). Measured on Windows with OpenCode 2.0.32: the release
(`debug.location.evict`) returns only after the location's MCP servers and their
children have exited, and the location starts again within half a second when
the open chat of that worktree reads its folder in reply to the stop.

- From the release until the removal settles, `waitForWorktreeRemoval` holds
  every request naming a folder inside the worktree. The OpenCode proxy awaits it
  for the directory in the query (`directory`, `location[directory]`) and in the
  header, decoded the way OpenCode decodes it, for at most 60 seconds. Once the
  folder is gone OpenCode answers those requests 404 without starting anything.
- A busy failure releases the location again before the next attempt, for a
  request that reached OpenCode before the hold began.
- The VS Code bridge proxy (`packages/vscode/src/bridge-proxy-runtime.ts`) holds
  the same requests through the extension's own `waitForWorktreeRemoval`.

#### Why hold requests in the proxy and not move the open chat away first

Moving the UI off the worktree before the removal would stop only the reads of
the screen in front of the user, and changes what the user sees while a removal
can still fail. The proxy is the one place every client request passes, so the
hold covers web, desktop and mobile alike and leaves the UI as it is; the held
reads wait a few seconds and the UI moves to the project after the removal as
before.

### Worktree removal with .git directory symlinks

Server removal supports the `.git` directory symlinks used by git-annex. Only a
registered, non-primary worktree qualifies. The resolved target must be a direct
child of this repository's common Git directory's `worktrees` directory. Its
`commondir` must resolve to that common directory, and its `gitdir` backlink must
name this worktree's `.git` entry, not another entry resolving to the same target.

After instance disposal and immediately before native removal, the server saves
the exact link target and writes a complete temporary `gitdir: <metadata>` file.
It atomically moves `.git` to a unique recovery name, then verifies the claimed
entry's identity and target bytes and rechecks the original directories. Only
then does it install the gitdir file by exclusive hardlink creation. A newer
`.git` entry cannot be overwritten. This is not one atomic swap: `.git` is briefly
absent between claiming and installation. The target directory is not written
into. Git performs removal through the existing busy-retry path. Validation
failures never trigger recursive deletion, and branch deletion runs only after
successful removal.

If preparation fails after claiming `.git`, cleanup restores the captured entry
with an exclusive operation while the original directories survive. An unexpected
concurrent file or symlink is preserved rather than replaced with the older link.
Unsupported entry kinds, a newer `.git` entry and failed restoration leave the
claim at its recovery name, which the server logs. Preparation handles this
cleanup itself because it has not yet returned the native-removal rollback hook.

If removal fails, rollback checks the worktree and metadata directory identities
and the temporary file's identity and contents. It then moves `.git` to a unique
recovery name and inspects the claimed entry again. If `.git` disappeared before
that move, rollback leaves it missing. The original symlink is created directly
with an exclusive operation, so a newer `.git` entry cannot be overwritten.
A concurrently changed regular file is put back by exclusive hardlink creation.
A claimed symlink is recreated from its saved target. POSIX preserves the exact
target bytes; Node normalizes Windows separators and absolute-path prefixes.
The symlink's inode, ownership and timestamps are not preserved. The claim is
removed only after rechecking its identity and target bytes. Node detects the
Windows link type from the target, defaulting to a file link if that probe fails.
Unsupported entry kinds and unsafe or failed restorations keep the claim under
its recovery name, and the server logs that path. If original-symlink creation
fails, rollback puts back the gitdir file when safe and keeps the native removal
error as the reported failure. Ordinary successful rollback leaves no recovery
entry behind.

Preparation and rollback recheck directory identities after claiming `.git` and
never create worktree or metadata directories. These safeguards cover changes through
the `.git` path; they are not a filesystem transaction. Writes through file
descriptors opened before the claim, changes to private recovery entries after
the final ownership check, and metadata deletion after the final directory check
are outside this guarantee.

### Worktree archives

An archived worktree is gone from disk but restorable. `archiveWorktree` records
the checkout under `refs/openchamber/archive/<id>`: a snapshot commit of every
change git does not ignore (the run snapshot's throwaway index, so the real
index is untouched), whose parent is the commit the branch stood on and whose
message is `OpenChamber worktree archive` followed by a JSON record (old path,
branch, task title, time, the session ids the client archived with it). It
first waits for the checkout's background population, since a snapshot taken
before the files land records them as deleted, and refuses a checkout whose
setup failed. Then the worktree is removed as `removeWorktree` removes it,
keeping the branch. A removal that fails deletes the ref again only when the
worktree is provably whole (still registered, on disk, in the snapshot's very
state): `git worktree remove --force` deletes files before it gives up on a
busy one, so otherwise the archive is kept and the call fails with
`WORKTREE_ARCHIVE_PARTIAL`, the snapshot being the only copy of what went.
Its message says to restore once nothing holds the folder only when the
folder is busy; any other leftover is named by its path with the error that
stopped its deletion.
Only a linked worktree git registers for this repository is archived, never
the primary checkout or a stray folder, and one worktree is archived once at a
time (`WORKTREE_ARCHIVE_IN_PROGRESS` for a second call).

`listWorktreeArchives` reads the refs (`GET /api/git/worktrees/archives`).
`restoreWorktreeArchive` runs in a new checkout of the archive's branch (or of
its head commit, when the branch is gone) that the client created through the
normal worktree creation, so setup commands run. It first waits for that
checkout's background population (`waitForActiveWorktreeBootstrap`) and refuses
a failed one: changes applied while git still fills the folder raced the
checkout. It then `cherry-pick --no-commit`s the snapshot, which applies it on
top of whatever the branch gained since, and unstages it, and deletes the ref.
A conflict leaves git's conflict state, which holds both sides, and deletes
the ref too: kept, the archive would still claim sessions that are back at
work. When git refuses to apply anything (files the setup commands wrote would
be overwritten), the ref stays and the call fails with
`WORKTREE_ARCHIVE_NOT_APPLIED`; the client then removes the checkout it made,
so a retry finds the branch free. `deleteWorktreeArchive` deletes the ref and, with `deleteBranch`, the
local branch unless a checkout uses it again.

#### Why the ref is the record

The repository is the only store: every client of it sees the same archives,
nothing can drift from git when branches are cleaned up by hand, and the ref
keeps the snapshot from `gc` until the archive is deleted. `git stash` was the
obvious alternative and was rejected: the stash stack is shared by every
worktree of the repository, so another session could pop or drop the entry.
Files git ignores (`node_modules`, `.env`) are not kept; the project's setup
commands bring them back on restore.

### Worktree topology change tracking
There is no filesystem watcher and no polling. The server notices worktree changes in two ways, and both scale with what users are doing rather than with the number of registered projects:
- Its own `createWorktree` and `removeWorktree` publish a change right after `git worktree add` / `git worktree remove` succeed (creation notifies before background population and setup scripts run).
- `GET /api/git/status` for a repository, `GET /api/git/worktrees` with a non-empty listing, and the batched reads `POST /api/git/projects` when it reads status and `POST /api/git/project-worktrees` (worktree list) with a non-empty listing call `observeWorktreeTopology` beside the response. `POST /api/git/projects` always answers the repository check and reads `status` and `root` (primary worktree root) only when the body's `fields` names them, because a status read costs half a dozen or more Git processes and most callers only ask whether a directory is a repository or where its primary root is. The client batches each field separately, so a repository check never waits on a status read. Each batch route reads up to 200 directories and isolates a per-directory failure so one project's error does not erase the others; they are the reads the startup burst uses instead of one request per project. Clients request status while they work in a repository, and a completed agent tool call already triggers a status refresh, so a worktree added by an agent or from a terminal is noticed on the next such request; nothing runs while the app is idle.

`feature-routes-runtime.js` forwards each change to connected control-event clients as `openchamber:worktree-changed` with `{ directories, at }`. A repository nobody sends status or listing requests for is not observed until the next ordinary listing. `git worktree move` rewrites files inside an entry without touching the `worktrees` directory and is not detected. Tracking state is bounded: 500 directory-to-repository entries, 200 repositories, 100 directories per repository, least recently used dropped first.

### Worktree creation from a GitHub pull request
The UI provisions `pr-<owner>` via `ensureRemoteName`/`ensureRemoteUrl`
(HTTPS clone URL preferred over SSH) and checks out
`remotes/pr-<owner>/<head>`. A missing head URL or unreachable fork fails with
a clear error before a worktree is kept. PR worktree requests also carry the
provider's exact head revision; validation and creation reject a local or
remote branch that does not resolve to that revision. A new local PR branch is
created from that immutable revision rather than the mutable remote-tracking ref,
and creation verifies the attached worktree HEAD before bootstrap, removing the
worktree and any branch created by that attempt on mismatch. A local branch of
the same name that an earlier, since removed worktree left behind is reused and
moved to the head (`git worktree add -B`) when it is not checked out elsewhere.
When it only trails the head nothing else happens; when it diverged, because the
head was force-pushed, its old tip is first kept in `<branch>-backup-<short sha>`
and the create result names it in `branchBackup`, which the UI shows in a toast.
A failed attempt puts a moved branch back on its old tip. The head transfer
fetches with a forced refspec, so a force-pushed head replaces the stale
remote-tracking ref instead of failing as non-fast-forward. Failed creation removes
a remote added by that attempt. An existing remote is reused only when its endpoint
is byte-for-byte equal; a different endpoint returns `CONTRIBUTOR_REMOTE_COLLISION`
and no `remote set-url` command runs. OpenChamber
serializes worktree remote provisioning per repository and remote name so concurrent
creation attempts cannot overwrite each other's rollback. If upstream fetch fails during
bootstrap, tracking is left unset rather than writing `branch.*.remote` /
`branch.*.merge` for a ref that was never fetched. Contributor-fork creation always leaves tracking unset.

The agent tool's `session.create` with `pullRequest: <number>` makes the same
worktree without a client: `feature-routes-runtime.js` builds the change-request
source on the server (`source-control/change-request-worktree.js`) and hands it
to the same `worktree-creation.js` pipeline, so the remote, provenance, missing
upstream and Publish destination chooser are the dialog's. VS Code has no
contributor worktrees and no agent tool, so the parameter does not exist there;
a server without the pipeline answers 501 and never falls back to a plain
branch worktree.

The agent tool's `session.moveToWorktree` makes a plain branch worktree
through `createWorktree` for a session that already exists
(`../openchamber-sessions/worktree-move.js`): a new branch, or with
`existingBranch` an `existing`-mode checkout of a local or remote branch. It
checks every named carry path for uncommitted changes in the session's directory
before creating anything, rejecting unchanged or unresolvable paths with 400. It
then moves the uncommitted changes of the files the agent named over with
`stashPush` (`paths`, resolved against the session directory to absolute literal pathspecs),
`stashApply` by commit hash and `stashDrop`, and removes the worktree again
with `removeWorktree` when a later step fails, deleting the local branch only
when the move made it.

### Commit and Remote Operations
- `commit(directory, message, options)`: Create a commit from the current index. An applied identity writes the repository's own `user.name` and `user.email`, and those decide. A repository on the System identity has none on purpose — it says no override applies — so the machine's own author answers, the way Git itself resolves it, and the panel names that author before the commit. With no author anywhere the commit is refused with the two ways to set one. `options.stageFiles` may be provided with `options.files` by older callers to stage only selected unstaged rows before committing, but the shared Git panel now stages/unstages explicitly before commit.
- `removeRemote(directory, options)`: Remove a configured remote (except `origin`).
- `deleteRemoteBranch(directory, options)`: Delete a remote branch.

## Network operation architecture

`createNetworkOperations` is in the OpenChamber server runtime authoritative for Git network execution. The service owns planning, operation state, credential resolution, every Git transfer process, cancellation, redaction, and cleanup. Its HTTP lifecycle is:

- `POST /api/git/network-operations` validates an exact operation schema, rejects unknown fields, stores an immutable internal plan, and returns the immutable public plan with `201`.
- `POST /api/git/network-operations/:id/execute` accepts an empty body and starts or joins execution.
- `GET /api/git/network-operations/:id` returns the current snapshot.
- `POST /api/git/network-operations/:id/cancel` accepts an empty body and requests idempotent cancellation.

Public snapshots contain `operationId`, `runtimeIdentity`, transport verification and optional verified actor, the redacted target, completed steps, state, and a stable redacted terminal error when applicable. A manual checkout-hydration plan retains the established parent-source transport shape for client compatibility, but that field proves only the selected source authority and is not child-transfer attribution. The internal automatic checkout-hydration operation uses `null` for operation-level transport because its child transfers use independent auxiliary grants; callers receive its bounded hydration result rather than the operation snapshot. Hydration audit records ignore parent transport metadata and use only exact child grant references. URL display endpoints contain no userinfo, query, or fragment; strict SCP displays remain supported. Endpoint fingerprints still cover the normalized transport authority, including query and fragment data when present in repository configuration, without exposing that data. Raw endpoints, repository and temporary paths, credential IDs, and pinned SHAs stay in the process-local internal plan. The default registry holds at most 256 records, expires unstarted plans after 15 minutes, retains terminal records for one hour, and evicts only terminal records for capacity. Restarting the server drops that process-local registry, but `network-operation-storage.js` keeps a bounded durable copy of each public snapshot, without the optional verified actor, in `git-network-operations.json` under `OPENCHAMBER_DATA_DIR`. After a restart the same-ID read returns the persisted terminal snapshot; a `planned` record recovers as `cancelled`, a `running` record recovers as `outcome-unknown` with a restart message and never expires, and other terminal records expire after the configured durable retention window.

### Exact-ref transport authority

Push, fetch, pull, remote-branch deletion, and sync accept only full refs. Sources are `refs/heads/*` or `refs/tags/*` (and a change host's `refs/changes/*` for a single-ref fetch, see *Review refs on a change host*); push destinations are heads or tags, deletion destinations are heads, fetch destinations are remote refs, heads, or tags, and pull destinations are heads. Sync narrows its fetch destination to `refs/remotes/*`, names its checked-out pull destination, and requires that destination to equal the exact push source. Planning accepts authoritative HTTPS, `ssh://`, and strict SCP endpoints only, under the same endpoint rule as Clone. Plain HTTP passes in one case: a loopback host (`localhost`, `127.0.0.0/8`, `::1`) when a registered provider allows loopback HTTP instances (Gitea's and Gerrit's local development sites); a managed credential additionally reaches it only when that loopback origin is its own provider's instance (`endpointIsInstanceOrigin`, `loopback-http.js`). The durable operation store accepts such an endpoint, and the terminal credential helper (`repository-credential-runtime.js`) answers shell Git for it under the same managed-credential rule; plain HTTP to any other host is refused everywhere. Anonymous transport stays HTTPS-only. A refused push's error leads with the remote's `! [remote rejected]` and `remote: error` lines, redacted, without the progress and hints around them. An `ssh://` endpoint may name its login user; HTTPS userinfo, any password, and query or fragment data fail before plan registration or Git argv construction. The SSH user stays in the internal raw endpoint: display URLs and fingerprints drop it, and URL display endpoints with userinfo fail. Planning validates the repository ID, binding and config revisions, remote, redacted endpoint fingerprint and display URL, transport mode, and opaque credential reference against source-control authority before resolving refs. Execution repeats authority validation before any subprocess or credential resolution and again immediately before each transfer Git process starts. It also compares a server-internal transport revision derived from effective system, global, local, worktree, and included Git configuration. The revision covers credential helpers and URL-scoped credential settings, SSH commands, URL rewrites, HTTP settings, and remote proxies. Values and origin paths never enter public plans or errors.

Push resolves and stores the source commit SHA while planning, rechecks it during both execution authority passes, and sends exactly `<pinned-sha>:<destination-ref>`. New-branch publication can request local upstream configuration; only after push success does the executor write the exact branch remote and merge ref, and a local configuration failure returns `partial`. An optional force lease is exactly `--force-with-lease=<destination-ref>:<expected-remote-sha>`. Remote deletion sends exactly `:<destination-ref>` and has the same uncertain-outcome rules as push. Fetch sends exactly `<source-ref>:<destination-ref>` with `--no-tags`. Pull pins the checked-out full HEAD ref and its commit SHA during planning, rechecks both before authentication, before fetch, and before merge, fetches to `refs/openchamber/network/<operationId>`, merges the fetched SHA with `--no-edit --no-verify`, then deletes the temporary ref. Remote names select authority; Git receives only the server-resolved raw endpoint.

Remote-branch deletion never deletes the remote's default branch. Right before the push, the executor asks the remote with `ls-remote --symref <endpoint> HEAD` through the same transport, and refuses with `INVALID_REQUEST` when HEAD names the destination. Some hosts refuse that deletion and some carry it out, so the check cannot be left to the remote. A worktree can end up on `main`, and deleting its branch would then delete main.

### Why the remote is asked and not `refs/remotes/<remote>/HEAD`

The local symref is written by clone and by fetch on recent git only, and it goes stale when the remote changes its default. A deletion that trusted it could take the real default branch. Worktree removal keeps the local branch on the local symref alone: it runs offline, and a deleted local branch can be fetched back.

Sync is one server-owned execution and one absolute deadline. Its immutable plan has separate fetch and push remote targets, endpoint metadata, transport modes, credentials, source refs, and destination refs. Planning rejects a detached HEAD, a missing target, or a pull destination that differs from the push source. It never reads upstream configuration, chooses `origin`, or chooses the first remote. Execution fetches the exact fetch refspec, merges that fetched commit into the pinned checked-out branch, then resolves and pins the resulting local commit immediately before sending the exact push refspec. It revalidates fetch authority before fetch and push authority before push, so a successful local integration followed by stale or failed push authority remains visible rather than switching targets.

Managed HTTPS strips ambient AskPass, SSH, uppercase and lowercase proxy variables, Git/Curl trace destinations, TLS overrides, injected Git-config variables, and custom CA/client-certificate environment variables. It disables system Git config and points global Git config at the platform null file, or, when the person's own system or global config trusts directories with `safe.directory`, at a private file holding only those entries (`createTrustedDirectoriesConfig`, rewritten before every operation). Git reads `safe.directory` only from those files, so without the copy a repository Git does not consider the user's own (a WSL checkout opened from Windows, a container mount, a clone another account made) failed every managed transfer at "dubious ownership" while System Git worked. Before issuing a broker lease, it enumerates effective repository-local `http.*` and `credential.*` keys, including local includes, then revalidates repository authority. Command-local config clears every discovered auth-bearing key by its exact name, clears generic and exact-endpoint transport settings, disables hooks and redirects, enforces TLS verification, and installs the operation helper as the sole credential helper. Git's standard trust store remains available. The helper makes one `POST http://127.0.0.1:<ephemeral-port>/credential` request with `x-openchamber-git-nonce: <32-byte-base64url-nonce>` and `x-openchamber-git-operation: get`. The loopback broker permits one use before expiry and returns credentials only when the normalized protocol, host, port, and repository path match the lease. An LFS lease also answers for the repository path that git-lfs derives by stripping `/info/lfs` from the endpoint, because git-lfs requests credentials for that repository URL rather than for the LFS endpoint; custom LFS endpoints without that suffix keep exact matching.

Managed SSH records live separately in mode-`0600` `git-ssh-credentials.json` under `OPENCHAMBER_DATA_DIR`. A record contains only an ID, absolute private-key path, and SHA-256 fingerprint. Credential resolution realpaths the selected key, opens it with `O_NOFOLLOW`, copies bytes from that handle to the exclusive operation-owned `git-ssh-operation-keys/<operationId>.key`, sets mode `0600`, derives its public key without a passphrase, and verifies the stored fingerprint. Existing version-1 records remain readable, including operator-provisioned records outside the managed key directory. Git invokes `ssh-wrapper.js`; the key path stays in `OPENCHAMBER_GIT_SSH_KEY`, not the command string. The wrapper uses `-F none`, `IdentityFile=none`, the one verified key, `IdentitiesOnly=yes`, `IdentityAgent=none`, batch mode, and strict host-key checking. It retains the system known-hosts files but has no SSH config, agent, interactive prompt, or alternate-key fallback.

`credentials.js` owns managed SSH inventory and onboarding through `GitAPI.managedSshCredentials` and `POST /api/git/managed-ssh-credentials`. Explicit `inventory` reads at most 256 store records under a ten-second verification budget. It verifies each actual private key through the same private snapshot verifier as execution, cleans the snapshot, and returns only an opaque credential reference, the safe `SSH` label, stored public fingerprint, and ready/unavailable capability. Missing keys, encrypted or unverifiable keys, and fingerprint mismatches have distinct safe reason codes; one unavailable key does not hide healthy records. Store, inspection infrastructure, deadline, and cleanup failures fail the request rather than returning authoritative empty inventory. Responses use `Cache-Control: no-store`.

Explicit `discover` inspects only immediate entries in the server-approved root, configured by server composition as the server user's `~/.ssh`. It reads at most 128 entries, never recurses, rejects the root and entries when they are symbolic links, and does not parse SSH config, certificates, public-key files, known-hosts files, environment paths, or agent state. Candidate files must be regular, at most 128 KiB, contain a private-key marker, and on POSIX grant no group or other permissions. The operation opens each source with `O_NOFOLLOW`, snapshots bytes from that handle, derives the public key from the actual unencrypted private key, and fingerprints that public key. Encrypted and permissive likely keys may appear with a safe unavailable reason; unreadable likely filenames may appear without a fingerprint; other unreadable or non-key files are omitted. The public result contains only a safe basename label and, for ready candidates, a random opaque ID plus public fingerprint. It never contains a host path or key content.

Ready candidates live only in the server process. The registry holds at most 256 candidates, expires each after five minutes, and may evict the oldest candidate to remain bounded. Restarting the server, expiry, or eviction invalidates the ID. `import` accepts only the opaque candidate ID, its exact expected fingerprint, and literal `confirmed: true`. It reopens and re-realpaths the same immediate file, requires the original file identity and timestamps, snapshots and derives the fingerprint again, and rejects changed, expired, unavailable, or mismatched candidates without writing the store. Concurrent reuse of one candidate is rejected.

A successful import exclusively copies the verified operation snapshot to a random operation-owned filename under mode-`0700` `OPENCHAMBER_DATA_DIR/git-ssh-private-keys`, sets the file to mode `0600`, and appends an opaque version-1 record through the store's cross-process file lock. The new record contains only the managed copy path, never the original host path. A failed pre-commit store append removes the owned copy; cleanup failure fails the request. If the atomic store replacement commits but lock cleanup fails, import retains the copy so the committed record stays valid and fails the request for operator recovery. Import returns the verified resulting inventory and selected credential, but does not bind a provider, repository, remote, or author profile. Existing records remain compatible. Configure trusted known-hosts records separately; this flow does not alter known-host verification. Passphrase-protected or agent-only keys require explicit unverified System transport, and managed execution never falls back to it.

After credential resolution, managed HTTPS snapshots expose actor metadata as `{ kind: "provider", provider, instance, accountId, login? }`; `accountId` is the stable provider-user ID, never the opaque credential ID, and `login` is omitted when unavailable. Managed SSH exposes `{ kind: "ssh-key", fingerprint }`. System transport has no verified actor and reports `{ status: "unverified", reason: "system-credentials" }` because it inherits the server process's Git and SSH environment.

System push and remote-deletion planning need no separate acknowledgement: System Git is what a repository uses when nothing else was chosen, so the plan records the unverified transport and proceeds. A repository with no binding record plans every remote as a ready System grant against the store's tombstone revision (`binding-service.js` `validateGitTransportContext`), so an unconfigured repository pushes, pulls and fetches exactly as it did before bindings existed, and a later configuration invalidates a plan made against the unbound state.

The raw endpoint is an internal transport value. It never appears in public plans or results. Provider account bindings, Git transport credentials, and commit identities remain separate. In particular, `gitIdentityId` configures repository-local `user.name` and `user.email`; it is not a transport credential.

### Review refs on a change host

A host whose descriptor declares `capabilities.createVia: 'push'` (Gerrit) creates a change from a push to `refs/for/<branch>` and serves each revision at `refs/changes/NN/<change>/<revision>`. These refs open only on a remote that is the primary remote of a ready provider association with such a host: the binding service lists those providers in the transport authority (`primaryOf`), and `isChangeReviewRemote` checks it at planning and again before every transfer, so an association removed after planning stops the push with `REMOTE_CHANGED` before Git runs. Anywhere else the planner refuses with `400 INVALID_REQUEST`, because `refs/for/*` on another host would create an ordinary branch.

A push for review is `operation: 'push'` with `review: { target, topic?, wip?, private?, hashtags? }`; a `destinationRef`, when sent, must be exactly `refs/for/<target>`, and `forceWithLease`, `configureUpstream` and `destinationSelectionId` are refused. The source must be a branch. The target passes the exact-ref rule as `refs/for/<target>`, must not contain `%` or `,`, and must come back unchanged from `git check-ref-format --branch`. Topic and hashtags match `^[A-Za-z0-9._-]{1,128}$` (at most 16 hashtags, deduplicated), so they need no encoding. The server composes the refspec `<pinned-sha>:refs/for/<target>%topic=…,wip,private,t=…` and keeps it in the internal plan; the public target, the durable snapshot and the audit record carry only `destinationRef: refs/for/<target>`. A review push writes no remote-tracking ref and no upstream.

A single-ref fetch may take `refs/changes/NN/<change>/<revision>` as its source under the same gate, where `NN` is the change number's last two digits. Its destination follows the ordinary fetch rule.

A worktree made from such a change (`worktree-creation.js`) fetches its revision ref into `refs/remotes/<primary remote>/change-<number>` and checks it out on the local branch `change-<number>`, whatever branch name the caller asked for. The ref is accepted only from the same repository of a provider whose descriptor has `createVia: 'push'`; any other head that is not a branch is refused with `409 INVALID_REQUEST` before a transfer.

`POST /api/git/change-id` (the Change-Id preflight, `../source-control/change-id.js`) is a local commit rewrite: it moves the branch only by compare-and-swap from the caller's `expectedHead`, sends nothing over the network, and is not audited.

### Remote Fetch

Everyday Fetch uses `operation: 'fetch', fetchScope: 'remote'` with the selected remote, repository/binding/config revisions, endpoint metadata, and transport mode. It accepts no caller-supplied refs, refspecs, force flag, or command options. The shared helper selects this mode before checking current branch or upstream. Detached HEAD, unpublished branches, and remotes unrelated to tracking need no branch picker. A remote needs its own transport grant, not a provider account.

The runtime reads effective `remote.<selected-name>.fetch` values through a bounded, NUL-delimited local config query. It supports exactly one `refs/heads/*:refs/remotes/<selected-name>/*` mapping, optionally prefixed with `+`. Missing, empty, duplicate, negative, single-branch, tag, mirror, and custom-destination mappings fail explicitly. The public target records `fetchScope: 'remote'` and the resolved boolean `force`; the configured refspec stays internal. Planning pins the mapping. Execution rereads it before credentials and immediately before transfer alongside the existing endpoint, revision, and credential checks.

Remote Fetch sends the pinned mapping to the authoritative endpoint with `--atomic --no-tags --no-prune --no-prune-tags --no-recurse-submodules --refmap=`. It refreshes advertised heads into only the selected remote's tracking namespace, including new branches and configured forced updates. It does not prune deleted branches, auto-follow tags, recurse into submodules, integrate commits, or configure upstream. Atomicity covers ref updates; existing lifecycle errors, cancellation, cleanup, and terminal metadata remain in force. Menu rendering and branch listing start no transfer. Planning validates local state only; execution starts the remote transfer after the user selects Fetch.

Exact-ref Fetch also accepts `fetchScope: 'ref'`. Existing callers that omit the field retain the shipped exact-ref schema and must provide both full refs. Pull, contributor transfers, and Sync retain their existing behavior. Remote Fetch audit targets add only the scope and resolved force boolean to the selected remote name and endpoint fingerprint; they contain no raw URL or configured refspec. Existing version-1 audit records remain readable.

### Pull integration

Pull and Sync replay the local branch onto the fetched commit with `git rebase --fork-point --onto <fetched> <tracking ref>`, the way `git pull --rebase` does: only the commits made since the remote copy was last seen (its fork point in the tracking ref's reflog) are replayed. A remote branch its host rewrote, such as GitHub rebasing a stacked branch after the layer below it merged, then lands without its old commits replayed on top of their rewritten selves. With no tracking ref the fetched commit itself is the base, as before.

#### Why the rebase reads line endings from the person's configuration and does not autostash

Before replaying, `git rebase` refuses a working tree with unstaged changes, and it decides that by comparing files with the index under its own configuration. The integration context reads no system file and, of the global one, only the copy of the person's `safe.directory` entries, so on Windows, where Git for Windows sets `core.autocrlf=true` system-wide, and in any repository with LFS files, a tree the person's Git and the panel call clean failed Sync with "cannot rebase: You have unstaged changes" (#5887). Autostash would hide that, and it would also stash and replay real edits the person has not committed, so the rebase keeps `--no-autostash` and gets the settings that decide the comparison instead. Those settings are data or a local hashing filter; credential helpers, proxies and URL rewrites stay out, and the rebase runs after the transfer's credential is revoked. Other custom clean filters stay off, since running an arbitrary configured program is what the context exists to prevent, so a repository that relies on one can still see this refusal.

### Clone

Clone is the one parent raw-endpoint input boundary because a new checkout has no repository binding. It accepts HTTPS URLs, SSH URLs, and SCP-style SSH endpoints only. It rejects other protocols, local paths, remote helpers, option-shaped values, control characters, URL query/fragment data, HTTPS userinfo, passwords, and unsafe path components. An HTTPS endpoint on a default instance, or on the instance of the selected credential or provider account, of a provider whose descriptor sets `appendDotGitToHttpsClone` (GitLab: `gitlab.com` and self-managed instances) gains a `.git` suffix when it lacks one: GitLab redirects the bare address, and managed and anonymous transfers never follow redirects. The plan, the transfer, and the `origin` written by the clone all use that address. Planning resolves one absolute destination and an operation-owned sibling temporary directory; both must be absent. Optional auxiliary grants contain only a kind, redacted endpoint metadata, transport mode, and endpoint-specific credential ID. They never contain the discovered raw endpoint.

Every clone intent chooses `transportMode` explicitly. System requires `unverifiedConfirmed: true`, and managed HTTPS requires an independently selected `credentialAccount` with provider, instance, and exact credential ID. The planner checks the account instance against the approved HTTPS endpoint, reads that exact valid persisted credential without active-account or CLI fallback, and constructs a host-owned `ocgit:v2` reference pinned to its immutable ID and revision. Reauthentication or replacement cannot retarget the plan or the binding created after checkout. Managed SSH requires a selected existing host `sshCredentialId`, validated against the managed inventory and an SSH endpoint before planning. It rejects provider accounts; HTTPS, anonymous and System requests reject SSH references. Execution derives the actual key fingerprint again. Parent `credentialId`, tokens, and key paths are not accepted from clients. Provider associations and author profiles never choose clone transport. Anonymous HTTPS clone selects only `transportMode: 'anonymous'`, with no account or System confirmation. The same exact-endpoint callback persists the chosen grant at revision 1, and binding failure retains the completed checkout as partial.

Git clones with `--no-checkout`, hooks disabled, and `GIT_LFS_SKIP_SMUDGE=1` into the temporary directory. The shared UI requires transport selection before planning and sends no operation on cancellation before planning. Closing during planning cancels the returned plan before execution; closing during execution requests cancellation of that operation ID. The older filesystem route remains an explicitly confirmed System compatibility adapter. A selected commit identity is validated before plan registration or spawn, then applied as repository-local `user.name` and `user.email` in that checkout. The host resolves a global author independently of managed transport's isolated Git configuration. The operation performs a filter-disabled forced checkout, attempts bounded submodule and LFS hydration, and then claims the absent destination with an exclusive `mkdir` and copies checkout entries with no-replace operations. Successful or unnecessary hydration returns success. Incomplete non-cancelled hydration publishes the checked-out repository as `partial` so setup can be repaired in place. This is not an atomic rename or atomic publication. Before each publication filesystem mutation it checks cancellation and the operation deadline, then waits for that mutation to settle and records any new ownership before returning a timeout or cancellation result. Directory ownership identifies a pathname by device and inode, plus creation time where the filesystem keeps a real one. The operation establishes that by changing each directory it creates once on purpose and checking that the reported creation time sits still; Node otherwise fills that field from the change time, which every clone moves as it writes its own checkout. Where creation time holds, a directory removed and recreated in place is detected even though Linux reuses the inode number. Where it does not, ownership falls back to device and inode rather than failing every clone. Cleanup mutations run after terminal intent and are also awaited to settlement.

After publication, `bindClonedRepository` resolves the new repository and compares both actual `origin` fetch and push endpoints with the captured approved endpoint, including fingerprints. Only an exact match permits a revision-zero CAS creating binding revision 1 with the selected System grant or exact managed credential reference. The binding also retains only auxiliary grants that matched an endpoint and kind actually discovered during this hydration attempt; unused client grants are discarded. Provider associations remain empty and local authorship stays separate. Persistence is awaited to settlement. Endpoint verification or binding persistence failure returns `partial` with `checked-out`, a redacted finish-setup message, and the completed destination retained. Later cleanup failure also returns partial when checkout is complete. The shared parser rejects partial clone results without `checked-out`; the dialog registers the retained project and opens Git setup with warning feedback, not clone success or full failure. Retry uses setup on that checkout, never another clone into its existing destination. Temporary cleanup still runs, and incomplete publication retains the operation-owned cleanup rules below.

Clone publication creates every directory, file, and symlink exclusively and records each node's identity and content metadata immediately. On failure, cleanup atomically renames the destination root into a fresh same-parent operation-private quarantine before inspection. It recursively deletes only the quarantined tree when the root, complete entry set, identities, and file or link contents match the operation's records. A changed or replacement tree is restored only by an atomic rename from quarantine. If the original path is occupied or rename fails, cleanup leaves the complete tree in quarantine and returns a redacted `UNKNOWN` cleanup failure. Temporary checkout cleanup uses the same rename-first rule and deletes only a quarantined root with the operation-owned identity. No recursive deletion targets the original destination or temporary pathname.

### Anonymous reads

`anonymous` is a distinct credential-free HTTPS read mode for fetch, pull, and clone. Push, remote-branch deletion, and a sync with an anonymous push target fail before plan registration or transfer. A sync may use an anonymous fetch target only with a separately authorized non-anonymous push target. Anonymous requests reject credential references and credential accounts. SSH is unsupported, including public-key or agent fallback.

Anonymous execution uses managed HTTPS environment and exact-key local HTTP sanitation, but never calls the credential resolver or starts a broker. It disables credential helpers, AskPass, cookies, delegation, automatic client certificates, redirects, recursive fetches, and non-HTTPS protocols. An isolated home and removal of `NETRC` prevent Curl from finding host credentials outside Git config. Managed HTTPS uses the same isolated home, so an ambient `~/.netrc` entry cannot authenticate as an account other than the selected one; managed SSH keeps the host home. TLS verification stays enabled in production. Repository URL rewrites return `RUNTIME_UNSUPPORTED` rather than redirecting the approved endpoint. On Git/Curl builds that reject an empty client-certificate reset, an existing local client-certificate setting can still make the read fail; there is no retry with ambient authentication.

Public transport is `{ mode: 'anonymous', verification: { status: 'anonymous' } }`, with no actor. Audit transport is `{ kind: 'anonymous' }` and has no provider account. Auxiliary endpoints still need independent exact grants, even on the same host. An exact anonymous auxiliary grant may fetch only an HTTPS submodule or LFS endpoint under the same credential-free environment isolation; it never starts the credential resolver or broker. Missing grants remain authorization-required. Explicit managed auxiliary grants cannot replace the parent's anonymous metadata.

The loopback HTTPS canary exercises real clone, fetch, pull and an authentication challenge with test-only self-signed TLS acceptance. It checks local included headers, cookies, helpers, AskPass, netrc, proxy and client-certificate isolation. These tests do not establish native Windows or packaged-runtime behavior.

### Checkout hydration

The operation executor reads `.gitmodules` from the selected commit with `git config --blob --null` and pairs it with mode-`160000` entries from `git ls-tree`. Relative URLs resolve against the exact parent fetch endpoint that produced the checkout. Worktree hydration carries that source from the fetch itself; it never infers one from provider bindings, upstream configuration, `origin`, or remote order. If no exact source can be proved, hydration returns `AUTHENTICATION_REQUIRED` before starting a child process. The executor never invokes `git submodule update`, recursive update, or repository-defined update commands. Children initialize sequentially with `clone --no-checkout`, hooks and LFS smudge disabled, and a forced detached checkout of the exact gitlink. Each child HEAD must equal that gitlink before success is recorded or recursion starts. Recursion, paths, modules, command output, pointer samples, and public results have hard limits.

`checkout-hydration` is an existing-repository planned operation. Planning pins repository ID, binding and config revisions, exact parent remote and endpoint fingerprint, HEAD, and the bounded transfers found through local inspection. Existing exact submodule checkouts are inspected recursively but do not become transfer requirements. The server resolves each transfer-capable endpoint's auxiliary grant during planning and pins only grants that validate against the discovered raw endpoint; missing grants remain authorization failures and a grant added after planning cannot retarget the operation. Planning starts no network process. Execution repeats repository, inspection, and exact auxiliary-grant checks before transfer. Public plans and results contain only repository-relative paths and redacted endpoint metadata. Process-local operation recovery stores the operation ID, but restart reconciliation never executes or resumes hydration automatically.

Each submodule endpoint needs an exact auxiliary grant, including same-host paths. Cross-host children never receive the parent credential. The executor resolves every credential by the child endpoint's own opaque ID, checks the discovered endpoint against the grant before credential resolution and again before spawn, and redacts raw endpoints, paths, credentials, and process errors. One child failure does not erase completed siblings. Cancellation between children prevents later children from starting. Every existing component of a submodule checkout path must be a real directory; symbolic links fail before auxiliary authorization or transfer. After authorization, the executor checks the path components again and creates missing parent directories one level at a time before it creates the child checkout. Repair accepts an already-present child only when its HEAD exactly equals the committed gitlink, then inspects it recursively without another clone. A child directory created by the current failed transfer is quarantined and removed only when its filesystem identity still matches the operation's record.

LFS discovery combines effective attributes, bounded object batches, committed `.lfsconfig`, effective `lfs.url` and remote LFS URLs (Git configuration wins over `.lfsconfig`, and `lfs.url` over `remote.<name>.lfsurl`, as in Git LFS), and executable filter and transfer configuration. It queries attributes and object metadata in batches of at most 1,024 paths, then reads only pointer-sized blobs through `cat-file --batch`. A complete ordinary repository is not rejected merely for exceeding 256 or 1,024 files, LFS files included: every pointer-sized blob is validated, but the scan keeps at most 256 attribute records and 256 pointer samples as evidence, so memory does not grow with the number of LFS files. `discoverLfs` therefore returns `attributePaths` and `pointers` as bounded samples; hydration reads only whether LFS is needed. Listing, query-output, and pointer-byte limits remain enforced. A checkout that exceeds one of them, such as a tracked-file listing over 16 MiB, fails hydration with `CHECKOUT_TOO_LARGE` under the `invalid` status, never as a configuration error. Submodule discovery limits keep `INVALID_REQUEST`. Incomplete or malformed discovery fails closed, never as `not-needed`. Custom transfer agents and non-canonical executable LFS filters fail before LFS execution. The effective HTTPS LFS endpoint gets its own exact auxiliary grant, including for an SSH Git checkout. Hydration runs explicit `git lfs fetch <selected-parent-remote> HEAD` and `git lfs checkout` under registry process ownership. A required missing client returns `GIT_LFS_CLIENT_MISSING` with `client-missing` instead of a generic clone failure.

Local worktree hydration first inspects local content. Git-route and OpenChamber-session creation both use the server's one durable bootstrap store and always invoke this inspection, including for repositories without a source-control binding. Both pass the repository authority from the binding read, so an unbound repository resolves its checkout remote and submodule endpoints as System grants against the store's tombstone revision, the same way it pushes and fetches. A checkout needing neither submodule nor LFS transfer requires no parent remote; required hydration without an exact source persists path-specific authorization data rather than choosing `origin` or reporting setup ready. Its operation-private durable marker carries no fabricated repository or remote authority and cannot complete a retained-checkout repair blocker. Managed pull and sync integration use a credential-free local execution context with network protocols, lazy fetching, hooks, content filters, fsmonitor, autostash, and recursive submodule operations disabled. Two things come from the person's own Git configuration as their Git reads it in that repository: the line-ending settings (`core.autocrlf`, `core.eol`, `core.safecrlf`, `core.attributesFile`) and the LFS clean filter when it is the canonical `git-lfs clean -- %f`, no `lfs.extension.*` is configured (git-lfs would run an extension's program), and the repository's own configuration sets no `filter.lfs.process`, because any `process` value, an empty one included, keeps Git from running `clean`. Required post-integration hydration uses explicit grants; failure preserves the completed local update and skips sync publication.

Checkout discovery and publication preparation accept repeated effective Git filter entries only when each value is identical and canonical: `filter.lfs.clean=git-lfs clean -- %f`, `filter.lfs.smudge=git-lfs smudge -- %f`, `filter.lfs.process=git-lfs filter-process`, and `filter.lfs.required=true`. Conflicting values, all other duplicate effective keys, and duplicate committed `.lfsconfig` keys remain invalid.

### Managed LFS publication

Before managed Git ref publication, the executor scans objects reachable from the pinned source commit, including historical pointers but excluding unrelated refs. Required LFS objects upload through `git lfs push --object-id openchamber-lfs <selected-oids>` in an operation-private bare repository. The HTTPS LFS endpoint is resolved independently from pinned committed configuration, effective LFS settings, and the exact selected Git push endpoint. It needs its own ready managed auxiliary grant and credential; an SSH parent key is never reused for HTTPS LFS.

Source, configuration, and grant authority are revalidated before upload. Missing client or grant blocks Git ref transfer. Cancellation and timeout retain the existing operation deadline, process ownership, credential cleanup, and private-directory cleanup. Parent Git credentials are acquired after LFS preparation to avoid expiring their lease during a long upload. LFS upload success followed by Git push failure is not operation success and reports the already-uploaded objects. Sync retains completed integration as a partial result when publication preparation fails.

The upload path supports managed HTTPS Git and SSH Git with a separately configured HTTPS LFS endpoint. Pure SSH LFS, System auxiliary upload, and anonymous LFS are unsupported. Live git-lfs authentication and server-returned upload URL/redirect behavior require the real-client integration fixture; fake child responses do not establish those guarantees.

Public hydration results contain one bounded record per discovered submodule and repository LFS scope. Statuses are `succeeded`, `authorization-required`, `invalid`, `client-missing`, `failed`, `cancelled`, or `not-needed`. Records contain only repository-relative paths, redacted endpoint metadata, and stable errors. Successful auxiliary credential resolution and child transfer advance the same durable operation steps as other network operations; a checkout that needs no transfer records neither `authenticated` nor `transferred`. A non-cancelled clone hydration failure publishes and binds the checked-out repository as `partial`; repair never reclones it. Worktree bootstrap receives hydration through an injected operation-owned callback, so `service.js` starts no hydration network process. It advances to `git-ready` only after hydration succeeds and retains the stable top-level error code plus bounded hydration result on failure. A later successful `checkout-hydration` operation atomically updates only a retained hydration-owned failure to `ready`/`setup-ready`; unrelated bootstrap failures remain unchanged.

### Results and cancellation

Operation states are `planned`, `running`, `succeeded`, `partial`, `conflicted`, `failed`, `cancelled`, and `outcome-unknown`. Completed steps may include `validated`, `authenticated`, `transferred`, `updated-local-repository`, `checked-out`, and `cleaned-up`. Every terminal sync snapshot also returns ordered `fetch`, `pull`, and `push` step results. Each step is exactly `succeeded`, `skipped`, `conflicted`, `failed`, or `cancelled`; failed or interrupted steps include a redacted structured error, and unstarted downstream steps are `skipped`. Fetch success followed by push failure is `partial`. A pull conflict is `conflicted` and skips push. Cancellation between steps marks the next step `cancelled` and skips later work. If cancellation interrupts a spawned push, the push step is `cancelled` while the operation is `outcome-unknown`, because remote acceptance cannot be proved.

Planning and execution each use one absolute five-minute deadline by default; the deadline does not reset between authority, credential, filesystem, fetch, and integration phases or between child processes. The legacy `cloneRepository` adapter starts one deadline before identity validation and carries it through planning and execution. Duplicate execute requests join the first process-local promise and its deadline.

Cancellation before execution becomes terminal without spawning. Cancellation and timeout terminate the attached process tree, with forced escalation after one second by default. Fetch and clone interruption return `cancelled` with `CANCELLED` or `TIMEOUT`. Once push transfer starts, interruption returns `outcome-unknown` because the remote may have accepted the update. Pull interruption during merge returns `conflicted` when `MERGE_HEAD` remains, otherwise `outcome-unknown` because the local result cannot be proved. Terminal cancellation returns the existing snapshot.

A broker lease's nonce reaches the helper only through the `OPENCHAMBER_GIT_CREDENTIAL_NONCE` environment variable the lease returns in `env` (the operation merges it into the Git process environment); the helper command line carries the loopback URL only, because argv is readable by other local users.

The service revokes broker leases and managed credential snapshots on terminal paths. A successful operation becomes `failed` if required credential or temporary-ref cleanup fails. Pull temporary-ref deletion gets a fresh bounded five-second cleanup deadline, even when the operation deadline expired or cancellation was requested; no other Git command bypasses cancellation.

### Audit trail

The web server writes one logical source-control audit record for each Git network operation and approved checkout-action execution through `source-control-audit.json`, separate from the process-local operation registry and provider mutation replay storage. The service registers an operation in memory, persists its audit record before returning the plan, and cancels the unexposed operation if audit persistence fails. An operation-ID collision fails before audit planning and does not alter the existing audit record. Execution marks the record running and writes the compact terminal result after the registry settles; duplicate execute calls join one audited execution. Cancelling an unstarted plan records cancellation without spawning.

Git audit targets copy only operation names, remote names, endpoint fingerprints, full refs, and clone destination display metadata from the immutable public plan. Checkout hydration instead records a bounded kind-plus-endpoint-fingerprint target for each discovered transfer-capable requirement and no parent remote. Its transport reference contains only the matching server-validated auxiliary grants, one exact managed credential reference, System marker, or anonymous marker per kind and endpoint. Missing grants have no transport entry, and hydration that needs no transfer records `null` transport. Hydration never attributes the parent credential or a single provider account to its independent child transfers. Audit records omit endpoint display URLs as well as internal directories, repository-relative hydration paths, temporary paths, pinned SHAs, process output, hydration payloads, and error messages. A managed single-path operation stores its exact opaque `credentialId`; a system operation stores `system-credentials`. Sync stores separate fetch and push entries so mixed transport and distinct managed credentials remain visible. The schema permits credential reference strings only, never resolved usernames, passwords, tokens, SSH key paths, or other credential payloads. Managed HTTPS operations derive provider account identity from the separately encoded provider-user ID only when the strict reference parser proves it. They never publish the opaque credential ID as provider identity; legacy v2 references without provider-user attribution, SSH, unresolved, differing sync authority, and checkout hydration record `null`. Approved local checkout actions use `local-checkout-actions`, register through the audited path, and contain no remote. Runtime and repository identity come from the immutable plan, and clone uses a `null` repository ID because no repository exists during planning. Current managed entrypoints always record `user` as initiator and `openchamber-server-git` as executor.

### Legacy route gate

`POST /api/git/push`, `POST /api/git/pull`, `POST /api/git/fetch`, and `DELETE /api/git/remote-branches` are fail-closed compatibility routes. They always return `409 GIT_NETWORK_OPERATION_REQUIRED`; a missing binding or tombstone never restores ambient System Git execution. First-party network actions use the planned operation API.

Contributor-fork provenance is stored under `OPENCHAMBER_DATA_DIR`, keyed by the common-repository identity plus the linked worktree Git-directory filesystem identity. The strict bounded store uses atomic mode-`0600` writes and compare-and-swap revisions; malformed, insecure, or unreadable state fails closed. A worktree of an unbound repository records binding revision 0, the revision its change request was read under. Creation persists provenance before reporting success and removes the attached worktree if that write fails. Worktree listing resolves all listed identities against one bounded authoritative store snapshot instead of reparsing the store once per worktree. Public worktree reads expose only `{ kind, revision, trust, push }`, never paths, source SHAs, or raw endpoints.

Legacy push, pull, fetch, and remote-branch deletion reject contributor worktrees before Git execution. System-credential contributor transfer is also rejected by managed planning. Contributor publish entrypoints first ask the server whether the worktree has contributor provenance. A contributor that is behind runs an exact managed pull against its tracked source, then opens the destination chooser and creates the push selection from the post-merge state; a push-only contributor opens the chooser immediately. Push requires a one-use, 15-minute server-issued destination selection that pins linked-worktree/provenance identity, repository/binding/config revisions, current source SHA, remote endpoint fingerprint, and destination ref. Every current managed remote is eligible, including the contributor fork itself when its push endpoint has an exact managed binding. The server classifies candidates as contributor fork, own fork, bound repository, or other only from provenance, provider binding, and exact account authority; remote names alone do not establish ownership.

### Runtime parity

Existing repositories configure parent and auxiliary transport in the Git panel through `GitAPI.configureTransportBinding` and `GitAPI.configureAuxiliaryBinding`. The source-control binding service owns their exact repository/revision/fingerprint validation and narrow record updates, documented in [Repository binding routes](../source-control/DOCUMENTATION.md#repository-binding-routes). Explicit System setup, anonymous HTTPS, selected-account managed HTTPS, and selected-existing-key managed SSH use the server in web, Electron, hosted mobile, and Capacitor mobile. Setup performs no transfer and never derives a credential grant from provider selection. The managed SSH inventory also provides a source-control read projection that verifies the exact key record and returns only its public fingerprint, never its record ID or private path. These server-backed runtimes expose explicit inventory, bounded host discovery, and confirmed import; none run automatically. VS Code omits this capability entirely: its webview projects repository remotes as a ready System-transport binding and offers no transport configuration.

Web, Electron, hosted mobile, and Capacitor mobile use the connected OpenChamber server and its runtime identity. The identity is `{ id: "server_<uuid>", platform: "web" | "desktop" }`; clients do not choose it, and the durable store accepts no other platform. Electron does not start a renderer-owned Git process. System credentials belong to the connected server host, which may differ from the client device.

VS Code runs existing-repository network operations as plain Git commands on the extension host with the user's own Git credentials. The webview maps the shared operation lifecycle onto the standard `api:git/push`, `api:git/pull`, `api:git/fetch` and `api:git/remote-branches` bridge messages and keeps operation snapshots in webview memory; nothing is audited or persisted. Managed transport, contributor destination selection, clone, checkout hydration, and auxiliary grant configuration are unsupported there. See `packages/vscode/src/DOCUMENTATION.md`.

### Log Operations
- `getLog(directory, options)`: Get commit history with stats (supports maxCount, from, to, file filters). With `from`, it lists `from..to`: only the commits `to` adds, matching the VS Code runtime.
- `getCommitFiles(directory, commitHash)`: Get file changes for a specific commit relative to its first parent, or the empty tree for a root commit. NUL-delimited paths preserve whitespace; renamed files return their destination in `path` and source in `previousPath`.
- `getCommitDiff(directory, { hash, path, previousPath, contextLines })`: Get the same commit's patch, with optional file filtering and context depth. `previousPath` keeps a rename's old and new paths in the per-file patch. Reads committed objects only, never the working tree. Exposed as `GET /api/git/commit-diff`; an unavailable hash fails rather than returning an empty diff.
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

## Git from any shell

Planned operations own every transfer OpenChamber starts, and they run with a
scrubbed environment so no ambient credential can reach them. A `git push`
typed in a terminal or in the agent's shell is a different process: it reads
the repository's own configuration and the machine's credential helpers. A
repository given an identity with an account therefore names OpenChamber in
its own `.git/config`, so that push acts as the same account from anywhere.

- `configureRepositoryTransport(directory, { credentialHelper, sshCommand })`
  in `service.js` writes and removes what OpenChamber names there: an empty
  `credential.helper` (Git's way of saying the entries before it do not apply
  to this repository) followed by the launcher for an account grant, and
  `core.sshCommand` naming `ssh-wrapper.js` with the key for a managed-key
  grant. With the helper it also turns on `credential.useHttpPath` (unless
  the person set that key; the `openchamber.credentialUseHttpPath` marker
  records ownership) so Git sends the repository path. It removes only its
  own entries: the helper and the empty reset directly before it; a helper or
  empty reset the person configured stays. `source-control/routes.js` calls it after every transport grant
  change, so choosing the System identity removes both.
- `repository-credential-runtime.js` answers Git. On every server start it
  writes `bin/git-credential-openchamber` (a launcher pinning this executable,
  which tells Electron to run as Node) and `git-credential-endpoint.json`
  (the callback URL and a fresh secret, mode `0600`) under
  `OPENCHAMBER_DATA_DIR`, so a repository configured against an earlier start
  keeps working. `POST /api/git/repository-credential` takes the helper's
  working directory and Git's query and answers only for that repository's own
  binding, selecting the grant by host and repository path (a git-lfs sub-path
  counts as its repository): a managed HTTPS grant resolves to a credential
  for this one request, a System grant or an endpoint no grant names is handed
  back to the machine, and a managed grant that is not ready (account
  disconnected, remote changed) or whose credential is gone answers nothing,
  so a shell push never silently falls to another account. A query without a
  path (a repository configured before path matching) is answered only when
  every grant on the host agrees.
- `repository-credential-helper.js` is what Git runs. When the server says
  System, or when the server is not running at all, it asks the person's own
  credential chain by running `git credential fill` from outside the
  repository, so the local entries that name it are not consulted. A closed
  app never blocks a push; it only means the machine's own account answers.

The route is exempt from the UI session guard because it carries the secret
from the endpoint file and refuses any peer that is not this machine
(`agent-tool/callback-address.js`: loopback, or the bound address when the
listener is bound to one concrete address). The helper has no UI session and
cannot obtain one, so the guard would make a repository's account silently
unusable wherever a UI password is set, which Docker requires.

Anyone who can run Git in the repository under the same user gets that
account's credential, exactly as with `gh auth setup-git` or a credential
manager. The agent's shell is one such place, which is the point: the agent
pushes as the identity the repository was given, without a tool of its own.
OpenChamber offers no managed transfer actions to the agent and does not
intercept its shell; `gh` and `glab` are its own to run when they are
installed.

## Internal Helpers

The following functions are internal helpers used by exported functions:
- `buildGitEnv(directory)`: Build Git environment with the directory's variables from Settings laid over the inherited environment (`../environment`, wired through `configureGitEnvironment`; the names simple-git refuses, see `createGit`, and the repository-location variables `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ... are left out of that overlay), SSH_AUTH_SOCK resolution and `GIT_TERMINAL_PROMPT=0` (unless the server was started with it set; a Settings variable cannot turn it back on): the server has no terminal a user could answer, so a Git command that would ask for a username or password fails instead of waiting forever on a console nobody sees. Credential helpers, including GUI ones, still run before Git would prompt. Inside a Linux AppImage it also drops what the AppImage launcher added to `PATH`, `LD_LIBRARY_PATH`, `GSETTINGS_SCHEMA_DIR` and `XDG_DATA_DIRS` (`stripAppImageLauncherEnv`, #4177), so hooks run with the user's values.
- `createGit(directory, { extraEnv })`: Create simple-git instance with the `buildGitEnv(directory)` environment plus `extraEnv` (a temporary `GIT_INDEX_FILE`, for example). simple-git ignores an `env` constructor option, so the env goes through `.env()`, once: simple-git 4 refuses a `GIT_*` name that is not in `allowEnvironment`, so a variable added later with `.env(name, value)` makes the command throw. simple-git 4 passes git only what `allowEnvironment` names among `GIT_*` variables and the variables that run a program (`EDITOR`, `VISUAL`, `PAGER`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `PREFIX`, `GIT_CONFIG_GLOBAL`, ...), and it rejects a command whose env holds a program-running variable unless that variable's `allowUnsafe*` category is on. `simpleGitEnvOptions` names every variable of the built env in `allowEnvironment`, and turns on the category of each program-running variable whose value is the server's own, unchanged: git would inherit it without an explicit env anyway, and users rely on them for custom SSH keys, GUI credential prompts and alternative global config files. A program-running variable OpenChamber sets or changes keeps its category off and is still refused. Those categories also guard `-c` and other arguments, so a server started with `EDITOR` set accepts `-c core.editor=...` in simple-git arguments; OpenChamber builds those arguments itself and never passes such a key. A server-inherited `GIT_CONFIG_COUNT` entry whose key simple-git guards (`credential.helper`, `core.sshCommand`, ...) makes simple-git commands fail with simple-git's message; simple-git 3 passed it through. `SIMPLE_GIT_REFUSED_ENV_CATEGORIES` copies the table of program-running names in `@simple-git/argv-parser`; compare it on every simple-git update, because a name missing from the copy makes every simple-git command fail on a machine whose environment sets it. `service.test.js` ("git environment through simple-git") sets every name in the copy except `GIT_CONFIG`, and fails on the first one simple-git refuses. `GIT_CONFIG` stays out because Git then refuses `git config --local` and `--global` ("only one config file at a time"), which breaks the author check before a commit on simple-git 3 and 4 alike.
- `normalizeDirectoryPath(value)`: Normalize directory paths (supports ~ expansion).
- `cleanBranchName(branch)`: Remove refs/heads/ or refs/ prefixes.
- `parseWorktreePorcelain(raw)`: Parse `git worktree list --porcelain` output.
- `resolveWorktreeProjectContext(directory)`: Resolve project context (projectID, requestedDirectory, primaryWorktree, worktreeRoot, legacyWorktreeRoot); `requestedDirectory` is the folder the worktree was requested from, where the project start command is read; `worktreeRoot` honors OpenCode's `worktree.directory` and falls back to the data-dir folder keyed by project ID.
- `resolveCandidateDirectory(...)`: Generate unique worktree directory candidates.
- `resolveBranchForExistingMode(...)`: Resolve branch for existing-mode worktree creation.
- `applyUpstreamConfiguration(...)`: Set upstream tracking for new branches.
- `buildWorktreePopulateCommand(directory)`: Inspect effective content-filter keys and construct the filter-neutral, hook-neutral, no-network reset command used for initial population.
- And various other internal helpers for Git command execution and parsing.

### Why an SSH host alias is resolved through `ssh -G` and not compared as written

Gitea and Forgejo accept an SSH alias only when its effective `HostName` directly equals the instance's hostname. `HostKeyAlias` and a shared resolved address do not establish which Git service the remote names, so neither grants a match. `ssh -G` handles `Include`, `Match` and `Host *` rules without opening an SSH connection; parsing the config file directly would miss those rules. Completed answers, including failures, expire after one minute, concurrent callers share a pending read, and the cache holds at most 256 hosts. HTTPS remotes and SSH hosts already equal to the instance's hostname require no lookup. The remote endpoint keeps its original alias. GitHub and GitLab retain exact-host matching because their repository readers do not resolve these aliases.

## Response Contracts

### Status Response
- `current`: Current branch name.
- `tracking`: Upstream branch (e.g., 'origin/main').
- `ahead`: Number of commits ahead of upstream. Without an upstream, a full read counts the commits missing from the base branch instead (`origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`).
- `behind`: Number of commits behind upstream.
- `aheadBase`: The base ref `ahead` was counted against when there is no upstream; commits already on any remote-tracking branch are not counted either, so a contributor's PR checkout, whose head arrives as a fork remote branch, starts at `ahead: 0`. `null` when no such count was made (an upstream exists, light mode, detached HEAD, or no base ref found), so `ahead: 0` alone never means nothing is unpublished.
- `upstreamComparison`: Optional comparison against `upstream/<current-branch>`, with `{ remote, branch, ahead, behind }`.
- `files`: Array of file objects with `path`, `index`, `working_dir` status codes.
- `isClean`: Boolean indicating if working tree is clean.
- `diffStats`: Scope-aware per-file line stats, `{ staged, working }`. `staged` is HEAD → index (`git diff --cached --numstat -z`), `working` is index → working tree (`git diff-files -M --numstat -z`). A partially staged file appears in both maps with its own scope's counts; the two are never summed together. Untracked and working-tree-added files are counted into `working`; files added to the index are counted into `staged`.
- `mergeInProgress`: Object with `{ head, message }` if merge in progress.
- `rebaseInProgress`: Object with `{ headName, onto }` if rebase in progress.

### Branches Response
- `all`: Local branches plus locally cached remote-tracking branches. Listing performs no remote query. Explicit remote Fetch discovers new heads; without a separate prune operation, deleted remote heads remain cached.
- `current`: Current branch name.
- `branches`: Per-branch detail keyed by branch name, as reported by `git branch`.
- `defaultBranches`: Each remote's locally known default branch, keyed by remote name and read only from the local `remotes/<name>/HEAD` symbolic ref. A remote without that symref is absent rather than triggering an implicit network probe. Omitted entirely by runtimes that do not provide this Git metadata.
- `all`: Local branches plus every branch each reachable remote reports via `ls-remote --heads`, formatted as `remotes/<remote>/<branch>`. This is a union: local remote-tracking refs deleted on the remote are pruned, and branches that exist on the remote without a local tracking ref (never fetched) are still included, so a freshly pushed branch appears without requiring a fetch. A remote that fails to answer keeps its locally known branches in the list: "we could not ask" must not be reported as "these branches are gone", because callers use this list to decide whether a base branch exists at all. Each remote's answer is reused for 30 seconds while that remote's local tracking refs are unchanged (a push or fetch from here changes them and reads again), and concurrent listings share one round trip: a repository with many remotes otherwise paid every remote's network round trip on each listing.
- `current`: Current branch name.
- `branches`: Per-branch detail keyed by branch name, as reported by `git branch`. Remote-only entries in `all` — branches `ls-remote` reported that were never fetched — have **no** entry here, because `git branch` never saw them. Consumers must treat a missing detail entry as normal and read the name from `all`.
- Never-fetched remote-only branches also have no local ref, so any operation that resolves one locally has to account for that: `checkoutBranch` fetches the single branch (`git fetch <remote> <branch>`) before creating the tracking branch, and the range helpers (`getRangeDiff`, `getRangeFiles`) reject an unresolvable ref with `Ref "<ref>" is not available locally. Fetch it before comparing.` instead of surfacing git's "ambiguous argument".
- `defaultBranches`: Each remote's default branch, keyed by remote name. Read from the local `remotes/<name>/HEAD` symbolic ref; for a remote that has none — clone writes it, a hand-added remote may not — the remote itself is asked once with `ls-remote --symref`. A remote that answers neither is absent rather than guessed, and consumers fall back to conventional branch names. Omitted entirely by runtimes that do not provide this Git metadata.

### Runtime availability of range diffs
- `GET /api/git/range-diff` is served by the OpenChamber web server, so it is available to web, desktop, and mobile clients. The shared `GitAPI.getGitRangeDiff` is therefore optional: web supplies the HTTP implementation, and VS Code does not implement it because the extension host serves Git through its own bridge rather than these routes. Features built on range diffs (currently the AI diff walkthrough) are not offered in VS Code.
- Commit comparison uses the same server boundary through optional `GitAPI.getGitCommitDiff`. Desktop Changes, mobile Changes, and the existing walkthrough surface share branch/commit comparison semantics. Mobile Changes uses the same selectors and `useGitComparison` file-list owner, with a read-only list-to-detail flow. VS Code keeps its existing modes because its Git bridge does not provide these comparison operations. The HTTP operations are available to web, Electron, hosted mobile, and Capacitor clients.

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
- Patch-producing calls (`getDiff`, `getPathDiff`, `getRangeDiff`, untracked `--no-index` diffs, conflict summaries, `getCommitDiff`) pass `--no-ext-diff`, so an external diff driver configured by the repository or the session (`diff.external`, `GIT_EXTERNAL_DIFF`, difftastic) cannot replace unified patch text with the driver's own format. The UI parses patches as unified diffs; numstat and name-only queries never run external diffs and need no flag.
- `status.files` exposes both `index` and `working_dir` codes. Shared UI uses these as separate scopes: staged rows are derived from non-empty `index` statuses, while unstaged rows are derived from `working_dir` statuses and untracked files.
- `status.diffStats` follows the same scopes (`staged`, `working`), so a staged row shows HEAD → index counts and an unstaged row shows index → working-tree counts. A file with edits in both scopes reports each part in its own row instead of one combined total.
- `status.diffStats` is keyed by the exact path bytes `status.files[].path` reports. Both numstat reads run with `-z`, so Git keeps path bytes verbatim — no `core.quotepath` quoting for non-ASCII names, none for names with quotes or control characters — and a rename's old and new path arrive as their own fields, with the counts landing on the destination path, the one status reports. `core.quotepath=false` alone would cover neither the always-quoted names nor rename records, so the records are read NUL-terminated instead, the same shape `getCommitFiles` uses.
- A file with both staged and unstaged changes can appear in both UI sections. Staged rows request diffs with `staged: true`; unstaged rows request normal working-tree diffs.
- The shared Git panel exposes explicit staging actions. Unstaged rows use `stageFile`, staged rows use `unstageFile`, and commits operate on the current staged index.
- `stageFiles` remains supported for callers that need to stage a selected unstaged subset as part of commit. In that mode the server temporarily unstages unrelated index entries, stages `stageFiles`, commits from the index, then restores temporarily unstaged entries.
### Worktree Create/Remove Response
- `head`: HEAD commit SHA.
- `name`: Worktree name.
- `branch`: Local branch name.
- `path`: Absolute path to worktree directory.
- `directoryCreated`: Present when create returned after the target directory exists while background Git/bootstrap work continues.
- `bootstrapStatus`: Background setup state. The legacy `status` remains `pending`, `ready`, or `failed`, while `phase` reports `directory-created`, `git-ready`, or `setup-ready`. Fast create starts at `pending`/`directory-created`; filter-neutral population, explicit checkout hydration, and upstream Git completion advance to `pending`/`git-ready` before setup/start scripts; completed setup is `ready`/`setup-ready`. Failed states retain a stable top-level `errorCode` and bounded per-submodule/LFS `hydration` results. Durable state is authoritative. A directory with no record was never populated by this server and reads as `ready`/`setup-ready`, the same rule the OpenCode proxy's checkout gate applies; the Git panel asks this for every open repository, so treating an absent record as a repair blocker refused every ordinary one. A pending record without a matching active process, a crash mid-population, still becomes an `UNKNOWN` repair blocker, and an unreadable store fails closed the same way rather than reading as absent. A worktree whose record was lost, for example to capacity eviction, therefore reads as ready. Clients continue to accept legacy status responses that omit `phase`.
- `bootstrapStatus`: Background setup state. The legacy `status` remains `pending`, `ready`, or `failed`, while `phase` reports `directory-created`, `git-ready`, or `setup-ready`. Fast create starts at `pending`/`directory-created`; population and upstream Git completion advances to `pending`/`git-ready` before setup/start scripts; completed setup is `ready`/`setup-ready`. A missing in-memory state falls back to `ready`/`setup-ready`; clients continue to accept legacy status responses that omit `phase`.
- `sourceFetchFailed`: Present when the automatic source-branch fetch failed and creation fell back to the tracked local branch.
- Fast-create background failures remove OpenCode sandbox metadata for directories that never became Git worktrees, and remove the pre-created directory only if it is still empty. User-created files are never recursively deleted by this cleanup.
- Worktree bootstrap storage fingerprints the canonical checkout identity, so symlink and platform path aliases share one durable record. Removal resolves both the requested and canonical checkout paths, then waits for any active create/bootstrap task before listing or deleting the worktree. After the wait it removes durable bootstrap state before filesystem mutation, so storage failure leaves the checkout intact and later filesystem failure cannot leave a removed checkout recorded as ready. This also prevents aliases from bypassing the wait and stops a background Git or setup task from restoring removed state or racing filesystem cleanup.
- Worktree bootstrap retries transient `index.lock` conflicts. If the lock remains byte-for-byte and metadata-identical across the retry window, it is treated as stale, removed, and population continues automatically; changing locks are left untouched and reported as failures.
- Worktree population enables Git `core.longpaths` (local repo config plus `-c core.longpaths=true` on `git reset --hard`) so deeply nested checkouts under the managed data-dir worktree root do not fail on Windows MAX_PATH with "Filename too long". The reset disables hooks, lazy fetch, network protocols, recursive submodules, LFS smudge, and every effective executable content filter before materializing checkout files. Path-component limits that the filesystem itself rejects still fail bootstrap, with a clearer path-length guidance message.

### Log Response
- `all`: Array of commit objects with hash, date, message, author info, stats.
- `latest`: Latest commit object or null.
- `total`: Total number of commits.

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
- Managed SSH transport owns key validation and operation-local selection as described under Transport authority. Author profiles do not build SSH commands.
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
- MSYS2 Git can return `/c/repos/project` on Windows. Pass Git filesystem-path output through `normalizeGitOutputPath` before resolving it or using it with Node filesystem and process APIs. It converts drive mounts to `C:/repos/project` on Windows and preserves other paths, including POSIX paths on Linux and macOS.
- Apply this conversion to repository roots, Git metadata paths, and worktree list paths. Repository-relative filenames, diff content, and user-supplied paths keep their existing handling. Custom MSYS mount points are outside this conversion.
- On Windows, `buildGitEnv` appends `noglob` to the child process's `MSYS` options so MSYS2 passes revision arguments such as `HEAD^{commit}` and `branch@{upstream}` literally. Other options and the parent environment remain unchanged. Both simple-git and direct Git commands use this environment.
- Git for Windows' `cmd\git.exe` is a launcher that starts the real `mingw64\bin\git.exe`, so each call shows as a pair of processes (each with a hidden conhost). Keep spawning the launcher: calling the mingw binary directly drops `usr/bin` from `PATH` and breaks ssh and hooks, and needs validation on Windows before anyone tries it.
- simple-git commands get the same inherited editor, pager, askpass, SSH-command and Git-config variables as direct Git commands (see `createGit`). Matching of these names is case-insensitive. Only the project overlay from Settings leaves them out.

### Error Handling
- All exported functions should throw errors with descriptive messages.
- Use `console.error` for logging Git operation failures.
- Return structured objects for operations that need partial success reporting (e.g., merge/rebase conflicts).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Consider edge cases: non-Git directories, missing remotes, conflict states, concurrent worktree operations.
