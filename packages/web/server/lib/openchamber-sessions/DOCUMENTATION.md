# OpenChamber sessions

## Ownership

This module owns server-side session creation, dispatch, forking, archive and metadata persistence, linked-item operations, task naming, and moves into worktrees. The control service consumes these operations. The UI owns its direct OpenCode fork repairs and linked-item display shapes; Git owns worktree creation, bootstrap, and removal. Server operations preserve the same selection, project-folder, archive-restore, and naming contracts as their UI counterparts.

## Invariants

- The OpenCode session record is authoritative for metadata and archive state after migration. A pending legacy entry overrides that record in reads and proxy responses until migration succeeds. Archive entries distinguish a timestamp, an explicit unarchive represented by `null`, and an absent entry represented by `undefined`.
- Archive-file mutations, persistence, and rollback form one serialized transaction. Serializing only disk writes lets an older rollback erase a later committed batch from memory and from the next snapshot. Temporary files share the destination directory so rename exposes a complete snapshot atomically.
- Archive writes remain disabled until the file is known. A missing file permits writes; a failed read preserves memory and permits a later retry. Loading merges into memory so changes made during loading survive. Malformed archive and metadata files are moved aside for recovery.
- Archive migration and user archive operations share a per-session queue. Migration reads the entry inside its turn so an older archive cannot overwrite a newer restore. Unknown sessions lose their legacy entries; failed pushes retain them for a later migration.
- Archive batches bound request work and return per-session partial results. Callers split larger sets into batches. `archiveState` preserves an unknown read result for callers that might wake a session; the display-oriented `archivedAt` falls back to active on read failure.
- Restoring an archived top-level session discovers archived descendants across every directory and uses OpenChamber lineage as well as OpenCode parentage. Moved parents can leave children in another worktree. Parents precede children, and repeated pagination cursors terminate the walk.
- A send reads the archived tree before restoring its root and yields to a newer archive or restore. Restore failure after prompt acceptance is logged without failing the accepted send.
- Metadata read, merge, decision, and write are serialized per session; unrelated sessions proceed independently. A failed authoritative read never becomes empty metadata and never permits a write over unseen fields. A session OpenCode does not know reads as empty metadata but cannot receive a metadata write.
- Legacy metadata loading must succeed before writes or migration. An unread file can hold newer state than OpenCode, and loading it after a write can overwrite newer state. Cancelling one reader cancels its wait and SDK read without cancelling the shared file load.
- Legacy metadata rewrites are serialized so an older snapshot cannot land last. Successfully migrated entries leave memory and the legacy file; an empty file is retained with a `.migrated` suffix for recovery. Failed pushes remain pending, except entries for unknown sessions.
- Failure to rewrite the legacy metadata file does not fail an already successful OpenCode write. The stale disk entry can be pushed again after restart until a later successful rewrite clears it.
- Metadata broadcasts contain the full merged record so clients that missed a patch can recover. Injected writers own persistence, broadcast, and goal-loop notification; local fallbacks perform persistence and broadcast without duplicating the injected writer's work.
- Linked-item requests contain operations against the record at write time. Accepting a client-computed `linked_issues` snapshot can erase a concurrent agent link even with serialized writes. Identity validation preserves unrelated metadata, untouched entries, and UI-owned extra fields such as author, avatar, guest payload, and thread.
- Stored link identity prefers the id even when the stored number is unusable. Older repository links can match by kind, number, and normalized address. UI re-link operations remove matching identities and append the refreshed entry; agent re-links preserve the original time, position, and fields the agent cannot know.
- Link URLs determine service and thread kind because an agent-supplied kind can be wrong. Native GitHub issue and pull entries exist only for github.com; discussions remain external entries that every UI can retain. Provider thread patterns canonicalize tab and query URLs so repeated links name one thread.
- Tracker matching follows registry order. A tracker that fails to load leaves its links usable as external entries. Unlinking accepts canonical thread URLs and case-insensitive identifiers; an ambiguous identifier removes nothing and requests a URL. `#N` identifies GitHub entries, while GitLab merge requests use `!N`.
- Explicit agent and model validation precedes session, worktree, and goal side effects. An empty catalogue is not authoritative absence and cannot reject an otherwise valid explicit choice. A new session's defaults require directory-scoped inputs to become ready within their deadline.
- Catalogue id wins over upstream `modelID` regardless of catalogue order so a base reference cannot select a derived entry accidentally. Saved upstream names remain accepted. Hidden-model keys and selection objects use catalogue ids, including the selection object's `modelID` field.
- Selection precedence matches the composer. A named agent's model binding outranks defaults; an existing session retains its selection when dispatch supplies no replacement. Project defaults outrank global defaults, and legacy agent display names still resolve to agent ids.
- A nonempty catalogue skips configured models it no longer offers. An empty catalogue preserves configured models and saved variants. Hidden models are skipped for remembered and fallback picks, while explicit configured defaults stay valid; an all-hidden catalogue still supplies a fallback model.
- Variant resolution uses the agent pin and matching project or global model defaults before remembered effort and Default. Unsupported known variants are ignored, and a failed remembered-settings lookup cannot invalidate a valid model-only dispatch. Settings keep variant fields separate; OpenCode config uses its canonical parser and last-definition-wins precedence.
- Auto must resolve before either the goal or session selection reaches OpenCode because SDK dispatch bypasses proxy interception. An unavailable or unanswerable routing check skips a remembered Auto pick without refusing an otherwise valid request.
- Prompt delivery compares idle record ids so a remote clock skew cannot invalidate completion matching. No idle record is `null`; unreadable history is `undefined`. Prompt attribution retains the source session id even when its title cannot be read.
- Server-dispatched sessions receive standing project context here because no UI writes it. Context synchronization failure does not prevent dispatch. Fork repair precedes dispatch so a newly armed goal can replace the copied objective.
- Forks clear source-owned side-thread and review links and scheduled-run ownership. An active inherited goal is paused so the fork cannot pursue the source goal concurrently. File-backed objectives need a fork-specific copy, with inline text as the fallback; repair failures are logged because the fork already exists and remains usable.
- Explicit Chats remain projectless even inside a checkout. Other operations resolve the longest containing registered project within the same checkout, then the corresponding folder in the primary checkout, then the create-request lookup, then the directory itself. A registered path merely enclosing a linked checkout does not make that checkout its project. Checkout comparisons preserve project-path spelling because Git resolves symlinks.
- A worktree session starts in the corresponding project subfolder where OpenCode config lives. Git operations still use the checkout root. A missing folder, unavailable Git prefix, or unverifiable containment falls back to the root with a reported reason; an absent prefix never means a known root.
- New worktrees receive the registered project's merged setup through the bootstrap pipeline. Server-side setup resolution accounts for untrusted shared commands because no UI can ask for consent. Directories outside registered projects receive no setup. Contributor worktrees require the provider pipeline, whose head, fork, and remote cannot be contradicted by caller start refs or upstream choices.
- Session creation waits for checkout population and directory-scoped selection readiness. Git and setup have separate deadlines because dependency installation can exceed the Git deadline. Their combined wait stays below the request timeout; a setup deadline returns not-ready without dispatching work. A failed prompt after session creation keeps that session's folder.
- A move carries only explicitly named files because neither Git nor OpenCode's whole-worktree diff identifies which concurrent actor owns an edit. The session moves last. Stashes are applied by commit hash because concurrent pushes change stash indices; stash-list evidence detects whether changes were saved regardless of Git's output language.
- A setup timeout stops a move before stashing because ongoing setup could overwrite the only remaining copy of carried changes. The worktree and source session stay in place. Only an identical session, source checkout, and worktree input reuses that pending worktree, after verifying it still belongs to the repository; pending retries live only in memory.
- Move rollback removes only worktrees and branches created by that attempt. A retained retry target and pre-existing local branch survive. Removal requests cancellation of setup; carried changes return to the source, and a failed restoration leaves a stash named in the error. A failed stash-list read after stashing also reports how to locate the saved changes.
- Task names belong to worktree branch descriptions and never rename sessions. User-owned names win. Moving a session seeds the new worktree name from its current title, preserving explicit user ownership, because the new branch has no description and agents need not name the same task twice.
- Turn durations use OpenCode event timestamps and retain the first busy event through repeated busy steps. Only fully observed top-level turns are recorded, with subsession activity represented by the parent. Restart or event-stream reconnect discards starts because an end may have been missed; `endedAt` matches OpenCode's idle timestamp so readers can identify the turn.
- Archive rollback reads occupied entries and archived-tree traversal reads a nonempty parent queue. Their occupancy checks expose invariant failures without asserting away missing values.

