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
  - `system-push-acknowledgement-storage.js`: strict bounded persistence for system-transport push acknowledgement by repository, exact push remote, exact push endpoint fingerprint, and private transport revision.
  - `contributor-provenance-storage.js`: strict bounded persistence for contributor-fork worktree identity and push-safety authority.
  - `credential-resolver.js` and `credential-broker.js`: resolve opaque managed credential references and provide one-operation Git authentication without returning secrets to clients.
  - `redaction.js`: bounded Git output and error redaction.

## Public API

The following functions are exported and used by the web server:

### Repository Operations
- `isGitRepository(directory)`: Check if a directory is a Git repository.
- `getGlobalIdentity()`: Get global Git user.name and user.email.
- `getCurrentIdentity(directory)`: Get local Git identity (fallback to global if not set locally).
- `hasLocalIdentity(directory)`: Check that both repository-local `user.name` and `user.email` are configured.
- `setLocalIdentity(directory, profile)`: Set repository-local `user.name` and `user.email`. Explicit SSH commit signing also sets `gpg.format`, `user.signingkey`, and `commit.gpgsign` when `signCommits` is true and `signingKey` is non-empty. Other signing settings remain unchanged.
- `getRemoteUrl(directory, remoteName)`: Get URL for a specific remote.
- `resolveRepositoryGitPaths(directory)`: Resolve the absolute Git directory, shared common directory, and bare-repository state without collapsing linked worktrees into separate repositories.
- `getRepositoryRemoteUrls(directory)`: Read fetch and push URLs through Git for worktree and bare repositories. Source-control callers must redact these values before returning them to clients.

Author-profile application never sets or unsets `core.sshCommand` or `credential.helper`. This includes legacy SSH/token/HTTPS fields. Applying the `global` profile is `clearLocalIdentity(directory)`: it unsets repository-local `user.name`, `user.email`, `user.signingkey`, `commit.gpgsign`, and `gpg.format` so the repository falls back to the person's own Git configuration, which OpenChamber reads but never writes. It succeeds on a machine that has no author of its own — "no override applies here" is true either way — and answers with the author it found, or with `profile: null`. Legacy `authType`, `sshKey`, and `host` values may remain in private profile records for migration, but profile routes reject those fields in client input and strip them from every response. Public edits merge into the private record so retained migration data is neither deleted nor accepted back from a client. VS Code `setGitIdentity` enforces the same author-and-signing boundary through both its Git extension API and raw-Git fallback. Web, Electron, hosted mobile, and Capacitor mobile use the server implementation.

An identity is one repository's complete answer: signature, provider account (`account: { provider, instance, accountId }`), and transport (`account`, `ssh` with `sshCredentialId`, or `anonymous`). A client cannot write an identity without an account or with the `system` transport; records written before identities carried an account are still read (absent transport means `system`) but no repository can choose them. Connecting an account creates its identity on the spot, named after the login and qualified by provider or host when that name is already taken — one person with the same username on GitHub and GitLab gets `ada` and `ada (GitLab)`, not `ada 2`. Connecting again after disconnecting reuses the identity that already carries that person's signature on that instance rather than minting a second one (GitHub without a public address gets its own no-reply address); accounts connected earlier are backfilled once, on the first identities read after startup rather than at route registration, so a slow or locked auth store cannot delay server start. The public profile DTO contains only `id`, `name`, `userName`, `userEmail`, `account`, `transport`, `sshCredentialId`, `signCommits`, `signingKey`, `color`, and `icon`. Renderer Git summary routes expose only author name/email, and remote routes expose redacted display URLs. Raw `core.sshCommand` values and remote credentials, query parameters, and fragments remain server-internal.

### Status and Diff Operations
- `getStatus(directory)`: Get comprehensive Git status including current branch, tracking, ahead/behind, file changes, diff stats, merge/rebase state.
- `getDiff(directory, { path, staged, contextLines })`: Get diff output for files or entire working tree with full Git blob identities. Untracked symbolic links are represented as link entries without following their targets.
- `getRangeDiff(directory, { base, head, path, contextLines, includeWorkingTree })`: Compare the merge base of the exact selected refs with `head`. With `includeWorkingTree: true`, compare with the checked-out branch's current files instead, including committed, staged, unstaged, and untracked work in one net diff. This mode rejects a head that is not the checked-out branch. Exposed as `GET /api/git/range-diff`; omit `path` for the whole comparison.
- `getRangeFiles(directory, { base, head, includeWorkingTree })`: List changed paths using the same comparison as `getRangeDiff`. A successful empty list means the final files match the merge base, even if staging and working-tree changes cancel each other out.
- Both range operations honor refs literally. A local `main` is never replaced with `origin/main`, and an unavailable ref fails rather than choosing a different remote. The UI picker sends qualified refs to distinguish local and remote branches with matching display names.
- Working-tree comparisons use the real index read-only. When untracked paths exist, a temporary copy of the index receives intent-to-add entries so Git computes additions, deletions, recreations, and renames together. Current contents come from the working tree, symlinks remain links, ignored files stay excluded, and temporary files are removed on success or failure.
- `getFileDiff(directory, { path, staged })`: Get original and modified file contents for a single file (handles images as data URLs and symbolic links as their link-target text).
- `listUntrackedPaths(directory)`: List individual untracked file paths honoring ignore rules. Much cheaper than `getStatus` when that is all a caller needs. Deliberately not `--directory`: collapsed directory entries end in a slash and are rejected by the per-file diff helpers, so a caller would silently lose every file inside a new directory.
- `getUntrackedDiffs(directory, filePaths, { concurrency, contextLines })`: Diffs for untracked files against an empty tree. Resolves the repository context once instead of per file (`getDiff` re-resolves every call, costing an extra `rev-parse` each time) and bounds how many diff processes run at once. Returns one entry per input path in order; unreadable paths yield `''` rather than failing the batch.
- `collectDiffs(directory, files)`: Collect diff output for multiple files.
- `revertFile(directory, filePath, options)`: Revert a file. Default scope `all` discards staged and working-tree changes; scope `working` discards only unstaged/working-tree changes.
- `stageFile(directory, filePath)`: Add one file path to the index.
- `unstageFile(directory, filePath)`: Remove one file path from the index while preserving working-tree content.
- `applyHunk(directory, filePath, options)`: Apply a single-hunk patch via `git apply`. `options.action` is `stage` (`git apply --cached`), `unstage` (`git apply --cached --reverse`), or `discard` (`git apply --reverse` in the working tree). Inside the index mutation queue, the server verifies that the complete patch exactly matches one current three-context-line hunk for that file and scope, then runs `--check` before applying. Applicability alone cannot prove an unstaged change: old staged or committed hunks can reverse cleanly too. Stale, historical and multi-file patches fail with a refresh error. Temporary patch files are removed on success and failure; hunk content retains CRLF bytes.

