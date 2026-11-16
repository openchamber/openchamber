# Runtime API contract

## Ownership

`types.ts` owns the wire and in-process contract every runtime surface implements: `RuntimeAPIs` plus the Git, files, terminal, settings, notifications, source-control, tracking, push, client-auth and skills types. Web, desktop, the VS Code extension and the Capacitor shells supply these operations; the shared UI in `packages/ui` consumes them and never talks to a server directly. Behaviour behind a member belongs to the runtime that implements it: the server routes, the VS Code bridge, the Electron main process. Git identity profiles live in `git-identity.ts`, filesystem error classification in `files-errors.ts`, and the reasons a Git path has no diff in `git-path-diff.ts`. Source-control and tracker item shapes are re-exported from their own modules rather than redefined here.

## Invariants

- A runtime without an operation omits the member, and every caller treats absent as unsupported. Optional members are capabilities, not a fallback path: Git diff batches, content search, worktree setup, managed SSH inventory, transport bindings and trackers are each absent on at least one shipped surface.
- A failed read throws. An authoritative empty answer is the only kind of empty answer, so a fetch failure never becomes an empty list (for example `SourceControlAPI.providers` throws rather than answering `[]`).
- A batch isolates its items. `getGitDiffs` returns one entry per path and `referencesAcross` reports a folder it could not read in `repositories`; one failed item never removes or blocks the others.
- List payloads stay small: a reference list body is cut at 20 000 characters and its detail carries the whole body, a preview detail carries the newest 50 comments, a cross-repository search reads up to 100 repositories, and list statuses cover up to 30 change requests.
- A display URL is redacted. `GitRemote.fetchUrl` and `pushUrl`, and every `GitNetworkRedactedEndpoint`, never contain HTTP userinfo, query data or fragments, so no transport credential reaches the UI.
- A private ref carries the data needed to restore the work it names: `refs/openchamber/runs/<group>/<session>` and `refs/openchamber/archive/<id>`.
- `GitStatus.aheadBase` is set only when the branch has no upstream and `ahead` counts commits missing from that base ref and from every remote branch. Absent or null means no such count was made, so `ahead: 0` alone never proves nothing is lost.
- In `GitStatus.diffStats`, a file edited in both scopes appears in both maps, and the two maps are never summed into one another.
- A `revision` in a working-tree range listing changes exactly when that file's patch can change. It is a cache key, not a content hash.
- An identity profile with no `transport` predates the field and means system Git; read it through `identityTransport`.
- Identity profile IDs are unique within the profile list.
- A file-search match's `column` is 1-based and counted in UTF-16 code units; its `ranges` are `[start, end)` offsets inside the returned `text`, which is cut to what a result row shows.
- A notification carries the `runtimeKey` of the instance that owns its session so a click is routed to that instance, not to whichever one is active.
- Push text sealed with `ApnsTokenPayload.pushKey` is opened on the device: the relay, Apple and Google never see a notification's title or body.
- A Git identity's transport is separate from the provider account used for issues and change requests. A repository can fetch over SSH and still answer to a provider account.
- Removing a transport binding removes only that one committed remote grant; Git configuration and credentials are unchanged.
- `addChangeIdToHead` amends HEAD with a Change-Id trailer computed the way the review host's commit-msg hook does it, and refuses when HEAD is no longer the expected commit or already carries one.

## Decisions

### Why runtimes omit a member and not answer a sentinel

A sentinel would have to mean both "unsupported" and "empty" in every caller, and the two callers that need to tell them apart are exactly the ones that break. Omitting the member makes the capability question a type question, and the UI hides the feature instead of showing an action that fails.

### Why `getGitBranches` needs the caller to name `remote: 'local'`

`remote: 'live'` asks each remote over the network and can start an SSH sign-in, so only an explicit request from the person may pass it. A server older than this contract treats a missing mode as live, which is why callers name the mode instead of relying on a default.

### Why a submodule carries recorded commits and not just its patch

A submodule that only gained untracked files is modified in status while its patch is empty. The entry records HEAD, index and worktree commits, and flags tracked, untracked and conflicting changes, with `worktreeCommit` null while the submodule is not checked out. A conflicting index has no single recorded commit, which is what `hasConflict` says.

### Why range diffs use three-dot `base...head`

`base...head` diffs against the merge base, so changes pulled into `head` by merging `base` are excluded. `includeWorkingTree` then compares that merge base with the checked-out files, staged, unstaged and untracked included. Two-dot would show other people's merged work as this branch's change.

### Why a push for review sends its intent and the server composes the refspec

The review host's push refspec depends on the target branch and the host's options, so `GitPushReviewIntent` carries the branch, topic, flags and hashtags and the server turns them into `refs/for/<target>`. Topic and hashtags take letters, digits, dots, dashes and underscores only.

### Why a clone takes `providerAccount` beside the transport credential

The account for issues and change requests is independent of the credential that fetches, so a repository cloned over SSH can still act as a provider account.

### Why content search says where its text starts

A match line is returned without indentation and may be cut at the front, so `text` can begin after the line's start; `cutStart` tells the row to show an ellipsis, and the offsets are relative to the returned text, not the file line.

### Why the pairing payload keeps its candidates structurally typed

The candidates match `PairingEndpointCandidate` in `@/lib/connectionPayload`, but that module is a leaf with no imports of its own and is kept that way. This contract does not depend on it: the field stays `Record<string, unknown>`, and the consumer validates the candidate shape at its own boundary.

### Why the desktop supplies the LAN URL when it creates a pairing link

The desktop UI reaches its server over loopback, so loopback is not a reachable direct candidate for a phone. `serverUrl` advertises the externally reachable address, and the server adds a relay candidate when its relay host is enabled. Leaving `includeRelay` out keeps the older rule, relay only when already enabled; `includeDirect: false` produces a relay-only link.

### Why resetting a relay identity leaves paired devices behind

Devices paired through the relay keep reaching the previous copy until they are paired again here. The reset gives this server its own identity; it does not migrate the pairings.

### Why worktree setup can return before it is ready

`returnAfterDirectoryCreated` lets a caller start work once the directory exists, while Git setup and hydration finish in the background and report through `bootstrapStatus`. A project `createCommand` is the exception: the request waits for it even in that mode.

### Why a worktree archive survives a failed restore

A restore that clashes with the branch leaves Git's conflict state in place and keeps the archive, so the work can be reconciled and restored again instead of being lost. Deleting an archive deletes its local branch only when no checkout uses it.

### Why an identity written before transports counts as complete

Such an identity is a signature that pushes with the machine's own Git, and System Git needs no credential. Completion therefore requires a user name and email and, per transport, an account for `account`, a managed key for `ssh`, and nothing for `system` or `anonymous`.

### Why the VS Code bridge rejects with a plain object

Browser code sees an `Error`, while the VS Code bridge rejects with an object that only carries a message. `isFileMissingError` reads both, plus a `FilesystemError` whose reason is `not-found`, and falls back to the message text.

### Why a path from an earlier status listing can have no diff

The path may no longer exist anywhere Git looks, may be a separate repository nested in this one, or may be an untracked directory the listing kept as one `dir/` entry. `GitPathUnavailableReason` names exactly those three, and the diff routes send the reason in the body of a 404 or 422.