## Decisions

### Why a server-side unread baseline and not marking all old turns unread

The server and VS Code extension share the data directory's `sessions-unread.json` baseline because earlier clients record no viewed watermark. Proxy responses treat turns ending by that baseline as viewed without writing OpenCode; an unreadable existing baseline stays unchanged because replacing it would silently mark newer turns seen. A save failure leaves the process using its in-memory baseline and permits another attempt on restart.

### Why require branch naming in the task-name call and not a prose reminder

An unpushed OpenChamber placeholder branch requires a branch name in the same call because agents can otherwise name the task and omit renaming the branch. User branches, pushed branches, and main-checkout branches remain untouched, and responses explicitly distinguish a kept branch from a successful rename.

### Why retain Linear's legacy kind and not store every tracker as tracker

Linear entries retain `kind: 'linear'` with the provider alongside it while the `/api/linear` alias supports older bundled clients. Those clients discard unknown kinds when writing their lists back, which would erase Linear links stored as `tracker`; readers accept both forms.

### Why measure turn durations on the server and not in the page

The unread duration remains visible after a page closes. The server's continuous event stream observes turns that no open page can measure, and stores their duration in session metadata.

### Why batch archive requests and not send one per session

Removing a busy worktree archives many sessions before removal. Bounded batches avoid the cumulative request latency of archiving each session separately while preserving individual failures.