### Branch Operations
- `getBranchBase(directory, branch)`: Read a named creation source from reflog. After a rebase, the creation source is no longer a current parent record, so return `null` and let the user choose a base. Explicit per-runtime, directory, and branch choices in the shared UI outrank detection.
- `getBranches(directory)`: Get local branches and locally cached remote-tracking branches without contacting remotes.
- Commit integration is local-only: it may fast-forward to an existing local upstream ref, but never fetches implicitly. Refresh remote-tracking refs through an explicit planned Fetch operation before integration when current remote state is required.
- Ordinary worktree validation, creation, and upstream setup are local-only. Remote branches must already exist as local remote-tracking refs from an explicit planned fetch. Contributor worktrees retain their dedicated managed transfer and checkout-hydration operations.
- `getUnpushedBranchCounts(directory, branchNames)`: Count commits ahead of each locally known upstream for up to five supplied local branches. This reads local refs only and omits branches without an upstream.
- `createBranch(directory, branchName, options)`: Create and checkout a new branch.
- `checkoutBranch(directory, branchName)`: Checkout an existing branch. A remote-tracking name (`origin/main`, or the `remotes/`-prefixed form) resolves to the local branch of that name, created with `--track` when it does not exist yet, because the branch selector offers remote branches as places to work rather than commits to inspect — a literal checkout of the remote ref would detach HEAD. A local branch whose own name looks like a remote ref wins over that resolution, and anything unresolvable is checked out as requested. The returned `branch` is the branch that was actually checked out, which callers should report instead of the requested name.
- `deleteBranch(directory, branch, options)`: Delete a branch (supports force flag).
- `renameBranch(directory, oldName, newName)`: Rename a branch and preserve upstream tracking.
- `getRemotes(directory)`: Get list of configured remotes.

### Worktree Operations
- `getWorktrees(directory)`: List all git worktrees for a repository. A directory outside any repository (or one that does not exist) is an authoritative empty list; any other git failure throws so callers keep their last known topology instead of clearing it. `GET /api/git/worktrees` answers such a failure with 500.
- `observeWorktreeTopology(directory)`: Compare the repository's registered linked-worktree set with the last one seen for it and notify `subscribeWorktreeTopologyChanges` listeners when it changed. The set is fingerprinted from the `worktrees` directory under the common Git directory (mtime plus entry names), so the check is a stat and a readdir; the common directory is resolved with `git rev-parse --git-common-dir` once per requested directory and cached. The first observation only records a baseline. Never throws.
- `subscribeWorktreeTopologyChanges(listener)`: Listener receives `{ directories, at }`, where `directories` are every directory of that repository the server has observed, so clients can map them onto registered projects. Returns an unsubscribe function.
- `validateWorktreeCreate(directory, input)`: Validate worktree creation parameters (mode, branchName, startRef, upstream config).
- `createWorktree(directory, input)`: Create a new worktree (supports 'new' and 'existing' modes, upstream setup). Population never runs repository hooks or executable content filters. Contributor-fork worktrees also skip stored project setup and request setup commands during creation; they remain Git-ready and require a later exact-checkout digest-bound trust operation before executable checkout content may run. A trusted hook runs only from an operation-private mode-`0700` directory as a verified mode-`0500` content snapshot. The executor never reopens the repository hook pathname after approval, preserves `GIT_DIR`, `GIT_WORK_TREE`, arguments, and working directory in the trust digest, and removes the snapshot under a fresh bounded cleanup deadline even after cancellation.
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
a clear error before a worktree is kept. PR worktree requests also carry the
provider's exact head revision; validation and creation reject a local or
remote branch that does not resolve to that revision. A new local PR branch is
created from that immutable revision rather than the mutable remote-tracking ref,
and creation verifies the attached worktree HEAD before bootstrap, removing the
worktree and any branch created by that attempt on mismatch. Failed creation removes
a remote added by that attempt. An existing remote is reused only when its endpoint
is byte-for-byte equal; a different endpoint returns `CONTRIBUTOR_REMOTE_COLLISION`
and no `remote set-url` command runs. OpenChamber
serializes worktree remote provisioning per repository and remote name so concurrent
creation attempts cannot overwrite each other's rollback. If upstream fetch fails during
bootstrap, tracking is left unset rather than writing `branch.*.remote` /
`branch.*.merge` for a ref that was never fetched. Contributor-fork creation always leaves tracking unset.

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

Push, fetch, pull, remote-branch deletion, and sync accept only full refs. Sources are `refs/heads/*` or `refs/tags/*`; push destinations are heads or tags, deletion destinations are heads, fetch destinations are remote refs, heads, or tags, and pull destinations are heads. Sync narrows its fetch destination to `refs/remotes/*`, names its checked-out pull destination, and requires that destination to equal the exact push source. Planning accepts authoritative HTTPS, `ssh://`, and strict SCP endpoints only. URL endpoints with userinfo, query, or fragment data fail before plan registration or Git argv construction. Planning validates the repository ID, binding and config revisions, remote, redacted endpoint fingerprint and display URL, transport mode, and opaque credential reference against source-control authority before resolving refs. Execution repeats authority validation before any subprocess or credential resolution and again immediately before each transfer Git process starts. It also compares a server-internal transport revision derived from effective system, global, local, worktree, and included Git configuration. The revision covers credential helpers and URL-scoped credential settings, SSH commands, URL rewrites, HTTP settings, and remote proxies. Values and origin paths never enter public plans or errors.

