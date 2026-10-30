# UI Stores

## Purpose

`packages/ui/src/stores` contains app-level Zustand stores for persistent UI state, runtime state, and feature caches.

Not all state in the UI belongs here.

Use a store when state is:

- shared across distant parts of the app
- needed outside a single component subtree
- cache-like and keyed by runtime identity (for example directory, branch, session id)
- updated imperatively from multiple surfaces

Do not put high-frequency local component state here just because it is convenient.

## Architecture

Session destination registration is owned by `sync/session-admission.ts`.
`useProjectsStore.adoptSessionProject` appends only a server-confirmed project,
or adds a VS Code workspace folder after fingerprint trust has succeeded. It
never activates a project or replaces the registry from a partial response.
The server serializes this append with settings saves. A failed request leaves
the list and current navigation unchanged. VS Code workspace-list updates with
an unchanged active project do not reset the selected directory.

A confirmed append also joins the current projects array to the existing
debounced settings mutation queue. This replaces an older pending manual-add
snapshot and records newer intent before an in-flight settings response can
reconcile. The resulting write preserves both manual and automatic additions
without changing the active-project pointer.

There are multiple store categories in this directory.

### Catalog refresh

`catalogRefresh.ts` re-reads the lists Settings and the composer show — agents,
commands, skills, MCP servers, plugins, providers — when OpenCode reports that
it rebuilt a catalog. The sync layer calls it from `reloadCatalog`; see
`packages/ui/src/sync/DOCUMENTATION.md` for the kind-to-list table. There is no
pending-restart queue: config mutations take effect as soon as OpenCode has
re-read the file, and only the OpenCode binary path restarts the server.

The agents store counts load generations: `invalidateAgentsLoadCache` starts a
new one, and a load never joins a read that began in an older generation. It
waits for that read and reads again, so a refresh after a delete cannot be
answered by the read the delete itself started.

Agent refreshes keep the ambient project and each location that raised the
catalog event in the same batch. Settings can show a different project from the
app, so refreshing only the ambient cache leaves its list stale. Invalidating a
directory retires the Settings store, the composer store and the shared client
request for that key. Their older responses cannot restore a pre-change list or
stamp a fresh TTL over the replacement request. A runtime switch clears the
directory maps and rejects loads captured from the previous runtime.

A same-runtime load retired by a catalog change waits for the replacement list before it returns. A create or delete waiting for that read therefore keeps its successful result; the retired response itself publishes nothing. A runtime switch still returns failure instead of joining work for another runtime.

Plugin catalogs carry `loadedDirectory` and `loadedRuntimeKey`, the owner of
the installed list. The editor waits for that directory's catalog before hydrating a draft;
plugin IDs alone are not unique across projects. Catalog requests and their
TTL caches are scoped by runtime and directory. A response for a superseded
owner cannot replace the catalog or finish the current owner's loading state.

### Feature cache / query stores

`useFileSearchStore` keeps OpenCode's indexed file results first. Non-default
hidden/gitignore options also request `RuntimeAPIs.files.search` and append
unique paths up to the caller's limit. Directory searches remain indexed.
Both sources share the existing runtime/directory/query/options cache key.
An indexed-search failure rejects. A supplemental failure logs a warning and
returns the indexed hits without caching the partial answer, so the next search
can retry the supplement.

The Stats page keeps its reports in a feature-local store, `components/views/usage/usageStatsStore.ts`: keyed by runtime, range and project, in memory only, never refetched on its own once a key has a report, cleared on runtime switch. A failed refresh keeps the cached report. The report is requested with `tools: "none"`; tool calls, which make OpenCode scan every tool call in the range, load on request under the same key, over the loaded report's own window. Once the user asks for them, every report shown later in the app session fetches its tool calls after it lands. A failed tool read shows an error with retry and never reads as zero calls.

PR status reads share the aggregate background-network budget as well as their PR-specific cap. Command discovery gates each scope/config read, including body decoding, rather than only gating the initial SDK list. Command reads have a bounded deadline and abort on runtime reset. Reset clears server-derived command caches and invalidates late reads and mutation responses while preserving unsaved command drafts.

These are the most performance-sensitive.

- `useGitStore.ts`
- `useGitHubPrStatusStore.ts`
- `useWalkthroughStore.ts`
- `useFilesViewTabsStore.ts`

These stores act like centralized keyed caches. UI should consume narrow slices from them instead of re-fetching the same data in multiple places.

`useQuotaStore` keeps the last authoritative provider results separately from
`refreshErrors`. Transport failures and configured-provider errors preserve the
last usage sample and its timestamp. An explicit unconfigured response replaces
old configuration; a first-load transport failure leaves it unknown. Concurrent
refreshes share one request per provider, except after a provider-account switch,
which passes `invalidate` to ask again rather than join a request that still
describes the account being switched away from. Runtime reset aborts those
requests, and generation checks prevent their completions from changing the next
runtime.

`invalidate` also decides what happens to the last sample when a refresh fails.
A periodic refresh keeps the previous numbers, because that sample belongs to
the same account and a blip should not blank a surface showing real data. A
refresh after a switch does not: the sample is the account just left, so keeping
it would show one account's usage as the new account's, which reads as the
credential never changing. The entry is replaced by the new account's failure.

A switch is picked up from OpenCode's event stream rather than from the screen
that made it, so `catalogRefreshTasks("credential")` re-reads the selected
trackers when a credential changes. That is what covers a switch made in
OpenCode's own TUI or by another client, which no OpenChamber screen can see.
Only the trackers the store already shows are re-read. That is gated on the
results the store holds, not on the instance-level load flag, because runtimes
differ in how they load: the VS Code layout fetches quotas on open and never
calls `ensureLoadedForRuntime`, so `loadedRuntimeKey` stays null there and
gating on it skipped every refresh in the extension. With nothing fetched there
is nothing on screen to update, and the un-loaded provider list is every tracker
rather than the user's selection.
`lib/quota/fetchQuota.ts` validates response payloads and bounds the complete
request, including JSON body delivery. Compact usage cards and Settings display
refresh errors alongside retained data. The mobile popover makes at most one
refresh attempt per opening, so a failed first load cannot create a retry loop.

`useSmallModelStore` answers one question: can OpenChamber's background model
(the Small Model) run right now? `GET /api/small-model` says `available: false`
on, for instance, a fresh install on OpenCode's free tier, where chat works but
a stateless generation has nothing to run on. Session renaming, the session goal
and the walkthrough depend on it, so their entry points read the store through
`hooks/useSmallModelAvailability` and show a disabled control with the reason
instead of failing after the click. Cached per runtime + directory for a
minute, refetched only while the control that asks is open; a config change
(provider login, settings save) or a runtime switch drops every answer. A failed
or malformed fetch keeps the previous answer: an unreachable server is not
evidence that the model went away. Callers with a graceful fallback (a note kept
verbatim, a reply spoken in full) do not consult it; they silence the 404 on
`requestSmallModel` instead.

### UI state stores

Absolute context-panel file targets retain filename edge spaces, including in path-derived tab deduplication keys. Trimming a resolved target would open or reuse a different file; relative text inputs still receive the existing whitespace cleanup.

`useFilesViewTabsStore` also preserves whitespace in file and folder targets through selection, close, move, and expansion. These inputs come from resolved filesystem paths; only workspace-root inputs receive whitespace cleanup.

Sidebar visibility and its persisted width are independent. Opening or closing
the sidebar never writes a width; only resizing changes the saved choice.
The initial width is separate from the component's minimum resize width.

`useCommitSelectionStore.ts` shares the selected commit between desktop/mobile
Changes and walkthrough. Choices are session-only and keyed by runtime, directory, and
checked-out branch, with at most 100 remembered choices. The picker history
belongs to `useCommitComparison`, loads only while Commit mode is active, and
is limited to the latest 50 commits. History failure stays distinct from an
empty list; stale directory/runtime requests cannot replace current history or
selection. A refreshed list preserves an explicit selection even when newer
commits have pushed it beyond the latest 50.

`hooks/useGitComparison.ts` owns the local file-list state used by desktop and
mobile comparisons. Its key contains runtime, directory, and the complete
branch/commit/PR source. A source change hides the old list immediately; failed
reads remain errors, and manual retries cannot publish into a superseded scope.
The hook also resolves per-file patch requests, including a commit rename's
previous path. Views own their lazy patch caches through `useRangeKeyedCache`.
Mobile requests only the active detail path and suspends reads while its
keep-alive workspace pane is hidden.

`usePullRequestSelectionStore.ts` shares session-only PR choices across desktop,
mobile Changes and walkthrough, keyed by runtime, directory, checked-out branch
and bound repository, so a rebind to another repository starts without a choice. Explicit selection bounds remembered choices to 100 entries. A choice
contains the PR number and its repository, so fork and upstream PRs with equal
numbers remain distinct. `usePullRequestComparison` owns the searchable,
paginated list while PR mode is active and reads it through
`SourceControlAPI.changeRequestsList` with the bound GitHub context. The shared
status store, asked through that same context, supplies the initial choice,
independently of list pagination. An absent match requires selection. External walkthrough handoffs
apply once, and later picker changes
remain authoritative when a retained panel becomes visible again.

Examples:

- `useUIStore.ts`
- `useDirectoryStore.ts`
- `useFeatureFlagsStore.ts`
- `useUpdateStore.ts`

These stores coordinate visible app state, navigation, selected context-panel tabs, dialogs, and lightweight feature flags. Context surfaces open in zones around the chat (`lib/surfaces/DOCUMENTATION.md`, Zones): `contextSurfaceZones` is the per-device placement, and each `contextPanelByDirectory` entry keeps the right zone in its top-level `isOpen`/`expanded`/`activeTabId` and the left and bottom zones in `zones`. Store version 24 added them; older state loads with everything on the right. `useUIStore.activeSurface` selects the primary mobile view and the few desktop views that are promoted out of the context panel. It is not a desktop tab selection. A browser tab opened by an agent (`openAgentBrowserTab`) is created in the calling session's directory and persists that session as `ownerSessionId`; tabs the user opens, and tabs saved before owners existed, have none. Agent browser actions use it to keep sessions out of each other's tabs (`packages/web/server/lib/browser-control/DOCUMENTATION.md`). Opening a new browser tab with an address (`openContextPreview`, `openContextBrowser`, `openAgentBrowserTab`) notes it, keyed by directory and tab id, in the session-only set in `lib/browser/devServerWait.ts`; the tab's first mount reads and forgets it. Only a noted tab waits for its dev server on the first load. A tab restored from saved state, or remounted later, loads once and shows the failure. A waiting tab retries after a pause that grows from 0.5 s to 4 s within its 40 s wait. While it is out of sight (another tab in front, the panel closed, another project on screen, the window hidden) it holds the retry and retries when shown again; a tab the agent opened or has acted on keeps retrying out of sight. When those openers hit a tab that already exists, they send it a session-only load request instead. A mounted tab that shows a failure, or has not shown a page yet, loads the address the way a typed one loads, wait included, so a failure from launch does not stay up once a project action starts the server; a tab showing a working page ignores the request and is only focused, keeping what the person had on it.