### Why resolve fetch per call and not capture it when creating the client

Client fetch resolves `globalThis.fetch` at request time so runtime replacements and injected test implementations take effect for existing clients. Calls without a directory header can use OpenCode's default instance for session-id lookups.

### Why the local SDK contract accepts unchecked metadata and an absent signal

OpenCode 2.3.0 forwards `requestOptions?.signal` to fetch and serializes request
bodies with `JSON.stringify`. Its published types exclude explicit
`signal: undefined` and non-JSON metadata values that this module already passes.
`opencode-client-contract.d.ts` describes those inputs locally; the factory's
overload preserves the SDK implementation and every other client operation.
Tests exercise both inputs through the real SDK and record the fetch arguments.

Metadata uses the loose object's inferred type because its object guard does
not recursively validate values. A merge can retain a `Map`. Legacy JSON
container validation preserves the original parsed object, including session
ids such as `__proto__` that a parser's cloned output could omit. Recursive
merges narrow the previous field only after checking the incoming field, so
scalar replacements do not read inherited getters.

### Why archive batching shares a value iterator

The shared iterator yields each indexed value without asserting array
occupancy. It keeps the existing sparse-array calls, result indices and
concurrency limit. The archive predicate retains its number check for upstream
and injected values, including the previous acceptance of non-finite numbers.

### Why route inputs retain unchecked fields

HTTP bodies and merged settings expose optional unknown fields until the existing
checks narrow them. Optional-property predicates preserve primitive property
reads and inherited fields without claiming validated values. Null send and fork
bodies retain their property-access failure. Metadata and link schemas retain
their loose inferred values, including non-JSON fields.

Catalogue agent names and ids retain their string checks because catalogue
responses and injected clients can omit them. Array checks remain on catalogue
lists, variants, settings projects, hidden models and archive ids. Remembered
effort lookup retains inherited values so the existing enum parser rejects them.

`session-goal/create.js` declares its unchecked creation fields explicitly.
Its null budget default does not establish a null-only input or a validated
numeric return. Session routes validate the budget before calling it; the goal
helper still forwards unchecked input to its persistence callback.

### Why route occupancy checks preserve existing failures

Store construction requires a data directory only when an injected store is
absent. Reusing a session selection requires the existing session id. A null
routing result and a null agent list retain their property-access errors rather
than becoming successful empty selections. These checks expose impossible
internal states without casts or non-null assertions.

The SDK persists agent and model selection on sessions, so both switch calls
precede dispatch. Forks omit `before` when copying the whole session. Worktree
bootstrap opens OpenCode's checkout gate at `git-ready` while setup may continue.
Goal objectives use the typed prompt because command templates are unavailable;
their synthetic reminder follows the user prompt. A returned inbox item id is
required to confirm prompt delivery.

### Why stored unlink candidates keep their loose schema type

Stored unlink candidates use the inferred `storedLinkSchema` type, whose URL,
kind and number may be missing. The shared matcher accepts this partial identity
as well as HTTP entries and preserves unknown snapshot fields. Matching ids
require no URL. Number-based repository matching still throws a `TypeError`
when the candidate has no URL; the explicit undefined guard preserves the
previous property-access error and its message without promising a validated URL.

### Why preserve property guards for external values

File contents, event payloads and thrown values remain untrusted. Timestamp
guards retain the positive safe-integer rule. Property-presence guards box
primitives before checking inherited properties, preserving optional property
reads without claiming an unchecked record shape. OpenCode fork metadata keeps
its loose schema's inferred fields and checks goal objects before reading status.
Directory headers use the client's percent encoding for non-ASCII paths.