Push resolves and stores the source commit SHA while planning, rechecks it during both execution authority passes, and sends exactly `<pinned-sha>:<destination-ref>`. New-branch publication can request local upstream configuration; only after push success does the executor write the exact branch remote and merge ref, and a local configuration failure returns `partial`. An optional force lease is exactly `--force-with-lease=<destination-ref>:<expected-remote-sha>`. Remote deletion sends exactly `:<destination-ref>` and has the same acknowledgement and uncertain-outcome rules as push. Fetch sends exactly `<source-ref>:<destination-ref>` with `--no-tags`. Pull pins the checked-out full HEAD ref and its commit SHA during planning, rechecks both before authentication, before fetch, and before merge, fetches to `refs/openchamber/network/<operationId>`, merges the fetched SHA with `--no-edit --no-verify`, then deletes the temporary ref. Remote names select authority; Git receives only the server-resolved raw endpoint.

Sync is one server-owned execution and one absolute deadline. Its immutable plan has separate fetch and push remote targets, endpoint metadata, transport modes, credentials, source refs, and destination refs. Planning rejects a detached HEAD, a missing target, or a pull destination that differs from the push source. It never reads upstream configuration, chooses `origin`, or chooses the first remote. Execution fetches the exact fetch refspec, merges that fetched commit into the pinned checked-out branch, then resolves and pins the resulting local commit immediately before sending the exact push refspec. It revalidates fetch authority before fetch and push authority before push, so a successful local integration followed by stale or failed push authority remains visible rather than switching targets.

Managed HTTPS strips ambient AskPass, SSH, uppercase and lowercase proxy variables, Git/Curl trace destinations, TLS overrides, injected Git-config variables, and custom CA/client-certificate environment variables. It disables system Git config and points global Git config at the platform null file. Before issuing a broker lease, it enumerates effective repository-local `http.*` and `credential.*` keys, including local includes, then revalidates repository authority. Command-local config clears every discovered auth-bearing key by its exact name, clears generic and exact-endpoint transport settings, disables hooks and redirects, enforces TLS verification, and installs the operation helper as the sole credential helper. Git's standard trust store remains available. The helper makes one `POST http://127.0.0.1:<ephemeral-port>/credential` request with `x-openchamber-git-nonce: <32-byte-base64url-nonce>` and `x-openchamber-git-operation: get`. The loopback broker permits one use before expiry and returns credentials only when the normalized protocol, host, port, and repository path match the lease. An LFS lease also answers for the repository path that git-lfs derives by stripping `/info/lfs` from the endpoint, because git-lfs requests credentials for that repository URL rather than for the LFS endpoint; custom LFS endpoints without that suffix keep exact matching.

Managed SSH records live separately in mode-`0600` `git-ssh-credentials.json` under `OPENCHAMBER_DATA_DIR`. A record contains only an ID, absolute private-key path, and SHA-256 fingerprint. Credential resolution realpaths the selected key, opens it with `O_NOFOLLOW`, copies bytes from that handle to the exclusive operation-owned `git-ssh-operation-keys/<operationId>.key`, sets mode `0600`, derives its public key without a passphrase, and verifies the stored fingerprint. Existing version-1 records remain readable, including operator-provisioned records outside the managed key directory. Git invokes `ssh-wrapper.js`; the key path stays in `OPENCHAMBER_GIT_SSH_KEY`, not the command string. The wrapper uses `-F none`, `IdentityFile=none`, the one verified key, `IdentitiesOnly=yes`, `IdentityAgent=none`, batch mode, and strict host-key checking. It retains the system known-hosts files but has no SSH config, agent, interactive prompt, or alternate-key fallback.

`credentials.js` owns managed SSH inventory and onboarding through `GitAPI.managedSshCredentials` and `POST /api/git/managed-ssh-credentials`. Explicit `inventory` reads at most 256 store records under a ten-second verification budget. It verifies each actual private key through the same private snapshot verifier as execution, cleans the snapshot, and returns only an opaque credential reference, the safe `SSH` label, stored public fingerprint, and ready/unavailable capability. Missing keys, encrypted or unverifiable keys, and fingerprint mismatches have distinct safe reason codes; one unavailable key does not hide healthy records. Store, inspection infrastructure, deadline, and cleanup failures fail the request rather than returning authoritative empty inventory. Responses use `Cache-Control: no-store`.

Explicit `discover` inspects only immediate entries in the server-approved root, configured by server composition as the server user's `~/.ssh`. It reads at most 128 entries, never recurses, rejects the root and entries when they are symbolic links, and does not parse SSH config, certificates, public-key files, known-hosts files, environment paths, or agent state. Candidate files must be regular, at most 128 KiB, contain a private-key marker, and on POSIX grant no group or other permissions. The operation opens each source with `O_NOFOLLOW`, snapshots bytes from that handle, derives the public key from the actual unencrypted private key, and fingerprints that public key. Encrypted and permissive likely keys may appear with a safe unavailable reason; unreadable likely filenames may appear without a fingerprint; other unreadable or non-key files are omitted. The public result contains only a safe basename label and, for ready candidates, a random opaque ID plus public fingerprint. It never contains a host path or key content.

Ready candidates live only in the server process. The registry holds at most 256 candidates, expires each after five minutes, and may evict the oldest candidate to remain bounded. Restarting the server, expiry, or eviction invalidates the ID. `import` accepts only the opaque candidate ID, its exact expected fingerprint, and literal `confirmed: true`. It reopens and re-realpaths the same immediate file, requires the original file identity and timestamps, snapshots and derives the fingerprint again, and rejects changed, expired, unavailable, or mismatched candidates without writing the store. Concurrent reuse of one candidate is rejected.