Context-panel session chats render in this app as a chat column pinned to
their session (`ChatView` `pinnedSession`, see the sync documentation's
*Pinned chat columns*). Only the active chat tab is mounted while the panel is
open; switching tabs opens the other session like a session switch.

`useDirectoryStore.ts` resolves the home directory when the module loads and
again on every runtime switch; only the newest resolution commits. On a
browser's first visit to a server with a UI password, the page-load attempt
runs before login, every source answers 401, and the home falls back to `/`
with `isHomeReady` false. After authentication the session gate calls
`ensureHomeDirectoryResolved` and keeps the app unmounted until it settles or
10 seconds pass, so the app starts in the real home rather than `/`, where a
new chat cannot even be created. A resolution still in flight is awaited, not
replaced. If the server still cannot name the home, the app starts in `/` as it
did before. A home that is already known, from storage or the desktop shell,
shows the app at once when a last directory is stored.

When no last directory is stored, no project is open, and the app works in the
managed chats root (`noProjectDirectory`), where a chat draft works anyway.
Every OpenCode read names the app's directory, and with the home there OpenCode
started a location over the whole home folder, file watcher and MCP servers
included. Until the server names the chats root the directory is empty: the
store sets no client directory, `isHomeReady` stays false and the session gate
keeps the app unmounted, because the home resolution waits for the chats root
too. Without a chats root the home stays the directory, still not ready, so a
server that answered 401 before login is asked again after it; the home is
the lasting answer only when the server cannot name the chats root after that,
and in VS Code windows with workspace folders. Empty VS Code windows resolve
the Chats root through the extension host before selecting a directory. The chats root comes from the
server's answer itself (`resolveChatsRootDirectory`): the cache behind
`getChatsRoot` is keyed by the runtime key at request time, which can still
change while the page starts.

That fallback is not saved as the last directory, locally or in the server
settings. Removing the last project also goes there
(`goToNoProjectDirectory`) and forgets the stored last directory: it is removed
locally and sent to the server as `''`. The server adds a stored last directory
as a project when the list is empty and warms it on every start, so either path
used to put the home, or the project just removed, back in the sidebar and
start OpenCode there on every launch.

Restoring the saved directory through `applyPersistedDirectoryPreferences`
probes that one path with the host's directory-stats route. A confirmed missing
path uses `goToNoProjectDirectory` and clears the saved choice. An unavailable
probe keeps it, including before login. A newer directory, settings snapshot,
or runtime switch retires the probe; a runtime switch during fallback resolution
also prevents it from changing the directory or persistence.

Nothing about directories is carried from one host to another (the desktop
host switcher, a mobile instance switch). Four rules hold that:

- The home and chats-root lookups read `/api/fs/home` through the route, which
  resolves when the lookup runs, so they reach the host the runtime key names
  at that moment. They never use the client's base URL: the desktop's boot-time
  default-host restore switches the runtime before the app-wide reset that
  rebinds the client is installed, so a lookup through that base would reach
  the boot host and cache its chats root under the new host's key.
- A lookup that answers after a switch stores nothing. Only the commit of the
  newest resolution writes the home to local storage and to the host's
  settings, so the host the window left cannot write its home into the new
  host's settings.
- After a switch, only the host's own answer names the home. System info (which
  derives a home from the stored last directory), the desktop shell's home, and
  the stored home all describe the host the window booted on, so they are used
  at boot only. A host that does not answer (401 before login) leaves the home
  unknown, and the post-login resolution above names it.
- `session-ui-store` restores the directory it remembers for the host being
  entered. When it remembers none and the switch comes from another real host,
  `resetForRuntimeSwitch` forgets the directory: it is unknown (`/`,
  `isHomeReady` false, no client directory; `isDirectoryUnknown`) until the home
  resolves, and `synchronizeHomeDirectory` then adopts that host's
  no-project directory whatever is stored. The reset writes nothing, so the previous host's stored last
  directory survives for its next start. Coming from no host (a cold launch
  that connects through a switch) the directory the window started with stays.
  Leaving a host records its directory unless it is unknown; a key that names
  no host (disconnected) records none. A host whose home lookup failed still
  has a directory, and it is recorded.

`useSessionTabsStore` keeps the header's working sets of session tabs on the
device. With "Separate tabs for each project, worktree and space" off there is
one set, `global`. With it on each project root, worktree, isolated space and
the chats get their own, keyed by instance and folder
(`lib/sessionTabScope.ts`), so switching servers never mixes their tabs and
another browser keeps its own sets (tabs are what one window looks at;
drafts and pins, which are data, live on the server). The shown set is
`tabIds`/`previewTabId`, so every action works on what the strip shows;
`enterScope` swaps it with the stored one. A worktree or space shown for the
first time opens with the sessions the user started there as pinned tabs, no
subagents; a project root opens with none, since it can hold hundreds. The
strip enters a new scope only once the global session list has loaded, so a
seed is never taken from a partial list and stored empty for good. At most 40
other scopes are kept, the least recently shown dropped first. `removeTabs`
clears a gone session from every set. Version 1 moved the version-0 single
set into the global scope.

### Session / project coordination stores

`useMultiRunStore` creates ID-bound multi-run members. Runs are projected from
the session lists (`lib/multirun/runs.ts`), not kept in a store of their own.
Membership, fork handling, fusion and legacy compatibility are owned by
`lib/multirun/DOCUMENTATION.md`.

`useProjectsStore.hasServerSnapshot` distinguishes a server-confirmed project list from persisted startup hints; `serverSnapshotFailed` records a failed settings sync without clearing the last confirmed list. Successful settings adoption clears that failure even for an unchanged list. Runtime switching clears both flags. Extension project subscriptions consume these flags and project records without changing active selection.

Project parsing, project selection, directory navigation, mobile session paths, and the SDK adapter share `lib/pathNormalization.ts` for request paths. Tilde expansion happens before normalization. Windows drive roots retain their slash, and parent navigation stops at drive and UNC share roots. Selecting a spelling variant of the current directory preserves history and its forward entries. Bare drive-relative paths such as `C:` stay distinct from `C:/`; normalization does not guess their filesystem target.

Examples:

- `useProjectsStore.ts`
- `useGlobalSessionsStore.ts`
- `useSessionFoldersStore.ts`
- `useProjectContextStore.ts`
- `messageQueueStore.ts`
- `useRoutingStore.ts`
- `useSessionWarmingStore.ts`

These stores coordinate persistent project/session metadata across multiple views.

`useProjectContextStore.ts` caches server-owned project notes, todos, and plan links, keyed by the path-derived project id. It replaced a pair of `window` CustomEvents that made every mounted notes panel re-read the whole project config. Writes are optimistic and roll back on failure; they are serialized per project, because the server's own store does a read-modify-write and two concurrent saves would otherwise race it. A load captures per-field mutation revisions and preserves fields changed by a newer write, even when that write finishes before the response arrives. A failed load sets `error` and preserves the cached snapshot. Note and plan creation are deliberately not optimistic, since ids and timestamps are assigned by the server. Notes, todos, and plans are written through separate routes and tracked by separate in-flight flags, so a todo toggle cannot clobber a note edit in the same window. Pinned notes and plans are assembled into a synthetic context part by `lib/projectContextPinning.ts` at send time; that module tracks per-session what it already sent so an unchanged pinned set is not re-sent every turn.

Ordinary loads still reuse a loaded entry. Visible-owner synchronization is owned by `lib/projectContextSync.ts`, as described in the panel's `DOCUMENTATION.md`. Forced loads wait for admitted local writes, so a notification sent before this client's save response cannot lose a peer change behind an in-flight flag. A write still pending when a forced read returns earns another read after it settles, including after rollback. Only a resolved write advances its field revision; a rejected attempt cannot hide authoritative peer data. Concurrent loads share one promise; refresh demand received during a read earns one trailing authoritative read. Runtime reset retires those promises and their generation, so an older success or failure cannot populate or alter a same-id entry on the new host.

`useRoutingStore.ts` projects the server's Jev routing state (whether the Auto
model may be offered, the config Settings → Routing edits, the last decision
per session, permissions the safety net is holding). Nothing is persisted; a
failed read keeps what was known and records `loadError` instead of reading as
"routing is off". See `packages/web/server/lib/routing/DOCUMENTATION.md`.

`useSessionWarmingStore.ts` projects which sessions the server keeps warm and
until when (`packages/web/server/lib/session-warming/DOCUMENTATION.md`).
Nothing is persisted. `sync/session-warming-sync.ts` reads the snapshot on
subscribe and whenever the control stream reconnects, and applies the whole
snapshot each broadcast carries; an older revision is ignored, and a runtime
switch resets the store first. VS Code keeps it empty: it has no OpenChamber
server and offers only OpenCode's global warming.

`messageQueueStore.ts` has two owners, decided by `isServerOwnedMessageQueue()`.
The VS Code foreground delivery gate holds an idle parent while a live busy or
retry descendant runs, following up to 8 parent links through the cached sync
session index. It rechecks on status and session-topology changes. Activity
comes from the queue directory's live status map; unrelated active trees and
background shells do not hold delivery. This is a queue-specific exception to
the own-session send status described in `../sync/DOCUMENTATION.md`.
On web, desktop, and mobile the server delivers the queue independently of the
UI. The store projects authoritative snapshots and revisioned session updates.
Scheduled queue items also retain their `scheduledTask` provenance. An inherited
scheduled item has no pinned send config; ordinary items keep their captured
provider and model. Both appear in the same queue. Scheduled items allow reorder
and removal, but not editing or manual send. Bulk take leaves them queued.
`sync/message-queue-sync.ts` receives queue events through the shared control SSE
stream at `/api/openchamber/events`, including while OpenCode uses SSE fallback.
It adds no poller or per-session connection. Either stream reconnecting requests
`resync()`, independently of directory-bootstrap suppression.