A successful import exclusively copies the verified operation snapshot to a random operation-owned filename under mode-`0700` `OPENCHAMBER_DATA_DIR/git-ssh-private-keys`, sets the file to mode `0600`, and appends an opaque version-1 record through the store's cross-process file lock. The new record contains only the managed copy path, never the original host path. A failed pre-commit store append removes the owned copy; cleanup failure fails the request. If the atomic store replacement commits but lock cleanup fails, import retains the copy so the committed record stays valid and fails the request for operator recovery. Import returns the verified resulting inventory and selected credential, but does not bind a provider, repository, remote, or author profile. Existing records remain compatible. Configure trusted known-hosts records separately; this flow does not alter known-host verification. Passphrase-protected or agent-only keys require explicit unverified System transport, and managed execution never falls back to it.

After credential resolution, managed HTTPS snapshots expose actor metadata as `{ kind: "provider", provider, instance, accountId, login? }`; `accountId` is the stable provider-user ID, never the opaque credential ID, and `login` is omitted when unavailable. Managed SSH exposes `{ kind: "ssh-key", fingerprint }`. System transport has no verified actor and reports `{ status: "unverified", reason: "system-credentials" }` because it inherits the server process's Git and SSH environment.

System push and remote-deletion planning require durable acknowledgement for the current repository ID, exact push remote name, exact push endpoint fingerprint, and private effective transport revision. Sync uses its push target for all four fields; its fetch target grants no push acknowledgement authority. The strict bounded version-3 `git-system-push-acknowledgements.json` store lives under `OPENCHAMBER_DATA_DIR`, uses locked atomic mode-`0600` writes, stores no raw endpoint, and rejects any other version without replacing the file. A first request without `acknowledgeSystemTransport: true` fails with `ACKNOWLEDGEMENT_REQUIRED`; shared UI asks for explicit confirmation and retries only the same immutable authority with the acknowledgement field. A successful acknowledgement is persisted before the plan is registered. Changing the selected push remote, push endpoint fingerprint, or relevant effective Git configuration requires acknowledgement again. Version 1 records keyed by the old public config revision and version 2 records lacking remote and endpoint scope grant no authority. The next explicit acknowledgement safely replaces either legacy snapshot with version 3. Managed push and deletion reject the field, and fetch, pull, and clone do not accept it. Configuration query and store failures fail planning closed.

The raw endpoint is an internal transport value. It never appears in public plans or results. Provider account bindings, Git transport credentials, and commit identities remain separate. In particular, `gitIdentityId` configures repository-local `user.name` and `user.email`; it is not a transport credential.

### Remote Fetch

Everyday Fetch uses `operation: 'fetch', fetchScope: 'remote'` with the selected remote, repository/binding/config revisions, endpoint metadata, and transport mode. It accepts no caller-supplied refs, refspecs, force flag, or command options. The shared helper selects this mode before checking current branch or upstream. Detached HEAD, unpublished branches, and remotes unrelated to tracking need no branch picker. A remote needs its own transport grant, not a provider account.

The runtime reads effective `remote.<selected-name>.fetch` values through a bounded, NUL-delimited local config query. It supports exactly one `refs/heads/*:refs/remotes/<selected-name>/*` mapping, optionally prefixed with `+`. Missing, empty, duplicate, negative, single-branch, tag, mirror, and custom-destination mappings fail explicitly. The public target records `fetchScope: 'remote'` and the resolved boolean `force`; the configured refspec stays internal. Planning pins the mapping. Execution rereads it before credentials and immediately before transfer alongside the existing endpoint, revision, and credential checks.

Remote Fetch sends the pinned mapping to the authoritative endpoint with `--atomic --no-tags --no-prune --no-prune-tags --no-recurse-submodules --refmap=`. It refreshes advertised heads into only the selected remote's tracking namespace, including new branches and configured forced updates. It does not prune deleted branches, auto-follow tags, recurse into submodules, integrate commits, or configure upstream. Atomicity covers ref updates; existing lifecycle errors, cancellation, cleanup, and terminal metadata remain in force. Menu rendering and branch listing start no transfer. Planning validates local state only; execution starts the remote transfer after the user selects Fetch.

Exact-ref Fetch also accepts `fetchScope: 'ref'`. Existing callers that omit the field retain the shipped exact-ref schema and must provide both full refs. Pull, contributor transfers, and Sync retain their existing behavior. Remote Fetch audit targets add only the scope and resolved force boolean to the selected remote name and endpoint fingerprint; they contain no raw URL or configured refspec. Existing version-1 audit records remain readable.

### Clone

Clone is the one parent raw-endpoint input boundary because a new checkout has no repository binding. It accepts HTTPS URLs, SSH URLs, and SCP-style SSH endpoints only. It rejects other protocols, local paths, remote helpers, option-shaped values, control characters, URL query/fragment data, HTTPS userinfo, passwords, and unsafe path components. Planning resolves one absolute destination and an operation-owned sibling temporary directory; both must be absent. Optional auxiliary grants contain only a kind, redacted endpoint metadata, transport mode, and endpoint-specific credential ID. They never contain the discovered raw endpoint.

Every clone intent chooses `transportMode` explicitly. System requires `unverifiedConfirmed: true`, and managed HTTPS requires an independently selected `credentialAccount` with provider, instance, and exact credential ID. The planner checks the account instance against the approved HTTPS endpoint, reads that exact valid persisted credential without active-account or CLI fallback, and constructs a host-owned `ocgit:v2` reference pinned to its immutable ID and revision. Reauthentication or replacement cannot retarget the plan or the binding created after checkout. Managed SSH requires a selected existing host `sshCredentialId`, validated against the managed inventory and an SSH endpoint before planning. It rejects provider accounts; HTTPS, anonymous and System requests reject SSH references. Execution derives the actual key fingerprint again. Parent `credentialId`, tokens, and key paths are not accepted from clients. Provider associations and author profiles never choose clone transport. Anonymous HTTPS clone selects only `transportMode: 'anonymous'`, with no account or System confirmation. The same exact-endpoint callback persists the chosen grant at revision 1, and binding failure retains the completed checkout as partial.

Git clones with `--no-checkout`, hooks disabled, and `GIT_LFS_SKIP_SMUDGE=1` into the temporary directory. The shared UI requires transport selection before planning and sends no operation on cancellation before planning. Closing during planning cancels the returned plan before execution; closing during execution requests cancellation of that operation ID. The older filesystem route remains an explicitly confirmed System compatibility adapter. A selected commit identity is validated before plan registration or spawn, then applied as repository-local `user.name` and `user.email` in that checkout. The host resolves a global author independently of managed transport's isolated Git configuration. The operation performs a filter-disabled forced checkout, attempts bounded submodule and LFS hydration, and then claims the absent destination with an exclusive `mkdir` and copies checkout entries with no-replace operations. Successful or unnecessary hydration returns success. Incomplete non-cancelled hydration publishes the checked-out repository as `partial` so setup can be repaired in place. This is not an atomic rename or atomic publication. Before each publication filesystem mutation it checks cancellation and the operation deadline, then waits for that mutation to settle and records any new ownership before returning a timeout or cancellation result. Directory ownership identifies a pathname by device and inode, plus creation time where the filesystem keeps a real one. The operation establishes that by changing each directory it creates once on purpose and checking that the reported creation time sits still; Node otherwise fills that field from the change time, which every clone moves as it writes its own checkout. Where creation time holds, a directory removed and recreated in place is detected even though Linux reuses the inode number. Where it does not, ownership falls back to device and inode rather than failing every clone. Cleanup mutations run after terminal intent and are also awaited to settlement.

After publication, `bindClonedRepository` resolves the new repository and compares both actual `origin` fetch and push endpoints with the captured approved endpoint, including fingerprints. Only an exact match permits a revision-zero CAS creating binding revision 1 with the selected System grant or exact managed credential reference. The binding also retains only auxiliary grants that matched an endpoint and kind actually discovered during this hydration attempt; unused client grants are discarded. Provider associations remain empty and local authorship stays separate. Persistence is awaited to settlement. Endpoint verification or binding persistence failure returns `partial` with `checked-out`, a redacted finish-setup message, and the completed destination retained. Later cleanup failure also returns partial when checkout is complete. The shared parser rejects partial clone results without `checked-out`; the dialog registers the retained project and opens Git setup with warning feedback, not clone success or full failure. Retry uses setup on that checkout, never another clone into its existing destination. Temporary cleanup still runs, and incomplete publication retains the operation-owned cleanup rules below.

Clone publication creates every directory, file, and symlink exclusively and records each node's identity and content metadata immediately. On failure, cleanup atomically renames the destination root into a fresh same-parent operation-private quarantine before inspection. It recursively deletes only the quarantined tree when the root, complete entry set, identities, and file or link contents match the operation's records. A changed or replacement tree is restored only by an atomic rename from quarantine. If the original path is occupied or rename fails, cleanup leaves the complete tree in quarantine and returns a redacted `UNKNOWN` cleanup failure. Temporary checkout cleanup uses the same rename-first rule and deletes only a quarantined root with the operation-owned identity. No recursive deletion targets the original destination or temporary pathname.

### Anonymous reads

`anonymous` is a distinct credential-free HTTPS read mode for fetch, pull, and clone. Push, remote-branch deletion, and a sync with an anonymous push target fail before plan registration or transfer. A sync may use an anonymous fetch target only with a separately authorized non-anonymous push target. Anonymous requests reject credential references, credential accounts, and System acknowledgements. SSH is unsupported, including public-key or agent fallback.

Anonymous execution uses managed HTTPS environment and exact-key local HTTP sanitation, but never calls the credential resolver or starts a broker. It disables credential helpers, AskPass, cookies, delegation, automatic client certificates, redirects, recursive fetches, and non-HTTPS protocols. An isolated home and removal of `NETRC` prevent Curl from finding host credentials outside Git config. TLS verification stays enabled in production. Repository URL rewrites return `RUNTIME_UNSUPPORTED` rather than redirecting the approved endpoint. On Git/Curl builds that reject an empty client-certificate reset, an existing local client-certificate setting can still make the read fail; there is no retry with ambient authentication.

Public transport is `{ mode: 'anonymous', verification: { status: 'anonymous' } }`, with no actor. Audit transport is `{ kind: 'anonymous' }` and has no provider account. Auxiliary endpoints still need independent exact grants, even on the same host. An exact anonymous auxiliary grant may fetch only an HTTPS submodule or LFS endpoint under the same credential-free environment isolation; it never starts the credential resolver or broker. Missing grants remain authorization-required. Explicit managed auxiliary grants cannot replace the parent's anonymous metadata.

The loopback HTTPS canary exercises real clone, fetch, pull and an authentication challenge with test-only self-signed TLS acceptance. It checks local included headers, cookies, helpers, AskPass, netrc, proxy and client-certificate isolation. These tests do not establish native Windows or packaged-runtime behavior.

### Checkout hydration

The operation executor reads `.gitmodules` from the selected commit with `git config --blob --null` and pairs it with mode-`160000` entries from `git ls-tree`. Relative URLs resolve against the exact parent fetch endpoint that produced the checkout. Worktree hydration carries that source from the fetch itself; it never infers one from provider bindings, upstream configuration, `origin`, or remote order. If no exact source can be proved, hydration returns `AUTHENTICATION_REQUIRED` before starting a child process. The executor never invokes `git submodule update`, recursive update, or repository-defined update commands. Children initialize sequentially with `clone --no-checkout`, hooks and LFS smudge disabled, and a forced detached checkout of the exact gitlink. Each child HEAD must equal that gitlink before success is recorded or recursion starts. Recursion, paths, modules, command output, pointer samples, and public results have hard limits.

`checkout-hydration` is an existing-repository planned operation. Planning pins repository ID, binding and config revisions, exact parent remote and endpoint fingerprint, HEAD, and the bounded transfers found through local inspection. Existing exact submodule checkouts are inspected recursively but do not become transfer requirements. The server resolves each transfer-capable endpoint's auxiliary grant during planning and pins only grants that validate against the discovered raw endpoint; missing grants remain authorization failures and a grant added after planning cannot retarget the operation. Planning starts no network process. Execution repeats repository, inspection, and exact auxiliary-grant checks before transfer. Public plans and results contain only repository-relative paths and redacted endpoint metadata. Process-local operation recovery stores the operation ID, but restart reconciliation never executes or resumes hydration automatically.