Hydration and recovery share one in-flight request per runtime. A recovery edge
during its snapshot read earns one trailing read; legacy uploads are attempted
once per runtime rather than repeated on reconnect or snapshot failure. Snapshot
reads have a 15-second deadline. Failure preserves the projection and runtime
switches reject stale completions. Full-snapshot revisions also cover omitted
sessions, so a delayed mutation response cannot resurrect a cleared queue;
session events newer than that snapshot survive reconciliation.

A session in an isolated space has its queue in that space's own server, which
sees the space's OpenCode go idle and delivers. Every request about such a
session's queue names its directory, which sends it to the space; the host's
snapshot owns only the host's sessions, and each space's snapshot, read with
`refreshSpaceQueue`, owns only that space's. The two number their revisions
apart, so snapshot revisions are kept per runtime and owner. The host forwards
a space's queue changes on the same control stream, marked with `spaceId`, and
a change applies only to a session of that space. `message-queue-sync.ts`
reads a space's queue when the space first appears in the spaces store, when
the host announces `openchamber:space-queue-stream` after following that
space's queue again, and on every reconnect of the control stream. A space
that cannot be read keeps what was last known of its queue.

Mutations are optimistic and then settled on the server's copy; failed
round-trips re-read instead of guessing. Empty legacy events without a directory
clear all projections of their session in that runtime. Projection items carry
attachment metadata only, so `popToInput()` and `takeForSend()` asynchronously
remove the message on the server and retrieve its complete captured payload.

`lib/messages/queuedMessagePreview.ts` derives the queue row from typed text,
then attached comments/context, then the first filename. The store sends a
bounded `contextPreview` with the captured item so server projections can show
context-only messages without carrying full quotes or diffs. VS Code derives
the same preview from its local full item. Preview text is display-only;
editing and delivery always use the original content and captured context.

A queued message is captured whole, so whoever delivers it sends exactly what the composer would have: `text` (the content with its agent mention stripped and `@file` mentions already resolved into `attachments`), `agentMention`, and `context` — every chip the composer had attached (inline comments, terminal selections, browser annotations, PR comments/checks, quotes, linked issue/PR/tracker item references, pending synthetic parts) plus the skill instruction derived from the text. `QueuedContextPart` distinguishes attached items (restored to the chips when the message is edited) from derived instructions (re-derived on send, never restored) and from synthetic parts other surfaces handed the composer (restored as pending). Context is captured by `buildComposerContext` and delivered by `queuedContextToParts` (`components/chat/composer/submit/buildOutgoingMessage.ts`), the same functions the composer uses for its own send. An armed "run as goal" is captured as `goal` and consumed from `useSessionGoalArmStore` at queue time, so the goal starts with this message and not with whatever is sent next; a send of taken items passes their goal to `sendMessage` as `queuedGoal`, and a send of taken items alone passes `null` when they have none, so it never consumes the arm that belongs to the composer text. Editing the item arms the composer again. Nothing is re-resolved at delivery: the server has no agent list, no confirmed mentions, and no draft store. Messages a previous build left in this browser are uploaded once on the first hydration of a runtime and then dropped from persistence for that runtime (`partialize` skips server-owned runtime keys). VS Code has no server and keeps the local queue with the foreground auto-send hook (`useQueuedMessageAutoSend`, enabled only there). While an auto-review runs, the server holds that session's queue itself (`packages/web/server/lib/auto-review/DOCUMENTATION.md`).

`useAutoReviewStore` projects the server's auto-review runs for the active runtime, nothing persisted: the server drives the loop and keeps each run, finished ones included, until the user dismisses it. Runs are keyed by owner and reviewed session, and a chat reads its run with `selectAutoReviewRun(sessionId, directory)` under the owner of its own directory: a space's snapshot reaches the browser unfiltered, and this keeps a space that names a host session off the host's chat. It follows the queue's ownership rules. The host's snapshot (`hydrate`) owns the host's runs and each space's snapshot (`refreshSpace`) owns that space's, revisions compare per owner, a broadcast (`openchamber:auto-review.updated`, through `sync/auto-review-sync.ts`) applies only to a session of the owner that sent it, and a snapshot never undoes a newer broadcast. `auto-review-sync.ts` re-reads on every control-stream reconnect, when a space first appears, and when the host announces `openchamber:space-queue-stream`, which is the same connection inside the space. Stop and dismiss are one `removeRun`: optimistic, and a refused request puts the run back and re-reads the owner. A runtime switch clears the projection; the previous server's runs keep going there. VS Code has no server, so `isAutoReviewAvailable()` is false and the review dialog offers no auto-review.

In the local (VS Code) mode the store keeps a queued message until its own send resolves, so between dispatch and resolution the entry is still visible to every reader. Dispatchers must therefore mark the send (`markSending`/`clearSending`) and read `getSendableQueue()` — or filter `sendingIds` themselves — instead of dispatching straight from `queuedMessages`; otherwise a composer submit merges a message the auto-send hook is already delivering and it is sent twice (the window is seconds over a relay). `clearQueue()` retains in-flight entries for the same reason. `sendingIds` is deliberately not persisted: a restart has no in-flight sends, and a stale flag would strand a queued message; in the server-owned mode it mirrors the server's in-flight item. Desktop queues use the configured host id as runtime identity, not the current API URL, because an SSH reconnect allocates a new local forwarding port while the remote host remains the same.

`useGlobalSessionsStore.ts` owns cold/global active and archived session coverage. Its entity map and active root, parent/child, and directory indexes are maintained in the same transaction as the compatibility arrays and `sessionsByDirectory`. Full authoritative snapshots may rebuild those indexes once; direct create, update, move, archive, and delete mutations update only affected hierarchy and directory buckets. Metadata-only updates preserve the structure reference. It is complementary to directory child stores: it is not the source of live busy/retry status or session messages.

`sessionLineage.ts` answers which sessions sit below a session for an action. Every action that reaches a session's descendants (archive, delete, restore, move to a worktree or project, export, restore relocation, the tray's activity rollup) asks it, with the policy the action needs: `active` stops at an archived session (move, export, tray), `activeThroughArchived` reaches active sessions under an archived intermediate (archive), `all` takes everything (delete), `archived` stops at an active session (restore). `readGlobalSessionLineage` reads the global active-plus-archived cache when the user acts; `createSessionLineage` indexes a given list once for a pass over many roots. Invariant: for the same root, runtime state and policy, the answer does not depend on which surface asked. A sidebar row may render its session with no children (In work, Pinned, the List view), so no action takes its descendants from the rendered row. Presentation-only walks (which rows a sidebar section groups, badge scopes, search) keep their own topology and stay outside this module.

### Why one lineage module and not a walk per action

Each action used to walk the parent links itself: some over the rendered row, some over active sessions only, one over the active-plus-archived cache. A flat row then silently changed what Move and Export reached (#4837, #4842), and "Archive all" reached no subagents at all. With one module the policies differ by name and the graph they walk is the same.

### Why destructive actions include reviews

Archive, delete and restore policies also follow a review's `originalSessionID`
when it has no `parentID`. The maintainer chose to keep reviews with the reviewed
session while forks and promoted `/btw` conversations remain independent. The
`active` policy used by move, export, relocation and tray activity keeps OpenCode's
`parentID` graph only. Both graphs are indexed once per action and share cycle
protection; display nesting and directory placement do not decide ownership.

User-visible session ordering is also not owned by the global cache array order. `sync/session-ordering.ts` combines lifecycle rank with timestamp fallbacks, and session surfaces must use that shared comparator instead of independently sorting global sessions by `time.updated`.

Global refresh rules:

- `hasLoaded` means a complete global snapshot has succeeded in the current runtime. Root lookup failure, partial pages, fallback data, and directory-only refreshes cannot establish it. Once established, it survives background loading and failure until runtime reset, so known empty groups do not flash loading on each poll. `status` still describes the current request and gates authoritative cleanup. Loading includes chats-root lookup, so that wait is visible too.
- The global cache loads every session of a scope and splits active from archived client-side via `splitGlobalSessionsByArchived`. OpenCode's `archived` list filter (2.1+) is not used: it cannot see sessions whose archive state lives in the server's archive file (deleted directories), so a filtered request would show them as active. Pagination progress stays measured on the raw response.
- The full load paints as it paginates: the first accepted page is merged into the visible lists immediately while the remaining pages keep loading, so a workspace with thousands of sessions is not blank until the last page arrives. That merge is an upsert (never a replacement), leaves `status` at `loading` and `hasLoaded` false, overlays mutations newer than the load baseline, and is excluded from the managed-chats snapshot write — only the complete snapshot is authoritative, persists, and raises ordering baselines.
- The store starts from a persisted seed: the managed-chats snapshot and a global snapshot of active sessions outside the chats root (`readGlobalSessionSnapshot` in `sync/persist-cache.ts`). The global snapshot keeps the 200 most recently updated active sessions plus every ancestor of a kept child, stripped like the directory snapshots and bounded to 256 K characters, falling back to 100, 50, 25, 10 sessions on size or quota and removing the stale value when nothing fits. It is keyed and stamped by runtime, schema-checked on read (corrupt or foreign data is removed and reads as no seed), excludes archived sessions, and is read again by `resetForRuntimeSwitch`. VS Code neither reads nor writes it: its sidebar covers the open workspace, which the directory snapshot already seeds. Seeded records never stand in for a complete record with the same signature, so the first live upsert or complete snapshot replaces each one; `hasLoaded` stays false and `status` never becomes `ready` on the seed. Before the first complete load the snapshot is rewritten only as saved contents plus explicit local mutations (`overlayMutationsSince` from revision 0), never from the partial list in memory; from the first complete load on it follows the active list, throttled with the directory snapshots. A directory refresh before that load does not update it.
- Per-directory refresh issues one inclusive request per directory (previously two), bounded to two requests across callers and prioritizing the current directory.
- The directory-refresh limit belongs to an instance visit. Switching retires queued refreshes and gives the replacement instance fresh slots; old completions release only their captured slots. One owner spans the whole multi-directory refresh, so a worker cannot start its next old directory under the new instance. Same-instance transport changes retain the slots.
- Each directory is an independent completeness scope. A failed directory preserves its previous sessions while successful directories reconcile normally.
- Fetch failure must remain distinguishable from a successful empty list; failed scopes cannot destructively clear cached sessions.
- Runtime switch increments the load generation and clears the previous runtime's snapshot so stale in-flight work cannot commit.
- Live session mutations update the cache directly after successful SDK actions; they preserve stable directory metadata when lighter event payloads omit it.
- Live directory-store sessions handed to a load or a directory refresh only fill gaps: they add sessions the cache does not hold, active or archived, and never replace a record it does. The cache hears every session event and action result itself, while a directory store can keep an old copy of a session it does not own; when that copy won, sessions the user had marked done came back under "In work" until the next full load. The desktop sidebar and the mobile sessions sheet apply the same rule when they combine the two sources.
- Full and per-directory loads capture a mutation revision. At commit time they overlay only per-session create/update/archive/delete/move mutations newer than that baseline, including no-op deletion tombstones, so an older response cannot undo newer local authority.

Permission auto-accept policy is authoritative in the active Web server or VS Code extension host. Owner snapshots carry a monotonic revision; the UI rejects lower revisions and any hydration or mutation completion captured before a runtime reset. Persisted UI policy is not live authority. A session in an isolated space has its mode in that space's own server, which answers its requests: `spaceModes` keeps each space's policy apart from the host's `modes`, a mode set for such a session is sent to the space, and `getSessionMode` reads the policy of the space the session's directory lies in. Each space numbers its own revisions. `sync/permission-mode-sync.ts` reads a space's policy when the space first appears in the spaces store, and `onSpacePermissionStream` in sync-context reads it again when the host announces `openchamber:space-permission-stream`; the host forwards a space's changes marked with `spaceId`. The version-2 store retains an old unscoped policy only as a one-runtime legacy migration candidate, then removes it after successful migration.

Shared safe storage treats durable failures per key. A quota or access failure creates an ephemeral override or tombstone for that key without disabling reads and writes for unrelated keys; later writes retry the durable backend. Deferred adapters retain failed operations for a later flush, and malformed Zustand JSON is removed and treated as missing so hydration can recover.

Settings fields are declared once in the settings registry (`packages/ui/src/lib/settings/DOCUMENTATION.md`); the sync described here iterates that registry rather than naming keys. Project and UI settings use successful settings synchronization as authority for the fields the snapshot supplies. A field the server omits is "unset", not "reset": the window keeps whatever value it already holds and nothing is written back — a bootstrap never seeds the server from local state. The one exception is the project list, whose omission still means an empty list (`useProjectsStore`). Theme fields follow the same keep-what-you-hold rule and additionally adopt only on bootstrap-grade syncs; settings save echoes never adopt a theme. A write reaches the server only because a person changed something in this window: the theme context writes only from its user-facing setters (never on mount or on adoption), and the store-subscribing auto-savers (`appearanceAutoSave`, `modelPrefsAutoSave`) treat changes made while `isApplyingServerSettings()` is true as a new baseline rather than a change to send. `updateDesktopSettings` additionally drops any key whose value equals the last value the server was seen holding for this runtime, so an echo or a toggle back to the server's value inside the debounce window produces no request. Device-scoped registry fields (window controls, mobile keyboard mode, input bar offset) never leave the install: they are dropped from writes, persisted only locally, and adopted from a pre-split server document once per runtime as a seed. Per-surface profile fields arrive already resolved for this client's surface kind (`lib/settings/surface.ts`); the stores never see another kind's value. VS Code settings broadcasts may still adopt shared workspace pointers without replacing each webview's editor-derived theme. Transport or settings-load failure dispatches no synchronization event and preserves current state. Settings save responses are partial patches and must not clear unrelated in-memory preferences or local mirrors. Debounced settings writes flush best-effort on page hide, document hidden, app freeze, and unload — canceling the pending timer so the write happens exactly once — because a write lost inside the debounce window lets the stale server snapshot override the change on next startup; a hard process kill can still lose the in-flight request. The unload flush uses `keepalive: true` on the HTTP write, because a plain fetch started from `pagehide`/`beforeunload` is cancelled with the document; `navigator.sendBeacon` is not used, as it cannot carry the runtime bearer header. On Capacitor neither `pagehide` nor `beforeunload` fires when the OS suspends the app, so the flush also runs on `App.appStateChange` going inactive.

Session defaults belong to the active runtime. Switching instances clears the in-memory defaults and directory config snapshots; persisted config hydrates only when its recorded runtime matches. Legacy snapshots without an owner are refetched. Initialization, health checks, and directory activation reject obsolete continuations, including A to B to A switches. The delayed startup agent recheck belongs to that initialization's instance generation: a switch away retires it even after returning, while a LAN/relay transport change for the same instance keeps it. Mobile preserves initialization across such transport changes, so there is no replacement startup timer.

Persisted config (`config-store`) holds selections only. The provider and agent catalogs and their `*Loaded` flags stay in memory, both top level and per directory. VS Code gives every OpenChamber webview one origin, so each localStorage write reaches every webview in every window as a `StorageEvent` carrying the old and the new value. With the catalogs included, one write was tens of megabytes, and the shared webview renderer ran out of memory. A cold start therefore paints the pickers once `initializeApp` / `activateDirectory` load the catalogs; an empty hydrated snapshot reports not-loaded, never an authoritative empty list. The last live catalogs are kept instead in IndexedDB (`configCatalogCache.ts`, which fires no `StorageEvent`), keyed by runtime and config directory, bounded to 24 directories, with a schema version; a record that fails its shape check or names another schema is deleted on read. Records hold only what the pickers and composer show, built field by field from an allowlist and read through strict schemas: provider, model and variant `settings`/`headers`/`body`, an agent's request (apart from its numeric `temperature`/`topP`) and its system prompt are never written, because they carry API keys and authorization headers. At startup and on a directory switch the cached catalog fills a directory whose live catalog has not loaded, without setting `*Loaded`: the composer pickers render from it, Settings pickers and recovery loops keep waiting for a live load. Only live loads write the cache, 3 s after they apply and only when no catalog event for that directory arrived since the load began (the re-read the event triggers writes instead), so a starting location's partial first answer is never stored; an empty answer is written only by a re-read. A location OpenCode is still starting answers empty, then partial, so the first live answer for a directory shown from the cache is held back when it lists fewer models or agents than the cache, and re-read once after 2.5 s; that re-read replaces the cache whatever it holds. Older blobs that still carry catalogs hydrate as before. The slim format is persist version 1: a build without it has no `migrate` for version 1 and skips the blob, so it gets a cold start instead of reading `snapshot.agents` on a snapshot that has none. The persist middleware writes after every `set()`, including one whose updater returns the same state, so selection setters (`setProvider`, `setModel`, `setAgent` and the model it resolves) check for an unchanged selection before calling `set()`.

Configured project and global model identifiers remain selected through provider discovery gaps, except for an Auto selection the server has confirmed it cannot honour. A draft can display its configured identifier before model metadata arrives. Catalog absence never selects Big Pickle in its place. An unknown settings document defers fallback selection; a successful document with no configured model permits the normal OpenCode fallback. Before that fallback comes the model last picked in a chat composer (`lastSelectedModel`, a synced profile setting written only by the composer's model picker and the favorite-model shortcuts, never by other model pickers or session restores), so a new session starts where the user last chose when nothing configured names a model. Like a configured identifier it survives catalog gaps; a model hidden since is skipped, and so is an Auto pick the server cannot honour. The fallback itself (Big Pickle, else the first model) skips models hidden in the picker, on the client and in the server's session routes; a configured project, settings, agent, or OpenCode model is honoured even when hidden, and with every model hidden the unfiltered pick stands. Saved thinking preferences stay in settings; an OpenCode config `model` carries its effort as a `#variant` suffix, and a discovered model's supported variants determine the effective thinking level.

Project defaults include `defaultAgent`, `defaultModel`, and `defaultVariant`.
The project agent precedes the global agent, then OpenCode's default and the
primary-agent fallback. Settings parsers retain all three fields on every read
and save echo. The project editor loads agents, models, and effort options for
the edited project without changing the active chat's configuration.
Manual model and effort selections survive catalog gaps too. A missing catalog
entry is not a request to replace a user's choice. Directory snapshots retain
the effort override separately from its inherited value, including explicit
`Default`. Fresh drafts inherit their project's effort before the global one.

The agent and the model carry separate provenance. `setAgent` records the agent
as picked (`agentSelectionSource: 'manual'`) and leaves `selectionSource` to
describe the model alone, so an agent's pinned model stays inherited and is
never saved as a per-agent session override. Every path that re-resolves
defaults (`loadAgents`, the config-defaults reconcile, `loadSessionDefaults`,
the draft re-apply after activation, the Defaults settings page) keeps a picked
agent together with the model `setAgent` resolved for it. Only
`applyDefaultModelAgentSelection` and activating a directory with no snapshot
clear the pick. An effort picked in a draft is a choice of its own: those same
paths leave the draft alone while `currentVariantSelection.override` is set.

An open session's agent goes both ways. A pick applies to the session when the
next message is sent (`switchAgent` before the prompt). Every switch, whoever
made it (this composer, another client, a plugin), lands on OpenCode's session
record through `session.agent.selected`, and `ModelControls` follows the
record through `useSelectionStore.followSessionAgent`. That store remembers,
per session and persisted, the record agent the composer last followed: a
record agent it has not followed yet is a newer switch and replaces the pick,
an unchanged record leaves a pick made after it in place across session
switches and reloads. Following moves the agent only (`setAgent(name, {
keepModel: true })`): the session keeps running on its own model, so neither
the agent's pinned nor its remembered model is applied, and Auto stays.

The agent shown is the agent sent. The picker labels an open session with its
`sessionAgentSelections` entry, while a send carries the config store's
`currentAgentName`, which other sessions, directory snapshots and agent-list
reloads also write. `ModelControls` therefore brings `currentAgentName` back to
the session's entry whenever the two differ, through `setAgent` so the
session's remembered model for that agent comes with it (`keepModel` under
Auto). Without it, returning to a session could show Build and send the agent
another session left behind.

The model follows the same rule through `isSessionModelSwitched` /
`markSessionModelFollowed`, keyed `provider/model#variant`. A record model the
composer has not reconciled with yet outranks a manual model and its effort
(an effort only when the record carries one); with nothing reconciled yet,
a manual model that disagrees with the record keeps winning, as before. A
saved Auto is never replaced: the router itself switches the session's model
every turn, so those switches are only recorded as reconciled.

Project-default editing is available in desktop web and Electron. Hosted mobile
and Capacitor consume those defaults through the shared composer but have no
project-default editor. VS Code retains its workspace-project behavior and does
not adopt or edit these project settings.

`loadSessionDefaults` publishes preferences independently of OpenCode health and catalog requests. Cold directory activation starts providers and agents concurrently. Agent selection uses the latest committed preferences without waiting for providers or issuing a second settings read. Explicit preference edits update a draft immediately, and late settings responses preserve newer edits. Agent-pinned and OpenCode-config model identifiers can be selected before their catalog entries arrive.

Provider and agent catalogs carry separate successful-load flags in directory snapshots, including successful empty responses. Pickers become interactive when their own catalog is available. A known selected identifier can be displayed earlier. The composer keeps a loading label until it knows the choice or has the inputs to establish an empty selection; providers arriving alone cannot reveal an empty agent picker.

Provider reads share one request per directory, both in `loadProviders` and in the client's `getProvidersForConfig`. A read prompted by a change (a catalog event, a provider mutation) passes `fresh`: it never joins a request already in flight, because that one can carry the catalog from before the change, say a worktree opened before OpenCode registered its plugin providers. It waits that request out and reads again. When every attempt for the active directory fails and it has never loaded, one delayed retry follows; without it nothing re-reads that directory until something unrelated, such as Settings → Providers, asks.

A fresh provider read waiting behind another request keeps its original instance owner; an instance switch retires it before it starts another catalog read. The Settings agent loader likewise checks its generation after the agent list arrives, before fetching per-agent source metadata. Rejecting only the final publication would still send old directories to the replacement instance.

### Why image models load with the catalog and stay out of `providers`

`getProvidersForConfig` asks `model.list` for chat and image models, because OpenCode lists chat models only by default and a provider whose models all generate images would vanish from Settings → Providers, leaving it impossible to edit or disable there. `loadProviders` keeps `providers`, which every chat picker reads, to chat models (an unset `type` is chat). A provider with image models only goes to `imageOnlyProviders`, which only Settings → Providers reads through `selectImageOnlyProvidersForDirectory`. Adding those providers to `providers` with an empty or image-only model list was rejected: the pickers, default-model resolution and the catalog cache all treat a listed model as one a chat can run. The list is runtime-only and is not persisted or cached.

Since OpenCode 2.2 the provider, model and agent routes wait for the directory's plugins, so the first read of a directory OpenCode has not started is complete, and `getProvidersForConfig` asks for models, the default and providers together. For a folder inside an isolated space the providers come from the host project the space was made from, so a catalog event in that project also takes the space's loaded folders out of the freshness window. A catalog event still means the catalog changed (a provider connected, a config edit, a plugin reloaded). The catalog refresh re-reads only the active directory, so every catalog event also calls `markConfigCatalogStale(kind, directory)`, which takes that directory's providers or agents out of the 30-second freshness window (`null`, for a server-wide event such as a credential change, takes out all of them). Switching back to a directory whose catalog changed while it was in the background therefore re-reads it. Meanwhile the composer labels the selected model, its efforts and the agent with `selectKnownCatalogModel` / `selectKnownAgent`, which fall back to any other directory's snapshot, so a cold directory shows the name it already knows rather than a raw id or "Select agent". That fallback is display only: selection, effort resolution and validation read the active catalog, and a model or agent no catalog knows is shown as before.

An effort picked in a project draft travels to another worktree of the same project (`activateDirectory` with `preserveManualModel`), also while the model is still the automatic one. `currentVariant` is what a send carries, so every loader that keeps a pick in `currentVariantSelection` also writes that pick to `currentVariant` (`variantAfterResolve`) instead of the default it resolved for the model; otherwise the picker showed the pick and the send used the default. Marks carry a revision, and a load that began before the latest mark for its directory does not make that directory fresh again.

Settings reads retain overlapping local mutations until the read settles, including writes that finish before the older GET returns and toggles that cancel a pending write. Both the returned document and GET cache use that reconciled result. An older GET cannot replace newer server-value knowledge used to deduplicate writes.

Project ordering defaults to manual. Session display persistence v3 migrates the previously shipped `recent` project order to `manual` while preserving every other explicit sort mode.

Session display persistence keeps a hydrated local cache for the independent all-projects/single-project mode, session grouping, project sort, and Recent preference; successful server settings snapshots are authoritative for the fields they carry, and a field the server omits leaves the local cache untouched (it is not seeded back to the server). The last confirmed or manually selected project and sticky-header preference stay local to the device. Draft target changes do not write the picker selection; materialized session navigation updates it from the resolved project directory, except the launch restore of the last session, which belongs to the launch and leaves the remembered picker alone.

Session folders are stored by the OpenChamber server and shared by all of its clients (`packages/web/server/lib/session-folders/DOCUMENTATION.md` owns the stored format and the change semantics). `useSessionFoldersStore` shows the server's last answer with this device's not-yet-stored changes laid over it. Every folder action is one change (`lib/sessionFolders/folderChanges.ts`) that the store applies at once, queues in runtime-scoped storage (`oc.sessions.folderChanges.v2:<runtime>`, written immediately so a reload still sends it) and sends to `PATCH /api/session-folders` 150 ms later, up to 500 changes per request; a change stays queued until the server stored it, a failed write retries with backoff up to 30 s and again when the event stream reconnects, and a change the server rejects as malformed is dropped and the server copy read again. The server's answer and every later read replace the shown folders only when their revision is not older than the last one shown. `sync/session-folders-sync.ts` reads them again when the control stream announces `session-folders-changed` with a newer revision, and after each reconnect. Before the first successful read nothing is sent: on its first contact with a server a device hands its own folders from older versions to the server once (an `import` change, with any tombstones an older version left unsent), marks the runtime in `oc.sessions.foldersShared.v2:<runtime>` and only then shows the server's folders. Creates, renames, moves and deletions queued before that are already in the copy the import sends (deletions as tombstones) and leave the queue with it, since a new folder the server joins by name would otherwise come back as a second one under its local id; until that succeeds the local copy stays on screen. A missing file on a server that stores shared folders is an empty list; a failed or malformed read keeps what is shown. A server from before shared folders answers 404 to `PATCH`; the store then writes its whole copy with `POST` the way older clients did, with the folders it deleted as tombstones, and gets no live updates from that server. The runtime-specific v2 browser keys stay as this device's cache of the server copy, flushed on runtime switch, page hide, freeze and unload. Which folders are collapsed stays on the device (`oc.sessions.folderCollapse.v2:<runtime>`) and is never read from the server. VS Code has no OpenChamber server, so its folders stay in its own storage and nothing is sent. File-search cache and in-flight keys include runtime plus directory and are cleared on endpoint reset.

Persisted session todos use a bounded composite key of runtime, normalized directory, and session ID. Ambiguous legacy todo entries are discarded rather than claimed by whichever runtime starts first. Authoritative deletion uses an explicit runtime identity, and session-folder deletion scans every scope in the active runtime so archived assignments cannot survive after their session is gone; it reaches the server as a `forget-sessions` change, so the chat leaves its folder on every client. Closing a project sends `forget-scopes` for its root, its archive and each of its worktrees, so its folders do not come back when the project is added again.

Chat composer drafts, confirmed mentions, inline-comment drafts, and pinned sessions use the same runtime/directory/session ownership rule. Chat drafts use a bounded shared envelope and notify mounted composers when authoritative deletion clears their identity, preventing unmount autosave from resurrecting deleted text. Inline drafts enforce per-session, global-session, and serialized-byte bounds. Pins retain every valid composite key across runtimes without silent age/count eviction and are never pruned from the first startup list. Confirmed local deletion and routed deletion events clear immediately; after an authoritative baseline exists, a later complete omission also cleans persisted state. Ambiguous session-only legacy drafts and pins are not claimed.

Input history keeps both runtime-wide and runtime/directory/session buckets in one bounded browser-storage envelope. The per-bucket cap is configurable from 1 through 100 and defaults to 40. Recall defaults to the current session's bucket merged with the visible transcript's user prompts; the runtime-wide bucket is opt-in through the Chat setting. Lowering the limit trims older entries from every bucket at once and cannot restore what it discards. Every scope change, limit change, append, and session cleanup rereads the latest durable envelope before applying its mutation, so a stale tab preserves history written by another tab. A failed write retains bounded before/after snapshots. The next mutation applies that local delta to the latest durable data, preserving pending appends and session deletions together with unrelated changes from other tabs. A successful durable write clears the pending delta.

Server-owned queue acceptance records the original prompt and restorable attachments against its captured runtime/directory/session identity. Rejection records nothing. Automatic delivery and manual take do not record the accepted item again. VS Code retains recording at dispatch, using the full messages actually taken for sending.

Composer draft edits remain immediate in memory and use a trailing durable-write debounce. Pending text and confirmed mentions flush synchronously when the document becomes hidden, freezes, receives `pagehide`, switches identity, or unmounts; authoritative deletion cancels pending work before any lifecycle flush can run. The shared chat-draft envelope reuses its parsed snapshot until the storage value changes. Inline-comment draft byte accounting indexes serialized buckets and recalculates only the changed session bucket during normal edits; deferred storage still performs the final full-envelope serialization and lifecycle flush.

### `useTerminalStore.ts`

`useTerminalStore` owns terminal tab arrangement per directory plus PTY scrollback.

Scrollback is deliberately **not** stored on the tab. `buffers` is a separate map keyed by
directory and tab id, and `getBuffer()` returns a shared frozen empty buffer for tabs that
have produced no output. PTY output arrives at streaming frequency, so keeping it inside
`sessions` made every output chunk allocate a new tab, a new directory entry and a new
`sessions` map. That invalidated every tab-strip subscription, re-ran the project-action
run monitor, and made Zustand persist rewrite the session-storage snapshot per chunk.

Invariants to preserve when editing:

- Directory keys come from `normalizeTerminalDirectory` (`lib/pathNormalization.ts`) and
  nothing else. Server `cwd` strings, sidebar project paths and the panel's own directory
  all pass through it, so a folder has exactly one entry on every platform. Read `sessions`
  through `getDirectoryState`, never by indexing the map with a path normalized elsewhere.
- Output actions (`appendToBuffer`, `replaceBuffer`) must leave `sessions` referentially
  unchanged; only `buffers` and `nextChunkId` may change.
- Buffer entries are owned by their tab. `closeTab`, `removeDirectory`, `clearAll`, and
  rebinding a tab to a different terminal session must drop the entry.
- Output for an unknown tab is ignored rather than creating an orphan buffer.
- Only `sessions` and `nextTabId` are persisted. `partialize` reuses its previous
  projection while both are referentially unchanged, and the storage adapter skips a write
  for an unchanged projection, so streaming output performs no persistence work.
- Consumers that react to output must subscribe to `buffers`, not `sessions`.
- Action tab IDs remain stable while each command execution receives a fresh terminal ID.
  Starting or adopting a different execution resets its buffer sequence and preview together;
  reconnecting to the same execution and observing its exit preserve scrollback.
- Reconciliation selects one record per action before updating tabs. A running execution wins
  over retained exited records independently of listing order. An in-progress stop remains
  stopping until the same execution exits or explicit termination failure restores running.
- `terminalSessionObserver` shares one five-second refresh loop per terminal adapter across
  the visible sidebar, headers and panels. The existing empty-cwd listing returns all server
  sessions in one request; directory subscribers receive only their own records. A sidebar
  subscriber reconciles the complete list, including omitted known action directories.
  Focus and online recovery refresh immediately. Hidden/offline clients pause, failed reads
  preserve state, and the last consumer stops the loop. Replaced runtimes cannot publish old
  responses. Mutation revisions are captured for every subscribed scope before the request.
- Passive action adoption may restore output but has no launch-time authority to open browser
  tabs. Preview navigation belongs to the initiating host directory even for a parent action.
- Server session listings capture the directory's per-action mutation revisions when the
  request starts. Coalesced callers share that first snapshot. A response cannot replace or
  remove an action execution mutated after its request began, while a fresh successful empty
  response still clears an omitted run.

## Git / PR Stores

The Git and PR stores are the most important stores to understand before editing this directory.

### `useGitStore.ts`

`useGitStore` is a centralized active-runtime, per-directory Git cache.

Core model:

- active runtime owns one `directories` map keyed by directory
- each directory entry contains:
  - repo detection
  - status
  - branches
  - log
  - identity
  - diff cache
  - per-directory loading flags
  - freshness timestamps

Important properties:

- `directories: Map<string, DirectoryGitState>` is the source of truth
- loading state is per-directory, not global
- `ensureStatus()` and `ensureAll()` are the preferred entry points for consumers
- a non-repository answer is cached for the repository-check window; `recheckRepository()` is the one way past it, for a directory that just became a repository (Initialize Git in the shared not-a-repository state, `views/git/InitializeGitButton.tsx`). It invalidates adapter caches through `notifyGitStatusInvalidated` and forces a fresh probe and status
- in-flight dedupe exists for status and `ensureAll()`; status dedupe is scoped to the per-directory status mutation revision, so a refresh requested after a mutation never joins a pre-mutation in-flight request
- nested repository discovery (`nestedReposByRoot`, `nestedRepoSelection`, `ensureNestedRepos`) is per-root state for the repositories under a root — its submodules and nested checkouts — whether or not the root is itself a repository; discovery failure is a `null` marker (never a valid empty result), a runtime without the discovery route (VS Code) commits an `'unsupported'` marker, and an in-flight discovery whose runtime switched is discarded at commit time instead of repopulating the cleared map. Selections are persisted per runtime + root, and `useEffectiveGitDirectory(root)` resolves the directory git surfaces operate on (the selected nested repository when there is one, `root` otherwise). Picking the root itself in the picker removes the selection instead of storing the root. A selection whose repository fails its probe is dropped and remembered session-only (`staleClearedSelections`) so auto-select does not re-pick it and loop walk+probe; manual picker picks bypass the memory. `hooks/useNestedGitDirectory.ts` owns the resolution flow (root probe, discovery, auto-select only for a root that is no repository, stale-selection recovery, the picker's `repositoryOptions`: the root first when it is a repository, then the discovered ones, then — once a repository is selected — that repository and the ones discovered under it, so the list grows one level per selection and never loses the level above it) for every consuming surface (Git tab, diff view, pull-request view, walkthrough view, mobile changes, work-status project readout), and `git/NestedRepoResolutionStates.tsx` renders the shared pending/failed/unsupported/empty states. The context rail's Git badge reads `useEffectiveGitDirectory` with the same root the Git tab passes, so it counts the repository the tab shows; it reads a remembered nested selection's status itself, once and again on each refresh hint for the root or that repository, since nothing else does until a git surface opens (agent-tool hints carry the session directory, which is the root)
- worktree bootstrap polling and session/worktree machinery stay keyed on the project root even while a nested repository is selected; only git data and actions follow the selection
- runtime reset replaces all live entries with that runtime's persisted branch seeds and invalidates old completions
- status, branches, log, identity, repository probes, and prefetch diffs commit through runtime and per-channel generations
- status mutations advance a revision so older refreshes cannot undo optimistic or confirmed index changes
- a successful status-affecting git mutation also advances that revision: the HTTP adapter's cache invalidation notifies the store through `lib/gitStatusInvalidation.ts` (the VS Code bridge adapter has no client-side status cache, so it emits nothing today)
- `fetchStatus({ force: true })` and `fetchAll({ force: true })` cross both the store and runtime transport caches; a forced reconciliation must reach the active runtime rather than reuse an unexpired browser status snapshot
- status requests do not start while a managed worktree bootstrap is pending, and a response admitted before bootstrap began is discarded if it completes after the directory enters `pending`; the `--no-checkout` population window is not user working-tree state
- branch persistence is versioned, bounded, runtime-scoped, and claims the ambiguous legacy cache once
- diff data has per-directory and aggregate count/UTF-8-byte limits; oversized single entries are rejected

#### Why an established root still discovers what is below it

A `git init` above real repositories (Initialize Git, a terminal, an agent) used to make the empty root win: discovery stopped, a nested selection stopped applying, and every git surface showed a history-less root with no way back (#4886). Such a root now resolves like a non-repository root, except that the picker lists the root first and auto-select never picks for it: the root is a repository the user may have created on purpose, so leaving it is the user's pick.

An established root keeps that picker for the same reason: a submodule is a repository under the project that the Git tab cannot otherwise reach, and the picker is the only place to switch to it. Choosing a submodule is explicit — auto-select never picks for a root that is a repository — and picking the root removes the selection. Discovery remains bounded, so a repository the scan does not reach is not listed. The rejected alternative was treating a discovered repository as the default for an established root: the root's own changes and history would vanish from every git surface on open. VS Code has no discovery route, so it keeps the earlier behavior.

#### Why automatic selections are not persisted

`autoNestedRepoSelections` marks guesses made with `selectNestedRepo(root, repository, { persist: false })`. Every persistence write excludes them, including writes for another root. The hook drops a guess once the root has its first commit; an unborn root retains it. Only explicit picker choices survive that transition and a restart.

The selection envelope uses version 2 under the existing storage key. Version 1 mixed automatic and manual choices with no intent marker, so it is discarded on read. Users can pick again, and non-repository roots discover again. Restoring those ambiguous records as explicit choices would make a committed root open an unrelated child after upgrading.

Surfaces with `recheckOnOpen` force discovery for both the project root and the selected repository on opening. A terminal can add a repository without emitting an invalidation event, so a cached empty or failed answer cannot be final. There is no polling while the surface stays open.

#### Why auto-select skips repositories inside a dot-directory

With nothing selected, the resolution flow used to auto-select the first discovered repository. For a folder that is not a repository but contains tool installs, discovery's first entry is a dot-directory (`~/.oh-my-zsh`, `~/.cache/...`), so opening a home directory attached the git surfaces to an unrelated repository the user never chose (#5357). Auto-select now takes the first candidate whose path carries no dot-segment, and picks nothing when every candidate is hidden: a repository under a dot-directory is tooling that happens to contain a `.git`, never the repository the user opened the folder for. Discovery and the picker are unchanged — hidden repositories are still listed and can be selected by hand — so the only thing given up is a guess. A wrapper folder with one visible checkout keeps opening straight into it. The rejected alternative was a global or per-project switch to disable nested discovery: it answers the same complaint with a setting every user would have to understand, while the picker already offers the choice this one would. The home directory itself is never searched (`discoversNestedRepos`): a project there exists to hold chats outside any project, the repositories under `~` are installs and unrelated checkouts, and the walk is slow, so its git surfaces show the plain not-a-repository state.

Diff prefetch admits at most two outstanding transport requests per runtime and directory across overlapping batches. Its 15-second deadline stops waiting for a result; it does not cancel server work. A timed-out request retains its path and concurrency slot until the transport settles, including across cache resets, so later batches cannot repeat it or exceed the limit. Saturated prefetch skips further work instead of queueing retries. Late timed-out results never enter the cache, and successful or rejected transport completion releases capacity. Duplicate or saturated demand does not invalidate a batch already running. The Git view schedules prefetch only while active; explicit file opens remain independent of background prefetch capacity.

`useGitIdentitiesStore.ts` owns the active runtime's author profile inventory, global author summary, default author, and temporary selection. Runtime endpoint reset clears all of them synchronously. Every load and mutation captures the runtime key and store generation before awaiting; profile mutations also carry per-profile generations, so a completion from another runtime or an older same-ID edit cannot publish. Profile responses pass the shared strict public DTO parser and cannot contain legacy authentication fields. In VS Code the webview adapter keeps profiles in webview memory for the lifetime of the view; neither the store nor the extension host persists them.

### Tracker stores

`useTrackerAuthStore` holds each tracker's auth status, keyed by tracker id (Linear today); the trackers themselves come from `lib/trackers/registry.ts`. `refreshTrackers(apis.trackers)` reads the registry, then every served tracker's status, where source-control auth is refreshed (`App.tsx`, `MobileApp.tsx`); VS Code has no trackers. A failed status read keeps the last status with its error and leaves the tracker unchecked, so it is retried instead of reading as disconnected. Trackers are signed in on the instance, so `runtimeEndpointReset.ts` drops every status and the registry's list on a switch, and a generation guard keeps an answer for the previous instance out of the new one.

`useSourceBoardStore` remembers, per runtime, the board's project, tab (`repository` or `tracker:<id>`) and each tracker's container (`trackerContainerByProvider`). Data stored before trackers had their own tabs (`tab: 'linear'`, `linearTeamId`) reads as `tracker:linear` and Linear's container.

### Source-control stores

`useSourceControlAuthStore`, `useChangeRequestContextStore`, and the transitional `useGitHubPrStatusStore` own provider-neutral source-control state. Bound status keys include runtime, provider instance, immutable account ID, repository ID, binding revision, directory, branch, and primary remote. Context keys include their directory and change-request identity. Despite its transitional name and legacy display aliases, `useGitHubPrStatusStore` performs network reads only through `SourceControlAPI.changeRequestStatus` with an exact `SourceControlReadContext`; it has no ambient `RuntimeAPIs.github` fallback.

Core model:

- each entry stores:
  - current PR status payload
  - loading / error state
  - whether initial status was resolved
  - refresh timestamps
  - watch count
  - runtime params
  - resolved identity

Important properties:

- `ensureEntry()` initializes a key lazily
- `setParams()` attaches runtime context
- parameter changes advance an entry revision; stale queued, successful, and failed requests cannot update a newer authority
- `startWatching()` / `stopWatching()` are for true live PR consumers only. Nothing polls a watched entry: `noteBranchActivity(directory)` (an agent turn finished there) and `noteWindowReturned()` (answers older than `60s`) refresh it, both wired by `lib/trackedItems/interest.ts`
- `refreshTargets()` supports one-shot multi-target bootstrap without turning on live watching
- an entry's open pull or merge request is a tracked item carrying its provider id and instance, read with the bound account (`getBranchTrackedPull`, `useBranchTrackedPulls`); the server pushes its live state and `applyTrackedPulls` lays it on every entry of that request, skipping entries whose full refresh is newer and leaving semantically unchanged entries untouched.
- PRs, merge requests, issues and discussions linked to sessions (any source-control provider) and tracker work items (Linear issues) are not in this store. A tracked thread is `{ provider, instance, kind, owner, repo, number, accountId? }` (`kind` `pull`, `issue` or `discussion`; a discussion's live state is `{ title, state: open | resolved | outdated | duplicate, answered }`) with an open provider id (`sourceControlProviderIdSchema`, so `linear` never reads as a thread) and a required instance. A tracked work item is `{ provider, kind: 'work-item', identifier }` keyed `${provider}|${IDENTIFIER}`; a Linear record stored before work items had a `kind` reads as one, under the same key, and its live state is `{ identifier, title, state: { name, category } }` (a record in the older `state.type` shape is dropped: it is a cache, and the server answers again). A GitHub thread without `instance` (the only shape that ever left it out, on the wire and in stored records) reads as github.com, so `trackedItemKey` produces the same strings and stored records stay valid. The server follows them (`packages/web/server/lib/tracked-items/`) and pushes changes over the OpenChamber event stream; `useTrackedItemsStore` holds what it sent, persisted for 12 h (at most 300 records, re-parsed on hydration, an older answer never replaces a newer one), keyed by runtime and item key. Surfaces declare what they show with `useTrackedItems` (`lib/trackedItems/interest.ts`), which sends the union only when it changes and again after a reconnect, and reads with `useTrackedPullVisualSummaries` / `useTrackedIssueStates` / `useTrackedWorkItemStates`; `useTrackedIssueStates` reads a discussion as an issue's badge does (resolved is completed, outdated and duplicate not planned), so every issue badge shows one unchanged. Pull and merge request badges go through `getLinkedChangeRequestVisualSummary`, the same colour rule as a branch's PR.
- runtime reset disposes timers, watchers, API references, and request ownership while inert namespaced snapshots remain isolated
- auth and context requests are deduplicated per provider instance and reject completions from an older runtime generation
- context failures preserve the last complete cached result instead of becoming authoritative empty data
- persisted status cache is versioned, TTL-filtered, and bounded for page refresh continuity, not broad background syncing
- status hydration accepts only entries carrying account, repository, and binding-revision authority; legacy entries cannot seed a bound request
- hydration verifies every serialized key authority dimension against the embedded identity; a current-shaped mismatch is discarded rather than re-keyed
- simultaneous bindings for one provider instance retain independent entries; bound selectors require the exact account, repository, revision, directory, branch, and primary remote
- a successful missing or `needs-attention` binding read clears prior status for that directory and invalidates in-flight completion; a failed binding read preserves prior cache
- a closed/merged PR is the branch's history, not live status: it is displayed and persisted, but never treated as authority
- closed/merged associations are read again on the same signals as missing PRs (an agent turn in the directory, a window return past `60s`), so a newer open PR (or authoritative `pr: null`) replaces them without a manual refresh
- hydrate restores a persisted closed/merged PR but resets its `lastDiscoveryPollAt`, so revalidation runs on the first watcher tick after a reload
- a successful refresh that returns `pr: null` replaces any previously cached PR authoritatively; a failed refresh keeps the previous one

`useWalkthroughStore.ts` keys entries, model and language choices, active requests, and progress pollers by runtime plus the full walkthrough target. Working-tree and branch targets need only their Git source. A pull-request target also carries the immutable `SourceControlReadContext` that discovered it, so equal PR numbers under different accounts, repositories, bindings, or provider instances cannot share client state. The client sends that context on every PR walkthrough operation and rejects successful read or generation responses unless they echo the exact authority tuple. Runtime reset aborts active requests, stops pollers, and clears pending entry-point targets before the new endpoint can reuse them.

## Ownership Rules

These rules are important. Breaking them tends to reintroduce idle CPU churn, stale UI, or rerender fanout.

1. No broad `directories` or `entries` subscriptions in normal UI components.
2. No root pollers for Git or PR.
3. No broad idle sweeps across many directories.
4. Prefer store `ensure*` methods over direct runtime API calls from views.
5. Visible consumers should drive refresh. Hidden consumers should not.
6. Header should not depend on PR store.
7. A closed context panel (or hidden git surface) should not create live PR work.
8. File tree Git status should update only when the file tree is visible.
9. Global session refresh must remain bounded and failure-isolated per directory.
10. Global session cache must not drive live activity indicators or message-loading state.

### Configuration stores and the Settings directory

`useAgentsStore`, `useCommandsStore`, `useSkillsStore`, `useMcpConfigStore` and
the provider half of `useConfigStore` describe directory-scoped configuration.
Provider and agent catalogs use the actual worktree directory when selected;
the parent project still supplies its OpenChamber project defaults.
Two surfaces read them at once: the app (chat, autocompletes, pickers), which
wants the active project, and Settings, whose own project selector may point
somewhere else.

Each of them therefore keeps two things:

- a per-directory map (`agentsByDirectory`, `commandsByDirectory`,
  `skillsByDirectory`, `serversByDirectory`, `directoryScoped`);
- a flat mirror (`agents`, `commands`, `skills`, `mcpServers`, `providers`) that
  tracks the **active** directory only.

`config-store` hydrates provider catalogs only for the matching runtime, and only from blobs written before the selections-only format (persist version 1), which carry no catalogs and are never treated as incompatible. Since 1.x and 2.x used the same unversioned key, a cached list whose models lack 2.x variant arrays is discarded for its directory and marked unloaded; the active mirror is checked separately. Valid 2.x lists, other directories, agents, and saved model and effort selections remain available. A successful provider read replaces the discarded list.

A project whose OpenCode config OpenCode rejects (`ConfigInvalidError` and the
other `Config*Error` names) is recorded in `useConfigStore.projectConfigErrors`,
keyed by config directory, runtime-only. `loadAgents` stops retrying on it and a
successful load clears it. `initializeApp` treats it as that project's failure,
not the app's: startup completes so other projects stay reachable, and
`ProjectConfigErrorToast` shows the file and message while that project is
active.

Any other failed `initializeApp` attempt records `lastInitFailure` (runtime-only,
cleared on success and on runtime switch): which step failed —
`serverUnreachable` (no answer or a gateway error), `openCodeUnavailable` (the
server answered but OpenCode is not healthy), `loadAgents`, or `unexpected` —
plus the error text when there is one. The startup recovery screen reads it, so
only a real network failure tells the user to check that the server is running.

#### What they hold: OpenCode 2 entity shapes

The mutation payloads these stores send are the v2 entities documented in
`packages/web/server/lib/opencode/DOCUMENTATION.md` ("Entity routes (v2
shapes)"). Agents carry `system`, `steps`, `request.body.temperature` /
`top_p`, a joined `provider/model#variant` string and an ordered `permissions`
rule list; commands carry `template` and `subagent`; MCP servers carry
`disabled`, `codemode` and `timeout: { startup, catalog, execution }`.

Two rules follow from the routes:

- **The list is not the config.** `opencodeClient.listAgents` answers OpenCode's
  RESOLVED `AgentInfo` (built-in defaults and global config already merged), and
  the v2 `CommandInfo` carries only a name and a description. Anything that
  edits, duplicates or renames an entity reads its own stored entry instead:
  `useAgentsStore.fetchAgentEntity` / `fetchAgentPermissions`, and the
  per-command `…/config` read inside `useCommandsStore.loadCommands`.
- **A worktree draft reads its first session's folder.** A project
  opened on a folder of its repository keeps its commands in that folder, and a
  worktree draft's directory is the worktree root. While the draft's start
  folder is resolving, the composer lists and requests nothing
  (`resolveCommandDirectory` returns `pending`). Once the folder resolves, or
  falls back to the root, commands, skills and file search read that folder,
  the same folder its agents come from. Only the composer that shows the draft maps it;
  a pinned column keeps its own session's directory. The draft's directory stays
  the root, because the target picker matches it.
- **`request` and `permissions` are replaced wholesale by a PATCH.** A caller
  must send the full block it wants persisted; sending only the field it changed
  drops the rest.

Config reads also report `legacy: true` when the entity's file still uses v1
spellings, and mutations answer with the `path` they wrote. The stores surface
`legacy` and `path` on the entity so a page can show the quiet note; no file is
ever moved.

Thinking variants keep the effective value in `currentVariant` so existing send
paths capture a stable configuration. `currentVariantSelection` says where that
value came from: a string is an effort chosen in the picker or by the shortcut,
`null` is an explicit `Default`, and `undefined` is automatic initialization,
which lets the inherited default apply.

An effort belongs to the model it was set for (issue #4601). A configured
effort is inherited only by the model configured next to it:
`getDefaultVariantForModel` returns the project effort for the project model,
the settings effort for the settings model, and nothing for any other model. An
agent's effort applies only on the agent's own model. `setProvider` and
`setModel` drop `currentVariantSelection` when the model changes, explicit
`Default` included, so the composer resolves the new model's effort from this
session's saved choice for it, else its configured default, else no effort. The
picker's tooltip names an inherited effort as the model's default; only the
`Default` option itself is shown muted.

`Default` sends no effort at all: OpenCode's `ModelRef.variant` is an optional
string and rejects `null`, so `toModelRef` (`lib/opencode/model.ts`) turns the
`null` into a model reference without a `variant` at every OpenCode call that
takes one. It cannot resolve back to the inherited
default: the settings default would take effect again, and the next assistant
reply echoes that effort back as an explicit choice, so the picker jumps off
`Default` one message after the user chose it. For the same reason the
per-session selection store records an explicit `Default` (as `null`) instead of
clearing the entry — a cleared entry is indistinguishable from never having
chosen, and the settings default wins again on the next agent or session switch.

Only a place where the user chose may write `null`. Restore paths — message
history, a preserved manual override — pass their own "found nothing" through
as `undefined`, because a session whose history carries no effort is not a
session where `Default` was picked. A restore that manufactures `null` latches
the session onto `Default`: `null` outranks the agent and settings defaults by
design, so the concrete effort it displaced can never come back.

Every write of `currentVariant` writes `currentVariantSelection` with it. They
are one selection; updating only the effective value leaves the picker showing
one effort while sends carry another.

Every loader and mutation takes an explicit directory; omitting it means the
active project, which is what non-Settings callers pass. A load for another
directory writes the map and leaves the mirror alone, so browsing another
project in Settings cannot change what chat sees. Components select through
`selectAgentsForDirectory` / `selectCommandsForDirectory` /
`selectSkillsForDirectory` / `selectMcpServersForDirectory` /
`selectProvidersForDirectory`, which return stored arrays.

Command discovery compares responses only with the requested directory's cache.
A first successful response always creates that entry, even when empty or
identical to another project's commands. Cached and unchanged loads restore the
active-project mirror; asynchronous completions check the active directory at
commit time. Failed loads leave the current cache untouched. Discovery passes
its directory directly to the SDK wrapper without changing the client's shared
directory context.

Settings resolves its directory through `useSettingsDirectory`, backed by
`useUIStore.settingsProjectPath`. That selection is Settings-local and not
persisted: it follows the active project until the user picks another one. The
Settings project selector must never call `setActiveProject` — that relocates
the chat, the session list and the file tree.

Failure is still not empty: a failed load restores that directory's previous
list rather than clearing it.

### Model metadata

The model details use a valid runtime release timestamp as the release date,
formatted as a UTC calendar day. Localized display of a date-only release
keeps that UTC calendar day. Missing, zero, invalid, or out-of-range
timestamps do not produce a date. An exact catalog entry can supply the date
when runtime time is unknown. Its existing limit fallback remains in effect
when OpenCode reports no context window.

Month-only knowledge cutoffs (`YYYY-MM`) also use UTC when localized, so
negative timezone offsets cannot move the cutoff into the previous month.

Custom-provider entries can borrow knowledge cutoff, release date, and last
updated values from the default catalog. Model canonical provider takes
precedence over provider canonical, and lookup uses the actual modelID.
An explicit canonical miss stays unknown. With no canonical identity, a
complete modelID may match only one catalog entry; ambiguous IDs stay unknown.
Runtime pricing, limits, capabilities, identity, and name are never borrowed
through this fallback.

### Why custom-model matching stays exact

Display names, family, and stripped prefixes or suffixes do not establish
model identity. An unknown Fast alias stays unknown, while a derived Fast
entry with a known actual modelID can receive descriptive dates and keep
its own gateway price.

### Switched-off skills

`skillsByDirectory` is the installed inventory and keeps a skill a policy
switches off; Settings lists it with an "Off" mark. Everything the chat offers,
attaches or resolves (`/` and `$` pickers, the send path, `/name` routing in
`session-ui-store`, draft starters, the session context count) reads
`selectAvailableSkillsForDirectory`, which drops the skills whose deciding
`integration.use` statement is a deny (`skillSwitch.ts`). The statements come
from OpenCode's `/api/config`, read beside each skills load into
`policiesByDirectory`. A failed read keeps the last ones, so an outage never
turns a switched-off skill back on; a directory whose statements were never
read has no entry (unknown, which Settings shows as such) and its next load
reads again instead of caching the list as fresh.

`setSkillEnabled` changes nothing until the server has written the file, and
fails when the server wrote nothing although the outcome should change (the
rule sits in a file it cannot parse, or in config with no file). It then
shows the write at once and reads OpenCode's statements again until its file
watcher has applied it. A user skill's rule is in the global config, so the
write is shown in every loaded directory, which reads again on its next load.
A load or recheck started before a newer write is not committed
(`skillSwitchWrites`), so the switch never snaps back to an old read.

A skill's id is its folder, so a rename changes it: `renameSkill` carries a
switched-off skill's rule to the new id, and deleting every copy of a skill
removes its rule. Otherwise the renamed skill would come back on, and the
old rule would keep a row (`keepSwitchedOffSkills`) for a skill that is gone.

## Selector Rules

Use leaf selectors.

Good:

- `useGitStatus(directory)`
- `useGitBranches(directory)`
- `useGitBranchLabel(directory)`
- `useGitRepoStatusMap(directories, enabled?)` (disabled holds its last result)

Bad:

- `useGitStore((state) => state.directories)` in feature components
- `useGitHubPrStatusStore((state) => state.entries)` in feature components
- render-time scans over every PR entry for a single project/group badge

Why this matters:

- Zustand reruns selectors on every `set`
- rerenders are avoided only if the selected result stays referentially stable
- broad subscriptions magnify fanout even when only one directory changed

## Performance Rules

### 1. Preserve references for unaffected entities

If directory `A` changes, directory `B` should keep the same derived reference where possible.

### 2. Keep loading state per entity

Do not add new global `isLoadingWhatever` flags for keyed cache work.

### 3. Avoid hidden work

If a surface is not visible, it should not keep refreshing Git/PR state.

Examples:

- `PullRequestSection` may watch a PR while visible
- `SessionSidebar` may bootstrap missing PR data for expanded visible groups
- hidden sidebar should not watch PRs

### 4. Prefer one-shot event hints over polling

Example already in use:

- successful mutating tools emit a centralized Git refresh hint through `sessionEvents`
- visible `GitView` / `DiffView` consume the hint and refresh current-directory status

This is preferred over background polling.

### 5. Treat `diffStats` carefully

`GitStatus.diffStats` may be omitted by light status fetches.

Rules:

- do not erase richer existing `diffStats` with a lighter payload
- if a UI surface requires per-file `+/-` stats, it must ensure a full enough status payload exists

### 6. Keep diff cache bounded

Diff cache has explicit limits because large repos can otherwise blow up memory.

Do not raise limits casually.

## Refresh Model

### Git

Expected model:

- `GitView` / `DiffView` ensure current-directory Git state when visible
- the Git view gates its status-derived content and actions while a managed worktree bootstrap is pending, then keeps the gate closed until one forced fresh status read succeeds; refresh failure exposes retry without revealing the cached bootstrap snapshot
- explicit Git actions refresh status/branches/log as needed
- every status-affecting git mutation invalidates the HTTP adapter's status cache on its success path (failed mutations invalidate nothing), so the follow-up refresh is authoritative instead of the pre-mutation cache entry
- the sync event handler issues one Git refresh hint when a live file-mutating tool first reaches `completed`; this does not depend on `ToolPart` mounting, and duplicate terminal events do not replay the hint
- tool hints are coalesced per directory: the first completion opens a 250 ms window and every completion in that directory during it is answered by one pathless hint at its end, so a burst of parallel or back-to-back tool calls costs one status read. Direct hints (editor saves, reverts, explicit actions) are delivered at once. A runtime switch drops hints still waiting (`sessionEvents.cancelPendingGitRefreshes`)
- every Git refresh hint invalidates the store request generation and the HTTP status cache before visible consumers request status, so they share one post-mutation read instead of accepting a cached or pre-mutation response
- the new-session draft target re-reads its branch list and worktree topology when the window regains focus or becomes visible and when its branch picker opens, throttled to one read every two seconds; the composer is visible only in that state, so a hidden surface does no work and no timer polls
- a successful dirty save from the in-app file editor issues a path-scoped Git refresh hint; clean autosave checks remain no-ops
- refresh hints with authoritative file paths invalidate only those cached and currently rendered diffs before status refresh; pathless tools request status reconciliation without broadly remounting DiffView
- targeted diff remounts preserve the user's current file-section anchor and intra-file offset before paint instead of resetting the stacked view to the top
- no root-level background Git polling

### PR

Expected model:

- `PullRequestSection` is the only true live PR watcher
- `SessionSidebar` may do one-shot bootstrap for expanded visible project/worktree groups if PR info is missing
- sidebar bootstrap reads the authoritative repository binding for each demanded directory; missing and `needs-attention` bindings issue no status request
- sidebar status keys include the bound account, repository, revision, provider instance, and primary remote, so rebinding cannot overwrite or reuse another authority's result
- source-control status and detailed-context caches use soft count targets: watched or loading entries remain protected, and failed unique-context churn evicts older inactive entries instead of growing without bound
- no live PR work for header: the visible Git view asks once for its branch's status through `useBranchPullRequestRequest` (TTL-deduped, no watching), which feeds the header chip
- no background PR sweeps outside visible demand

## Known Intentional Fallbacks

There is still one explicit fallback path worth knowing about:

- `SessionSidebar` may call `checkIsGitRepository(...)` during initial worktree/project discovery when store state is not populated yet

This is currently acceptable as a narrow bootstrap fallback.

Do not widen it into a polling or broad refresh system.

## When Editing These Stores

Before changing store shape or selectors, ask:

1. Is this keyed by the right identity (directory, branch, session, root)?
2. Will this force unrelated consumers to rerender?
3. Should this be visible-demand-driven instead of background-driven?
4. Is there already a store cache for this data?
5. Am I duplicating fetch ownership in a component when it should live in a store action?

## Validation Checklist

After meaningful Git/PR store changes, verify manually:

1. Idle desktop app stays quiet on draft/chat screen.
2. Git view still loads status, branches, log, identity.
3. Diff view still opens the correct file and stays in sync.
4. Worktree sessions still show branch labels in header.
5. Expanded sidebar projects/worktrees can show PR state without requiring prior selection.
6. Hidden surfaces do not reintroduce live background work.