Each submodule endpoint needs an exact auxiliary grant, including same-host paths. Cross-host children never receive the parent credential. The executor resolves every credential by the child endpoint's own opaque ID, checks the discovered endpoint against the grant before credential resolution and again before spawn, and redacts raw endpoints, paths, credentials, and process errors. One child failure does not erase completed siblings. Cancellation between children prevents later children from starting. Every existing component of a submodule checkout path must be a real directory; symbolic links fail before auxiliary authorization or transfer. After authorization, the executor checks the path components again and creates missing parent directories one level at a time before it creates the child checkout. Repair accepts an already-present child only when its HEAD exactly equals the committed gitlink, then inspects it recursively without another clone. A child directory created by the current failed transfer is quarantined and removed only when its filesystem identity still matches the operation's record.

LFS discovery combines effective attributes, bounded object batches, committed `.lfsconfig`, effective remote LFS URLs, and executable filter and transfer configuration. It queries attributes and object metadata in batches of at most 128 paths, then reads only pointer-sized blobs through `cat-file --batch`. A complete ordinary repository is not rejected merely for exceeding 256 or 1,024 files. Listing, query-output, pointer-byte, and public-result limits remain enforced. Incomplete or malformed discovery fails closed, never as `not-needed`. Custom transfer agents and non-canonical executable LFS filters fail before LFS execution. The effective HTTPS LFS endpoint gets its own exact auxiliary grant, including for an SSH Git checkout. Hydration runs explicit `git lfs fetch <selected-parent-remote> HEAD` and `git lfs checkout` under registry process ownership. A required missing client returns `GIT_LFS_CLIENT_MISSING` with `client-missing` instead of a generic clone failure.

Local worktree hydration first inspects local content. Git-route and OpenChamber-session creation both use the server's one durable bootstrap store and always invoke this inspection, including for repositories without a source-control binding. A checkout needing neither submodule nor LFS transfer requires no parent remote; required hydration without an exact source persists path-specific authorization data rather than choosing `origin` or reporting setup ready. Its operation-private durable marker carries no fabricated repository or remote authority and cannot complete a retained-checkout repair blocker. Managed pull and sync integration use a credential-free local execution context with network protocols, lazy fetching, hooks, content filters, fsmonitor, autostash, and recursive submodule operations disabled. Required post-integration hydration uses explicit grants; failure preserves the completed local update and skips sync publication.

### Managed LFS publication

Before managed Git ref publication, the executor scans objects reachable from the pinned source commit, including historical pointers but excluding unrelated refs. Required LFS objects upload through `git lfs push --object-id openchamber-lfs <selected-oids>` in an operation-private bare repository. The HTTPS LFS endpoint is resolved independently from pinned committed configuration, effective LFS settings, and the exact selected Git push endpoint. It needs its own ready managed auxiliary grant and credential; an SSH parent key is never reused for HTTPS LFS.

Source, configuration, and grant authority are revalidated before upload. Missing client or grant blocks Git ref transfer. Cancellation and timeout retain the existing operation deadline, process ownership, credential cleanup, and private-directory cleanup. Parent Git credentials are acquired after LFS preparation to avoid expiring their lease during a long upload. LFS upload success followed by Git push failure is not operation success and reports the already-uploaded objects. Sync retains completed integration as a partial result when publication preparation fails.

The upload path supports managed HTTPS Git and SSH Git with a separately configured HTTPS LFS endpoint. Pure SSH LFS, System auxiliary upload, and anonymous LFS are unsupported. Live git-lfs authentication and server-returned upload URL/redirect behavior require the real-client integration fixture; fake child responses do not establish those guarantees.

Public hydration results contain one bounded record per discovered submodule and repository LFS scope. Statuses are `succeeded`, `authorization-required`, `invalid`, `client-missing`, `failed`, `cancelled`, or `not-needed`. Records contain only repository-relative paths, redacted endpoint metadata, and stable errors. Successful auxiliary credential resolution and child transfer advance the same durable operation steps as other network operations; a checkout that needs no transfer records neither `authenticated` nor `transferred`. A non-cancelled clone hydration failure publishes and binds the checked-out repository as `partial`; repair never reclones it. Worktree bootstrap receives hydration through an injected operation-owned callback, so `service.js` starts no hydration network process. It advances to `git-ready` only after hydration succeeds and retains the stable top-level error code plus bounded hydration result on failure. A later successful `checkout-hydration` operation atomically updates only a retained hydration-owned failure to `ready`/`setup-ready`; unrelated bootstrap failures remain unchanged.

### Results and cancellation

Operation states are `planned`, `running`, `succeeded`, `partial`, `conflicted`, `failed`, `cancelled`, and `outcome-unknown`. Completed steps may include `validated`, `authenticated`, `transferred`, `updated-local-repository`, `checked-out`, and `cleaned-up`. Every terminal sync snapshot also returns ordered `fetch`, `pull`, and `push` step results. Each step is exactly `succeeded`, `skipped`, `conflicted`, `failed`, or `cancelled`; failed or interrupted steps include a redacted structured error, and unstarted downstream steps are `skipped`. Fetch success followed by push failure is `partial`. A pull conflict is `conflicted` and skips push. Cancellation between steps marks the next step `cancelled` and skips later work. If cancellation interrupts a spawned push, the push step is `cancelled` while the operation is `outcome-unknown`, because remote acceptance cannot be proved.

Planning and execution each use one absolute five-minute deadline by default; the deadline does not reset between authority, credential, filesystem, fetch, and integration phases or between child processes. The legacy `cloneRepository` adapter starts one deadline before identity validation and carries it through planning and execution. Duplicate execute requests join the first process-local promise and its deadline.

Cancellation before execution becomes terminal without spawning. Cancellation and timeout terminate the attached process tree, with forced escalation after one second by default. Fetch and clone interruption return `cancelled` with `CANCELLED` or `TIMEOUT`. Once push transfer starts, interruption returns `outcome-unknown` because the remote may have accepted the update. Pull interruption during merge returns `conflicted` when `MERGE_HEAD` remains, otherwise `outcome-unknown` because the local result cannot be proved. Terminal cancellation returns the existing snapshot.

The service revokes broker leases and managed credential snapshots on terminal paths. A successful operation becomes `failed` if required credential or temporary-ref cleanup fails. Pull temporary-ref deletion gets a fresh bounded five-second cleanup deadline, even when the operation deadline expired or cancellation was requested; no other Git command bypasses cancellation.

### Audit trail

The web server writes one logical source-control audit record for each Git network operation and approved checkout-action execution through `source-control-audit.json`, separate from the process-local operation registry and provider mutation replay storage. The service registers an operation in memory, persists its audit record before returning the plan, and cancels the unexposed operation if audit persistence fails. An operation-ID collision fails before audit planning and does not alter the existing audit record. Execution marks the record running and writes the compact terminal result after the registry settles; duplicate execute calls join one audited execution. Cancelling an unstarted plan records cancellation without spawning.

Git audit targets copy only operation names, remote names, endpoint fingerprints, full refs, and clone destination display metadata from the immutable public plan. Checkout hydration instead records a bounded kind-plus-endpoint-fingerprint target for each discovered transfer-capable requirement and no parent remote. Its transport reference contains only the matching server-validated auxiliary grants, one exact managed credential reference, System marker, or anonymous marker per kind and endpoint. Missing grants have no transport entry, and hydration that needs no transfer records `null` transport. Hydration never attributes the parent credential or a single provider account to its independent child transfers. Audit records omit endpoint display URLs as well as internal directories, repository-relative hydration paths, temporary paths, pinned SHAs, process output, hydration payloads, and error messages. A managed single-path operation stores its exact opaque `credentialId`; a system operation stores `system-credentials`. Sync stores separate fetch and push entries so mixed transport and distinct managed credentials remain visible. The schema permits credential reference strings only, never resolved usernames, passwords, tokens, SSH key paths, or other credential payloads. Managed HTTPS operations derive provider account identity from the separately encoded provider-user ID only when the strict reference parser proves it. They never publish the opaque credential ID as provider identity; legacy v2 references without provider-user attribution, SSH, unresolved, differing sync authority, and checkout hydration record `null`. Approved local checkout actions use `local-checkout-actions`, register through the audited path, and contain no remote. Runtime and repository identity come from the immutable plan, and clone uses a `null` repository ID because no repository exists during planning. Current managed entrypoints always record `user` as initiator and `openchamber-server-git` as executor.

### Legacy route gate

`POST /api/git/push`, `POST /api/git/pull`, `POST /api/git/fetch`, and `DELETE /api/git/remote-branches` are fail-closed compatibility routes. They always return `409 GIT_NETWORK_OPERATION_REQUIRED`; a missing binding or tombstone never restores ambient System Git execution. First-party network actions use the planned operation API.

Contributor-fork provenance is stored under `OPENCHAMBER_DATA_DIR`, keyed by the common-repository identity plus the linked worktree Git-directory filesystem identity. The strict bounded store uses atomic mode-`0600` writes and compare-and-swap revisions; malformed, insecure, or unreadable state fails closed. Creation persists provenance before reporting success and removes the attached worktree if that write fails. Worktree listing resolves all listed identities against one bounded authoritative store snapshot instead of reparsing the store once per worktree. Public worktree reads expose only `{ kind, revision, trust, push }`, never paths, source SHAs, or raw endpoints.

Legacy push, pull, fetch, and remote-branch deletion reject contributor worktrees before Git execution. System-credential contributor transfer is also rejected by managed planning. Contributor publish entrypoints first ask the server whether the worktree has contributor provenance. A contributor that is behind runs an exact managed pull against its tracked source, then opens the destination chooser and creates the push selection from the post-merge state; a push-only contributor opens the chooser immediately. Push requires a one-use, 15-minute server-issued destination selection that pins linked-worktree/provenance identity, repository/binding/config revisions, current source SHA, remote endpoint fingerprint, and destination ref. Every current managed remote is eligible, including the contributor fork itself when its push endpoint has an exact managed binding. The server classifies candidates as contributor fork, own fork, bound repository, or other only from provenance, provider binding, and exact account authority; remote names alone do not establish ownership.

### Runtime parity

Existing repositories configure parent and auxiliary transport in the Git panel through `GitAPI.configureTransportBinding` and `GitAPI.configureAuxiliaryBinding`. The source-control binding service owns their exact repository/revision/fingerprint validation and narrow record updates, documented in [Repository binding routes](../source-control/DOCUMENTATION.md#repository-binding-routes). Explicit System setup, anonymous HTTPS, selected-account managed HTTPS, and selected-existing-key managed SSH use the server in web, Electron, hosted mobile, and Capacitor mobile. Setup performs no transfer and never derives a credential grant from provider selection. The managed SSH inventory also provides a source-control read projection that verifies the exact key record and returns only its public fingerprint, never its record ID or private path. These server-backed runtimes expose explicit inventory, bounded host discovery, and confirmed import; none run automatically. VS Code omits this capability entirely: its webview projects repository remotes as a ready System-transport binding and offers no transport configuration.

Web, Electron, hosted mobile, and Capacitor mobile use the connected OpenChamber server and its runtime identity. The identity is `{ id: "server_<uuid>", platform: "web" | "desktop" }`; clients do not choose it, and the durable store accepts no other platform. Electron does not start a renderer-owned Git process. System credentials belong to the connected server host, which may differ from the client device.

VS Code runs existing-repository network operations as plain Git commands on the extension host with the user's own Git credentials. The webview maps the shared operation lifecycle onto the standard `api:git/push`, `api:git/pull`, `api:git/fetch` and `api:git/remote-branches` bridge messages and keeps operation snapshots in webview memory; nothing is audited or persisted. Managed transport, contributor destination selection, clone, checkout hydration, and auxiliary grant configuration are unsupported there. See `packages/vscode/src/DOCUMENTATION.md`.

### Log Operations
- `getLog(directory, options)`: Get commit history with stats (supports maxCount, from, to, file filters).
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

## Git the agent runs itself

Planned operations own every transfer OpenChamber starts, and they run with a
scrubbed environment so no ambient credential can reach them. A `git push` the
agent types in its own shell is a different process: it inherits the person's
environment, their global config and their credential helpers, so a bound
repository would still transfer as whoever the machine happens to hold.

Two modules close that, both scoped to the OpenCode process OpenChamber itself
starts. Neither writes anything to a repository and neither persists anything.

- `agent-operations.js` gives the agent `git.push`, `git.pull` and `git.fetch`
  through the managed OpenChamber tool. They build the same planned operation
  the Git panel builds. Anything needing a person's decision — no binding, a
  stale or unready grant, several bound remotes with none named, a detached
  HEAD, a branch with no upstream, a push over an anonymous transport — is
  refused with what to do instead.
- `agent-credential-runtime.js` answers Git itself. It puts command-scope
  `credential.<origin>.helper` entries into the managed child's environment —
  an empty value to sever the inherited chain, then `agent-credential-helper.js`
  — for the HTTPS origins the bindings name. Command scope outranks every
  configuration file, which is what lets a binding override the machine's
  default, and the process boundary is what keeps the person's own terminal
  untouched.

The helper reports the working directory it was invoked from, and Git runs a
credential helper from the repository root, so the answer is per repository:
a managed grant answers with its account, a System Git grant is handed back to
the person's own chain with this helper removed from it, and anything else
answers nothing at all — which is the point, because nothing is what stops an
unbound repository from silently borrowing an ambient identity.

Nothing is injected while no binding names an HTTPS host, and the set is read
when the child starts: the shared UI records a pending OpenCode restart when a
remote first receives an HTTPS credential grant. The bearer token lives only in
that child's environment and dies with the process. `/api/git/agent-credential` and
`/api/git/shell-boundary` are exempt from the UI session guard because they
carry that token and refuse any peer that is not loopback: the helper has no UI session and cannot obtain
one, so the guard would make bindings silently unenforceable wherever a UI
password is set, which Docker requires.

`shell-boundary-runtime.js` closes the last gap. The credential answer already
decides which identity a transfer uses, but it cannot reach `gh`, `glab` or an
SSH remote, and an agent that hits an authentication error has no idea what to
do next. The plugin's `tool.execute.before` hook asks OpenChamber about any
shell command that mentions Git, and a repository that is configured in
OpenChamber refuses with the managed action to use instead. A repository nobody
configured is left alone, because there is nowhere to send the agent. The hook
can only deny — it is not an approval prompt — and anything that goes wrong in
it allows the command, since a guard that fails closed on its own plumbing
would strand an agent that has done nothing wrong.

Both are switched off in two places. `agentGitAuthorityEnabled` is a machine
fact in the settings registry — `instance` scope, so a phone cannot flip how
Git behaves on a workstation — and `OPENCHAMBER_GIT_AGENT_AUTHORITY=off` pins
it for whoever starts the process. With it off nothing is put into the child's
environment at all. `agent-authority-storage.js` then holds the per-repository
answer, and stores only exclusions: when the machine-wide answer is no there is
nothing for a single repository to turn back on, so the per-repository control
can only be an opt-out, and it lives in the repository dialog alone — adding or
cloning a repository asks nothing, because the default is the answer. An
excluded repository is answered the same way a
System Git one is — handed back to the person's own chain, because the host's
chain is severed for the whole process and answering nothing would leave it
with no credential at all.

`shell-boundary.js` decides what counts as a transfer. It names the
subcommands it blocks, which is the opposite of the UI's
`shellOperationBoundary`: that one labels a call that already ran, where a
missed label is the worse mistake, so it treats anything it does not recognise
as crossing. Blocking has to err the other way, because a refusal that guesses
stops ordinary work.

## Internal Helpers

The following functions are internal helpers used by exported functions:
- `buildGitEnv()`: Build Git environment with SSH_AUTH_SOCK resolution.
- `createGit(directory)`: Create simple-git instance with environment.
- `normalizeDirectoryPath(value)`: Normalize directory paths (supports ~ expansion).
- `cleanBranchName(branch)`: Remove refs/heads/ or refs/ prefixes.
- `parseWorktreePorcelain(raw)`: Parse `git worktree list --porcelain` output.
- `resolveWorktreeProjectContext(directory)`: Resolve project context (projectID, primaryWorktree, worktreeRoot).
- `resolveCandidateDirectory(...)`: Generate unique worktree directory candidates.
- `resolveBranchForExistingMode(...)`: Resolve branch for existing-mode worktree creation.
- `applyUpstreamConfiguration(...)`: Set upstream tracking for new branches.
- `buildWorktreePopulateCommand(directory)`: Inspect effective content-filter keys and construct the filter-neutral, hook-neutral, no-network reset command used for initial population.
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
- `all`: Local branches plus locally cached remote-tracking branches. Listing performs no remote query. Explicit remote Fetch discovers new heads; without a separate prune operation, deleted remote heads remain cached.
- `current`: Current branch name.
- `branches`: Per-branch detail keyed by branch name, as reported by `git branch`.
- `defaultBranches`: Each remote's locally known default branch, keyed by remote name and read only from the local `remotes/<name>/HEAD` symbolic ref. A remote without that symref is absent rather than triggering an implicit network probe. Omitted entirely by runtimes that do not provide this Git metadata.
- `all`: Local branches plus every branch each reachable remote reports via `ls-remote --heads`, formatted as `remotes/<remote>/<branch>`. This is a union: local remote-tracking refs deleted on the remote are pruned, and branches that exist on the remote without a local tracking ref (never fetched) are still included, so a freshly pushed branch appears without requiring a fetch. A remote that fails to answer keeps its locally known branches in the list: "we could not ask" must not be reported as "these branches are gone", because callers use this list to decide whether a base branch exists at all.
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
- Windows Git commands use MSYS/MinGW paths; avoid direct Windows paths in git commands.

### Error Handling
- All exported functions should throw errors with descriptive messages.
- Use `console.error` for logging Git operation failures.
- Return structured objects for operations that need partial success reporting (e.g., merge/rebase conflicts).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Consider edge cases: non-Git directories, missing remotes, conflict states, concurrent worktree operations.
