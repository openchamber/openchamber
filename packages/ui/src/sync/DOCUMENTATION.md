# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Directory-scoped sync stores**
   - Owned by the sync layer child stores created in `sync-context.tsx`
   - Source for per-directory live session/message/part/permission/form state
   - Backed by SSE / directory-scoped polling
   - Read via hooks like `useSessions()`, `useDirectorySync()`, `getSyncSessions()`, `getDirectoryState()`

2. **Global sessions cache**
   - Owned by `packages/ui/src/stores/useGlobalSessionsStore.ts`
   - Shared source of truth for the Sessions sidebar global lists and Session Retention cleanup
   - Holds:
     - global active sessions
     - global archived sessions
    - active and archived entities indexed by ID
    - active root, parent/child, and directory indexes

These two scopes are intentionally different, but they are no longer equal peers for live UI truth.

### Why both exist

The directory-scoped sync stores are **not** a complete global view.

- They are created lazily per directory
- They only contain data for directories initialized in the current app session
- They are optimized for live per-directory domain data
- They do not maintain the complete global active+archived session view needed by the sidebar and retention settings

So:

- Use the **directory sync stores** for per-directory live session/message state
- Use the **global sessions store** for cold/global session coverage (especially archived pages and unopened directories)
- Use **aggregated child-store sessions and the global live status index** for live truth across initialized directories

Directory bootstrap publishes session pages incrementally. A partial page only
adds or updates records and leaves `sessionListSource` unchanged. Live mutations
newer than the load's baseline revision take precedence on every page. The final
complete list alone sets authoritative coverage, reconciles missing sessions,
and updates the root total. A later-page failure preserves the pages already
published without claiming a complete snapshot.

## Cleanup after a runtime switch

Draft creation captures its cleanup owner before creating a session or chat
folder. `lib/runtime-cleanup.ts` keeps direct HTTP cleanup on that owner's URL
and credentials, bypassing the active runtime's fetch bridge. Chat cleanup
accepts only descendants of the roots captured from that owner and never a
shared root. Session cleanup uses the SDK with the captured transport and
directory header.

Relay and same-origin cleanup waits until the owner returns. Failed cleanup
stays in an in-memory queue and retries on that owner's endpoint-change event
with fresh credentials. The queue does not survive a page reload.

### Why cleanup captures transport separately from the SDK client

A cached SDK client still resolves authentication and transport at request
time. Keeping the client alone can send a rollback to the newly selected
server, or omit the old server's credentials. Only rollback captures transport;
ordinary feature requests continue to resolve the active runtime at call time.

## OpenCode compatibility before bootstrap

The desktop/web/VS Code App entry and MobileApp entry wrap the application in
`OpenCodeCompatibilityGate`. The application mounts at once and starts while the
check runs; the web/desktop entry (`main.tsx`) starts the check at page load,
alongside authentication, and the gate asks again when that early read failed
(a server that still wanted a sign-in).
Electron first asks the native host for the embedded managed CLI preflight.
It shares the lifecycle's pending or successful version check, so the gate starts
the app without another version request and without waiting for server health.
The verdict is scoped to the current API endpoint and is never persisted.
All other cases use the OpenChamber-owned `/api/opencode/compatibility` endpoint;
it does not depend on a healthy OpenCode server or successful session bootstrap.
Native mobile keeps the gate disabled (`enabled={false}`) until a server is
selected. The gate stays in the tree either way: switching it on or off never
remounts the application, because a remount on every connect re-runs the
mobile cold-launch re-probe.

A confirmed incompatible version unmounts the application, removes the HTML
splash, and shows recovery. There is no session/event polling behind that
screen. Unknown versions and failed compatibility reads hand control
to the existing connection recovery instead of claiming the CLI is v1.
Runtime changes invalidate pending results and require a fresh check.

Recovery offers the host's `canInstall` capability as Update to OpenCode v2.
The install action uses `/api/opencode/install-v2` and waits for installation,
version verification, and restart before reloading the UI. Check again refreshes
a confirmed incompatible version without reporting an operation failure or restarting.
Failed or unavailable checks preserve the known incompatible state and show an error.
When v2 is confirmed, Check again invokes the existing `/api/config/reload`
runtime operation before reloading the UI.
Failures keep the recovery screen visible with retry and the installation guide.
Bundled OpenCode points to an OpenChamber update; external runtimes and Windows
use manual installation. Host-side rules enforce the capability independently
of button visibility.

## Ownership map

Queue delivery uses `hasActiveSubagent` with an explicit parent resolver over
the cached sync session index. This keeps the 8-level ancestor walk shared
with display activity while leaving the global display resolver unchanged.
The VS Code queue gate and its live inputs are documented in
`../stores/DOCUMENTATION.md`.

| Layer / Store | Owns | Scope |
|---|---|---|
| `ChildStoreManager` and child directory stores | Priority-scheduled directory bootstrap plus `session`, `message`, `part`, `permission`, `form`, etc. | One runtime and one store per directory |
| `SessionMessageLoader` | Initial message loading, pagination, prefetch, retries, load state, and optimistic reconciliation | One runtime, directory, and session ID |
| `global-session-status.ts` | Incremental non-idle session status index reconciled from events and authoritative directory snapshots, plus a reference-stable active-ID membership collection maintained from the same mutations | All known directories in the active runtime |
| `session-ordering.ts` | Ephemeral lifecycle rank used by every user-visible session list | All known sessions in the active runtime |
| `session-activity-timing.ts` | Elapsed time of the running turn and of the turn that just finished, plus the persisted starts that survive a reload | All known sessions in the active runtime |
| `session-ui-store.ts` | Session selection, draft lifecycle, one-shot draft-materialization transition identity, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active/archived entities plus root, parent/child, and directory indexes | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `attachment-files.ts` | Attachment picker allowlists, MIME/content validation, structured-text sanitization, and HEIC conversion | Local chat attachments across shared UI runtimes |
| `document-attachments.ts` | Bounded Office/OpenDocument extraction, document text serialization, embedded-image extraction, and positional citations | DOCX, PPTX, XLSX, ODT, ODP, and ODS chat attachments |
| `input-store.ts` | Draft input state, attached files, synthetic parts, pending guest attach, destination-scoped fork replay handoff, the address the composer publishes (inline drafts and attachments) | Attachments and fork replay target runtime + directory + session; the published address is the composer's own session or `/btw` fork; other pending input is app UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

Pending text keeps column insertions and session-keyed restores in separate
mailboxes, so a quote or plugin insertion cannot overwrite a waiting revert.
A pinned
column and its expanded BTW share the column address; only the composer showing
the restored session may consume session-addressed text. Attachment appends to
named slots preserve other in-flight appends; replacement, clearing and owner
switches retain their read-cancellation behavior.

### Why restores have a session-keyed mailbox

A parent revert can wait while BTW owns the composer and receives more text.
A single pending-text slot lost the restore on the next insertion. Each session
keeps its latest restore until its composer consumes it; a failed revert rolls
back only that session's entry. An annotation captures the published inline and
attachment address together at attach time and keeps both through screenshot
preparation, including when the callback was saved before a BTW transition.

Local chat attachments are normalized by `attachment-files.ts` before entering `input-store.ts`. PNG, JPEG, GIF, WebP, and PDF retain their media type; HEIC/HEIF is converted to JPEG; recognized text/code formats and unknown files whose first 4 KB are text are sent as `text/plain`; binary files outside the supported media types are rejected. Jupyter notebooks become readable markdown with non-text outputs omitted. HAR credentials, cookies, and sensitive URL parameters are redacted, while request/response body text is omitted. SVG and Draw.io files are attached as source text, not executable/rendered content. Browser and VS Code pickers expose the same allowlist, while drag-and-drop may still accept an unknown extension after content inspection. Large plain-text clipboard pastes can become in-memory `text/plain` attachments named `pasted-context-N.txt` through the composer paste path; they use the same normalization and send pipeline as manually attached `.txt` files.

Office and OpenDocument packages are metadata-validated before asynchronous extraction, with limits of 20 MB compressed input, 5,000 archive entries, 25 MB per entry, 8 MB per XML part, and 100 MB total uncompressed content. Unsafe or non-canonical archive paths reject the whole attachment, and only XML, relationship, and supported image entries are decompressed and retained. Extracted text, including its explicit truncation notice, is bounded to 500,000 characters so compact but dense Office files cannot consume an entire model context window. XLSX dense rows are serialized as quoted TSV under a single source range instead of repeating every cell address; highly sparse rows retain explicit cell coordinates so distant cells do not generate vast empty TSV spans. Confirmed Office/OpenDocument `@file` mentions are loaded through the runtime filesystem route before submit and use this same extraction pipeline instead of being forwarded as `text/plain` `file://` parts that OpenCode rejects as binary. Confirmed PNG, JPEG, GIF, WebP, and HEIC/HEIF mentions load through the same route and attach like a picked file, with their real type and a data URL, so the message shows the image and the model receives its bytes (`isReadOnSendMentionFilename`). PDF mentions stay `file://` references: OpenCode reads them itself, and a model without PDF input can still extract the text with tools. A failed mention load or extraction leaves the composer intact, and a runtime switch discards preparation from the previous runtime. At most 50 signature-validated PNG, JPEG, GIF, or WebP images and 40 MB of image bytes are retained, with a 20 MB per-image limit; unsupported, invalid, omitted, and truncated content remains explicit in the extracted text. Images whose citations fall beyond text truncation are not attached. Extracted document content remains a `text/plain` file attachment with the original document filename, rather than becoming visible user-message text. Supported embedded images become separate image file parts; the extracted text contains `[filename]` citations at the source paragraph, slide object, spreadsheet cell anchor, or OpenDocument text position. Generated image filenames are re-evaluated if the composer changes during asynchronous preparation, avoiding collisions. The store publishes all generated parts atomically only after every data URL is ready.

The composer compares normalized attachment MIME types with the selected model's declared input modalities. It warns when a newly attached file or an existing attachment after a model change requires an unsupported modality, but does not block sending. Missing modality metadata remains unknown and does not produce a warning.

Attachment drafts stay in memory for the page's lifetime, including composer remounts, independently of text persistence. `selectAttachmentDraft` saves the outgoing list and restores the rendered composer's runtime, directory, and session before paint. Switching cancels unfinished attachment reads. Send and queue recovery pass their captured draft identity so a late failure restores files to the source rather than the currently open session. Clearing or deleting a draft releases only its files. Opening a new-session draft leaves the outgoing session's files available for a return visit. With a chat pinned in the side panel two composers are on screen; each shows its own draft's files (`useDraftAttachedFiles`) and the selected slot follows the composer the user works in (composer documentation, *Pinned composer*).

## Catalog changes apply live

Worktree drafts keep their checkout root as target identity and expose a separate
pending or resolved start folder to composer discovery. Runtime switches retire
the outgoing resolution. Restoring a pending draft resolves its folder again,
preserving its model and agent picks; runtime, draft and revision guards reject
obsolete completions. Confirmed session directories outrank worktree metadata
when resolving composer configuration and file search.

OpenCode v2 watches its own config files and rebuilds agents, commands, skills,
MCP servers and plugins by itself, announcing each rebuilt slice
(`config.updated`, `agent.updated`, `command.updated`, `skill.updated`,
`plugin.updated`, `credential.*`). `events.ts` translates all of them into one
`catalog.updated` sync event carrying a `kind`, and `reloadCatalog` re-reads
that slice. The event carries the location OpenCode rebuilt, so for the project
being worked in it arrives through that directory's reducer (`onCatalogUpdated`)
rather than the global branch; both schedule the same reload. Nothing in the UI asks the user to apply or restart anything: the
only setting OpenCode cannot pick up on its own is which binary runs, and
Settings → OpenChamber → OpenCode CLI owns that restart.

One saved file produces a burst of events, so the kinds are collected and
re-read once the burst settles (250 ms). A `config` rebuild first clears the
client's config cache, otherwise the refresh would be answered from the copy
cached seconds earlier. A re-read that returns an identical list keeps the
objects already in the stores, so nothing re-renders.

Catalog events retain the locations that raised them while the burst settles. Global events and directory-store callbacks schedule the same refresh, including when the event's location already has an open child store. The Settings agent store refreshes those locations together with the ambient project. The batch belongs to the runtime and SDK that received it, and obsolete batches and responses cannot publish after a switch or reconnect.

**The model list.** OpenCode 2.0.8 removed the `catalog.updated` storm and
replaced it with `provider.updated` and `model.updated`, which it publishes
only when the list they name actually changed; `events.ts` translates them into
the `provider` and `model` catalog kinds. The config change that declares a
provider in `opencode.json` and a credential change (a login or logout) still
trigger a re-read as well, because OpenCode recomputes those two snapshots from
integration and credential events only: a provider plugin that fetches its
models from the provider after a login (Copilot, LM Studio) lands later and
announces nothing. That is why the Settings and composer stores read the list a
second time `PROVIDER_REREAD_AFTER_CREDENTIAL_MS` after a credential change.

| Kind | Sync child stores | Settings/composer stores (`stores/catalogRefresh.ts`) |
|---|---|---|
| `agent` | — | agents store + config-store agents |
| `command` | — | commands store |
| `skill` | — | skills store + skills catalog |
| `plugin` | — | plugins store |
| `config` | `config` per named directory (plus `emitSyncConfigChanged`) | agents, commands, skills, MCP config, plugins, config-store providers |
| `provider` / `model` / `credential` | — | config-store providers (model-metadata cache invalidated; the current list stays until the new one lands; `credential` reads twice) |
| `project` | global project list | — |

## Compaction records

A compaction is one `compaction` message. `session.compaction.started` inserts
it as `running`; `session.compaction.delta` appends to its `summary` while
OpenCode writes it (the event names only the session, so the reducer finds the
newest running compaction itself); `session.compaction.ended` / `failed`
settle it. The settled event carries no input id, so the reducer keeps the
running record's id and creation time instead of adding a second record, the
way OpenCode's own message store does. A delta replaces the session's message
array, so it clones the `message` slice like `message.updated` does. The
timeline notice shows the summary as it grows (open while it streams only when
"Expand reasoning while it streams" is on) and collapses it behind a toggle
once settled.

## A location's services going away

OpenCode caches the service graph that serves a directory and drops it after
an hour of inactivity, or when something asks it to reload. It announces that
as `location.shutdown` for the directory. Session records and messages live in
OpenCode's database and stay valid; the live state read from that graph does
not, so `handleEvent` bootstraps the *selected* directory again (reason
`location-shutdown`, forced) instead of patching it. Background directories are
deliberately left alone: re-reading them would recreate the services OpenCode
just evicted and turn every idle directory into an hourly refresh loop. They
are re-read when selected or on the next `server.connected`. Their held MCP
status is forgotten (`useMcpStore.forgetDirectory`): OpenCode announces an
`mcp.status.changed` for each server it stops, and re-reading a held status
then started the directory again within a second of every release. The pending
permissions and forms OpenCode rejected on the way out and the turns it
interrupted arrive as their own events.

The selected directory is bootstrapped at once only while the window is visible
and focused. With the window hidden or unfocused it goes into
`dormantLocations` instead: no bootstrap and no MCP status re-read until the
window is focused again, which bootstraps it and refreshes its held status. If
the user moved to another directory meanwhile, its status is forgotten like a
background directory's.

### Why the selected directory waits for the user and not for nothing

Bootstrapping on every shutdown kept an app left open overnight in an hourly
loop: OpenCode evicted the idle location, the bootstrap read it within
milliseconds, and the location started again with every MCP server, each remote
one going through OAuth with an expired token. Waiting for the window to be
focused costs only a few seconds of MCP startup when the user returns. A
hidden-only check was rejected because a desktop window behind other windows
stays visible all night.

Every managed chat, worktree and project has its own directory, so each one
opened would keep its own set of MCP servers for that hour.
`location-release.ts` releases a directory's location
(`DELETE /api/debug/location`, the route the worktree removal paths already
use) after the selected directory moves away from it: 30 s for a chat, 5 min
for a worktree and 15 min for anything else, a project above all. The user
comes back to worktrees through the day and to projects most, and a return
after a release waits for the MCP servers to start again. A worktree is
a path listed in `availableWorktreesByProject` that is not a project root. It
checks again at that moment and keeps the location while the directory is
selected again, shown in a side panel, has a busy or retrying session, a
pending permission or form, a recap and suggestion the server is still to
write, or a running background command; a busy directory is re-checked at its
own delay until it settles or is selected. The server writes a session's recap
a minute after its turn ends and reads the session's directory to do it, so a
chat left right after an answer would be started again by that read. The
server announces both ends of that wait (`openchamber.session-assist`,
`pending-session-assists.ts`), whether the assist was written, skipped, failed
or dropped by a new turn; the end re-checks the waiting directory at once. A
wait whose end this client never hears stops holding the directory after five
minutes. With the recap and the suggestion off nothing waits. A directory
without a store is left to OpenCode's own sweep. The directory the user is in
is never released, and the server's reads without a directory of their own go
to that same directory (`noteCurrentDirectory` in the server lifecycle), so a
left project is not started again by them. Another client still showing the directory gets
`location.shutdown` and bootstraps it again, which restarts its MCP servers. A
failed release is ignored: OpenCode's own sweep still applies. The rule is the
same on every surface; VS Code includes managed Chats in windows without a
workspace folder.

## Committing a revert

A staged revert is a marker (`session.revert.messageID`); the transcript
keeps the reverted messages and hides them. Reverting or forking from a user
message cuts at the first of the synthetic context carriers right before it,
so the marker can name a carrier: the carriers leave with their message
instead of riding along with the next prompt, and the reverted user message is
the first user message at or after the marker. Sending or compacting past the
marker commits it: OpenCode deletes the boundary message and everything after
it in one `session.revert.committed` event, with no `message.removed` per
record. `events.ts` translates it into a `session.revert.committed` sync
event, which the reducer applies by trimming messages and parts from the
boundary and dropping the marker in one step, followed by the plain
`revert: null` patch the global session list needs. The loaded window is
always the transcript's tail, so a boundary the window does not hold is
older than everything loaded: the reducer empties the window when the store's
own marker names the same boundary and leaves it alone otherwise. A local send
past a revert has already trimmed optimistically, so the event is a no-op for
it; a commit from another client is applied by the event alone. Every commit
also invalidates the session message loader, including a commit that changes
no visible records. This retires in-flight reads, clears deleted optimistic
shadows and prefetch coverage, and prevents an older response or the next empty
fetch from restoring deleted messages. The remaining visible records stay in place
while the loader establishes fresh coverage. Their optimistic shadows remain
until an authoritative snapshot confirms them.

## Forking after an answer

`/fork`, the fork action on an answer, and `/btw` keep the answer in the fork. OpenCode's fork `before` leaves out the record it names, so `transcriptCutAfterMessage` in `transcript-cut.ts` names the next turn boundary, the first record after the answer that starts something new, such as a prompt, a compaction, a background command's result or a workflow report. Without one, ordinary forks copy the whole transcript; `/btw` fails before creating a fork. A locally visible cut may not be persisted yet. All three paths retry a 404 once with the same cut and captured runtime, then propagate the error so the user can try again.

### Why `/btw` requires an explicit cut and retries never widen one

The next prompt can reach the server before the first fork request or between attempts, while this window still shows an idle or empty transcript. An omitted `before` would copy that prompt and its unfinished response into the fork. `/btw` requires an explicit cut from the first attempt; keeping that cut on retry preserves the selected history even when the main chat advances.

If `/btw` has no completed answer or no following turn boundary, it fails before creating a fork and clears its creating flag so the user can retry. This includes idle and locally empty parents: the current API cannot enforce an inclusive upper bound at an answer or an empty server snapshot. Retry once a later turn boundary is loaded. No parent messages are changed.

### Why the next turn boundary and not the next record

The records between an answer and that boundary belong to the answer's turn. One of them is the `idle` record that OpenCode writes when a turn ends. The store gets that record only from a transcript read, never from a live event. A cut at the next record would leave it out of a fork made after a reload and keep it in a fork made from the live transcript.

## An interruption whose reason is `shutdown`

`session.execution.interrupted` carries a reason. `user`, `inactivity` and
`superseded` end the turn: the session records an `interrupted` outcome and
settles idle, which also runs the local interrupted-turn marking below.
`shutdown` is OpenCode itself going away mid-turn; it keeps the execution
claim and resumes the drain after restart, records no outcome and leaves the
assistant message open. The translator emits nothing for it, so the session
stays as it was until the reconnect status snapshot or the watchdog poll
reports the authoritative state.

## Session list rules

Opening a new draft applies its configured model identifier immediately, then
reconciles after project config activation. That continuation belongs to the
same runtime and draft object and yields to a manual choice made while loading.
The config store owns default selection and discovery-gap behavior, documented
in `packages/ui/src/stores/DOCUMENTATION.md`.

Changing a draft's project or switching between Project and Chat applies the
target's agent, model, and effort defaults immediately. Worktree refinement
within the same project preserves manual choices. Activation continuations
check the runtime, draft identity, target revision, and manual-selection state
before applying defaults again.

`selection-store.ts` persists runtime/session-keyed effort overrides alongside model and
agent choices. Both a named effort and explicit `Default` survive reload, with
the same 150-session persistence bound as the existing selections. Old payloads
without effort entries remain valid; malformed effort entries grant no authority.
Session deletion clears these entries. A saved effort choice precedes older
message history so a reload cannot undo an unsent picker change, unless the
session record has since switched to another model and effort. The store also
persists, per session, the session-record agent and model the composer last
followed; a different record value is a newer switch and replaces the pick
(Auto excepted), while an unchanged one keeps an unsent pick
(`packages/ui/src/stores/DOCUMENTATION.md`).
Agent and model switch events stamp the session's `time.updated`, as OpenCode's
own record does.

### Layout-mounted session-list lifecycle

`MainLayout` and `VSCodeLayout` each call `useSessionListSync({ isVSCode })` directly and unconditionally, outside Sidebar visibility, responsive, editor, settings, and compact-view branches. The hook selects the real topology inputs, publishes complete directory bootstrap demand through `ChildStoreManager`, refreshes topology additions (including all VS Code directories on its first mount), coalesces OpenChamber control events for 500ms, and supplies a memoized complete global active+archived input to authoritative cleanup. The root-level global poller owns the initial global refresh. MainLayout includes available worktrees; VS Code intentionally excludes them. Sidebar-local `session-created` worktree discovery is separate and full-app-only.

### Directory bootstrap scheduling

`ChildStoreManager` is the single owner of directory bootstrap scheduling. Consumers publish demand; they must not start bootstrap from row mount effects.

- The scheduler runs at most two directory bootstraps concurrently.
- Selected session/current directory demand outranks active-project, expanded, visible, and background demand.
- Demand is deduplicated by normalized directory and can be promoted while queued.
- `useSessionListSync` publishes the current directory and the selected session's directory. The only other owner is a chat column pinned in the side panel, which publishes its own session's directory with selected priority while it is mounted (see *Pinned chat columns*). Known projects and worktrees are never bootstrapped for being known, shown, expanded, or restored as expanded: their rows and sessions come from the global session list, their live activity comes from the global status index, and their pending requests come from the cross-directory blocking-request index. On v2 every directory-scoped read makes OpenCode create and initialize a location, so publishing the whole topology created one location per project at startup. Sidebar notices still request bootstrap manually with `force`.
- A directory that was never bootstrapped relies on the global list for sidebar readiness. Until a complete global snapshot arrives, its group shows loading or a retryable global failure. A directory bootstrap can establish active-list coverage for its own scope; it cannot establish archived coverage. Directory access and initialization failures remain scoped to directories the user selects.
- A system-resume signal, including Capacitor foreground resume, refreshes pending forms and permissions only for the active materialized directory. The refresh is deduplicated while in flight, preserves existing state on fetch failure, and leaves unopened directories untouched; normal stream reconnect recovery remains the broader catch-up path.
- When a materialized current turn contains a pending/running form tool but that session's pending form record is missing, the mounted chat performs a form-only recovery scoped to that session. It tries at most three times with delays of 0, 500, and 1,500 ms, stops when the chat unmounts or changes sessions, and guards every attempt against runtime changes. This closes cold-start races without adding requests to ordinary session opens or scanning unrelated sessions and directories.
- A bootstrap holds its scheduler slot only through the authoritative directory session-list fetch. `bootstrapDirectory` returns separate `sessions` and `environment` completions. `getBootstrapState` describes list loading; `getInitializationState` describes configuration and recovery. A complete empty list stops its spinner even while initialization is running. Initialization failure keeps the list and exposes its own retryable notice, including native directory access when the filesystem confirms a permission failure.
- Directory initialization uses v2's global active-session snapshot and directory-scoped form, permission, config and location reads. Form and permission reads ask only the directory's own list, one HTTP request each. v2 has no global pending list: a read without a directory answers for OpenCode's working directory (the user's home for a managed OpenCode) and starts that location, MCP servers included, so pending-request lists are never read without one. Live recovery starts independently of configuration and optional enrichment. Each successful read publishes its own fields; a failed read preserves prior data. Optional enrichment failure is logged without failing the workspace's core initialization. MCP status and the command list are deliberately not read during bootstrap: reading MCP state initializes that directory's entire stdio server fleet as an OpenCode side effect, and listing commands enumerates MCP prompts, which touches the same state. The MCP and command surfaces fetch on demand through `useMcpStore` and `useCommandsStore` instead, and slash-command dispatch falls back to one live lookup before treating an unmatched name as a plain prompt. OpenCode connects a location's MCP servers asynchronously, so a status read just after the location started says `pending`; each `mcp.status.changed` it announces re-reads that directory's status (debounced per directory), and only for a directory whose status is already held. A background directory's status stops being held when its location shuts down (see *A location's services going away*).
- Session pages and background reads share a three-request budget, with at most two running in either lane. Background work cannot consume the third slot, leaving capacity for lists even when two background reads stall. Queued lists take precedence over background work; active-session status recovery, and the first quota load of a visible Work status Usage panel, outrank queued metadata within the background lane. Retry backoff holds no network slot. Independent background reads can still progress concurrently.
- Session pagination retries each failed page at most three times. The directory loader does not replay the whole list after those attempts, so one unavailable page cannot multiply retries or redownload earlier pages while holding its scheduler slot. The VS Code empty-success recovery remains separate.
- A mounted directory-store consumer pins that store for its lifetime. Eviction may dispose only unmounted directories, so optimistic actions and realtime events cannot move to a replacement store while visible React consumers remain subscribed to an older identity.
- Selected, active-project, expanded, and visible bootstrap demand also protects a store from eviction. This keeps virtualized off-screen directories alive while their owner still needs them; background demand remains evictable so the complete known topology does not make the cache unbounded.
- Reconfiguration and runtime switching invalidate stale generations. A stale completion must not publish state into the new runtime.
- A `server.connected` outside the boot window means OpenCode's stream restarted and events were lost. `ChildStoreManager.refreshAfterStreamRestart` marks every bootstrapped store stale and forces a bootstrap now only for the current directory, stores with foreground demand, and stores showing live state the gap may have made wrong (a non-idle status or a pending permission or form); the last group runs at background priority, one at a time. Every other store re-reads on its next foreground demand (selected, active project, expanded, or visible), once. That judgment uses what each store showed before the gap, so one more pass catches a store that looked idle while its session started a turn or asked a permission or form during the gap: one global `session.active` read (it starts no location; a session waiting on a request is still running its turn) and `refreshStaleDirectoriesWithActiveSessions` queues, at background priority, every still-deferred store that lists or holds a status for one of those sessions. A failed read leaves them deferred. Isolated-space sessions are not in the host's list and keep the on-demand re-read. Background-shell lists are refreshed for directories with running commands that this pass did not queue.
- Failure is recorded as `failed`; it is not converted into a successful empty snapshot. Forced demand can retry failed or completed work.
- A bootstrap that ran while OpenCode was still starting fails, and the boot window ignores `server.connected` as a stream restart. The first `server.connected` per sync owner and runtime (`first-server-connect.ts`), inside the boot window or not, therefore calls `ChildStoreManager.retryFailedBootstraps`: every `failed` directory with foreground demand re-reads now with force; every other `failed` directory joins the stale set and re-reads on its next foreground demand. `complete` directories are not touched, since a read starts that directory's location. A retry that fails again stays `failed` until forced demand. The same first event lets the global session polling run a failed initial load at once (see Global session list).
- A failed bootstrap is classified as `os-permission` only when the owning runtime filesystem API independently confirms `EPERM`/`EACCES` for that exact directory. OpenCode/proxy error text is never used as permission evidence. The scheduler retains the directory-scoped reason so local Desktop can offer native folder selection before a forced retry.

Bootstrap remains stale-while-revalidate: a directory store may paint persisted sessions immediately, but only a successful authoritative fetch may replace that cached list. The replacement is silent: sessions deleted elsewhere disappear, and a record equal to the one held keeps its reference (the whole list keeps its reference when nothing changed). A persisted record is slimmer than the authoritative one, so the first bootstrap swaps each seeded record once; sidebar rows compare what they render, not references, so unchanged rows still do not re-render.

`directory-recovery-snapshots.ts` overlays status and blocking-request events received during initialization reads, including repeated busy events that do not change store references. Replies and session deletion/archive prevent stale responses from resurrecting pending requests or activity. Direct local mutations also survive the merge. These observers exist only for in-flight reads and belong to the exact directory-store identity. Initialization commits retain the bootstrap generation and attempt guard after the list scheduler releases its slot; retry, disposal, and runtime changes reject old completions.

Only archive events accepted by the reducer affect recovery snapshots. A rejected stale archive cannot erase current pending requests. Status snapshots pass through the shared schema in `lib/opencode/session-status.ts`; null, arrays, and malformed entries cannot grant idle authority. The scheduler's scope guard includes the runtime key and SDK identity, so invalidation takes effect before React replaces the provider. Reconfiguration reschedules initialization that outlived an already-complete list rather than leaving it stranded.

Global status reconciliation takes known session IDs only from records owned by the queried directory. A project store may contain worktree sessions; a parent-directory snapshot must not settle those sessions in the global activity index.

Directory session lists record whether their current snapshot is empty, persisted, live-event-derived, or authoritative. Bootstrap captures a mutation revision before starting its requests. Its completion replaces persisted data, including with a successful empty response, then overlays only session events and direct move/archive/delete mutations newer than that revision. It must not preserve the entire cached list as a race fallback because that would retain stale persisted sessions.

The roots request is authoritative for root completeness. The broader child-session request has independent completeness: a successful empty response clears stale children, while a failed request preserves known children and their required ancestors without turning the failure into an empty snapshot.

The persisted session snapshot keeps up to 50 sessions selected by `time.updated`/`time.created`, not ID ordering. Each record is persisted without `cost`, `tokens`, `permissions` and `metadata.openchamber.assist` (`PersistedSession`): a row paints without them, and they were most of a record's size (about 6 KB down to about 0.4 KB per session in the unit fixture). Seeded records are replaced by the first authoritative copy, which never compares equal to a stripped one. Records an older build wrote with every field still read through the same schema and are rewritten slim on the next write. Writes are throttled to at most one per key every 2 s (trailing, a newer value replaces the pending one without postponing it), skip `setItem` when storage already holds the identical serialized value, and flush on `pagehide`, `beforeunload`, document hidden, and `freeze`. Chromium commits localStorage at a byte-rate limit, and a session list changes with every streamed step. On read, every cached record is parsed for the fields the stores dereference before bootstrap (`id`, `directory`, `projectID`, `title`, `time.created`/`updated`) and records that fail are dropped: localStorage on `openchamber-ui://app` is shared by every OpenChamber build, so a record another version wrote is untrusted input, not a `Session`. Non-empty updates coalesce to the latest runtime-directory snapshot and flush on lifecycle suspension; runtime switches reject stale pending writes. Successful empty results persist an empty v2 tombstone synchronously so legacy data cannot reappear on restart. If localStorage quota prevents the full snapshot, persistence retries with progressively smaller recent snapshots and removes stale current/legacy values rather than leaving an old list indefinitely.

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

Directory bootstrap must publish a closed session hierarchy: when a child is
returned before the roots query catches up during cold startup, retain or
recover its referenced parent instead of exposing an orphan-only snapshot.

Session message loads use runtime, normalized directory, session ID, SDK epoch, and loader generation as commit authority. Eviction, archive, delete, move, directory disposal, and runtime switching invalidate the applicable loader generation before stale in-flight work can publish. A move invalidates both source and destination loader targets.

An authoritative `session.deleted` event also clears persisted UI state before routing metadata can be removed. Confirmed local deletion and accepted `404` deletion do the same directly instead of depending on the event echo. Cleanup is identity-owned by runtime, normalized directory, and session ID: queued messages, persisted todos, composer drafts, per-session input-history buckets, inline-comment drafts, and pins clear only that tuple, while the active runtime's folder store removes the session from every active or archived folder scope. Stale-runtime events and unresolved/global directory identities do not mutate persisted state.

Persisted sidebar state is never reconciled destructively from the first successful startup list. That list establishes an authoritative active+archived baseline. Only a session present in that baseline and omitted from a later complete snapshot is treated as a missed external deletion, and that judgment commits the same reconciliation as a confirmed deletion through `reconcileExternallyDeletedSession`: the session leaves every live store and the global cache, the current-session pointer clears when it pointed there, and `cleanupPersistedSessionState` runs. Clearing only persisted state was the earlier behavior, and it left the session in every live store, in the sidebar, and as the open chat still prompting an id the server no longer has when the `session.deleted` event was lost. The reconciliation is rechecked against the captured runtime before it mutates the non-runtime-scoped live, global, and UI stores. Archive and directory moves retain the session ID across snapshots and are not deletion cleanup. The judgment runs in `MainLayout` and `VSCodeLayout` through `useSessionListSync`, which see a snapshot every 45-second global poll, and in the mobile shell's `MobileAppContent`, which has no poller and sees a snapshot whenever the sessions sheet opens or the last session is restored. This favors harmless hidden stale metadata over irreversible user-state loss when startup data is incomplete.

Session materialization recency is keyed by runtime and directory. Foreground loads promote navigation recency. Prefetch reserves only unused per-directory capacity before HTTP starts and inserts speculative entries behind visited sessions. A prefetch cache hit does not promote recency, and a full cache skips uncached speculation. Otherwise the sidebar's neighbor prefetch displaces visited sessions and causes repeated HTTP on every navigation cycle near the limit. Prefetch pagination metadata has a global count ceiling and is removed with session eviction, directory disposal, loader runtime reconfiguration, and loader disposal.

`SessionCacheRetention`, owned by `SessionMessageLoader`, evicts whole session histories and never trims them. A settled session nobody is looking at keeps its history for a five-minute idle grace and is then dropped, so a quick return needs no request while a long-abandoned session frees its messages, parts, and derived caches. Twenty materialized sessions per directory on web/Electron and six on VS Code, hosted mobile, and Capacitor are a soft safety net: past that count the least recently visited unprotected session is evicted immediately. Selected or externally viewed sessions, busy/retrying sessions, pending forms/permissions, optimistic sends, in-flight loads, explicit history readers, and the transcript still rendered through a deferred switch are protected and may overflow the limit. Protection ending restarts the idle grace from that moment.

Selection changes and directory message/status/blocking-request publications schedule one coalesced retention pass per directory, and one timer per directory wakes the pass when the earliest idle grace expires. Part-only streaming updates do not schedule retention. Switching runtimes and disposing directories cancel the old cleanup ownership. Eviction resets the loader entry and marks it evicted: messages that later arrive by event for that session are renderable but are not history coverage, so the next navigation fetches the transcript again and merges it with those events instead of presenting them as the whole history.

A viewed transcript is never evicted, so someone working in one chat would keep every turn since they opened it, and every timeline pass (turn projection, record snapshots, timeline rows, the part map clone per event batch) walks all of them. Measured with `profile:session --grow` on a CPU slowed four times: one agentic turn kept the main thread 14% busy with 10 turns in memory and 26% with 100, with 28 long tasks instead of 5. `SessionMessageLoader.trimHistory` therefore cuts a transcript that outgrew the cold-navigation window back to that window (ten prompts, or 300 records once the newest prompt is in), at the prompt that starts it (with the `synthetic` context carriers sent right before it, which its chips and a revert or fork of it need), and moves coverage to a cursor below the first kept record (`olderMessagesCursor` in `@/lib/opencode/messageCursor`, OpenCode's own `next` cursor shape), so loading older history reads the dropped turns again. `ChatContainer` asks for it 3 s after a turn starts or ends, only while the reader is pinned to the end, where removing rows above moves nothing on screen. The timer keys on the newest turn id so prepending older history does not schedule a cut. It cuts nothing while a load runs, while an export or title read holds the transcript, while any timeline showing the session is scrolled away from its end or has its prompt navigator panel open, while the session timeline dialog is open (both surfaces hold the transcript with `retainSessionHistory(..., "browsing")`), while a revert is pending (its marker hides the tail, and a cut counted over hidden turns could drop the marker), after a stream gap the transcript was not confirmed since, or at an unconfirmed record. Browser find in page does not see dropped turns; the in-chat search is server-indexed and loads history itself. Readouts that sum the loaded records describe the loaded window, as for a session opened cold: the Context panel's message counts drop at a cut, while its total cost comes from the session record (`Session.cost`).

### Why the viewed transcript is cut back and not kept whole

Keeping it whole made each agent step cost more the longer the chat ran, until a slow machine dropped frames on every step. Making every pass incremental bounds part of that cost but not the memory or the per-batch part map clone; a bounded window bounds all of them and matches what a freshly opened session holds. The cut runs at every turn edge rather than after the transcript doubled: with a cut at twice the window, an agentic chat held 300 to 600 records between cuts, and its turns still cost a third more than in a freshly opened session (16.5% of the main thread against 12.3%, CPU slowed four times). A cut with the reader at the end moves nothing on screen and walks only the window, so cutting often costs nothing visible.

Cold navigation and prefetch request 100 records (50 on constrained surfaces) and, when that page holds fewer than ten user prompts, extend it backward through the server cursor until ten prompts are present, history is complete, or the window holds 300 records (200 constrained). Each extension page is sized from the prompt density already fetched, with 20% headroom, and a window without any prompt asks for OpenCode's maximum page of 200, so a long session needs one more round trip instead of one per hundred records. No request asks for more than 200 records, OpenCode's limit. The record ceiling never stops the window before the newest user prompt: the timeline groups records into turns by their prompt, so a window holding none renders an empty chat, and a last turn longer than the ceiling is read back to its prompt. Nothing already downloaded is requested again, and the window publishes once. History readers such as export need only one prompt boundary. Interactive history loading requests 100 older records per action; if the batch does not start on a user prompt it reads up to two more whole pages, keeps every fetched record, and stops, unless the batch still holds no user prompt at all, in which case it keeps reading until one arrives so the action always adds a visible turn. The server cursor stays authoritative, the batch publishes once, and a failed follow-up read preserves the previous history and cursor. Overlapping demands share that batch. Programmatic prepend compensation and the settling guard cannot trigger another batch. On desktop an underfilled pinned viewport requests one batch per opened session; the load-older button remains available on every runtime while coverage is incomplete. Explicit complete-history readers use 100-record pages until complete without turn alignment. Exports and title-context reads hold a loader history lease until their result has been copied out.

### Global session list

Use `useGlobalSessionsStore` when the UI needs a **shared global session cache**.

Each full app root owns one global polling lifecycle through
`useGlobalSessionsPolling`. The web/desktop root, the desktop Mini Chat window
root, and the VS Code chat root load once when mounted and schedule the next
refresh 45 seconds after completion, so sessions created by another OpenCode
process are discovered without relying on the sidebar or native tray being
visible. Before the first successful global load, failures receive at most
three earlier retries after 1, 2, and 4 seconds; then the normal cadence
continues. Store error status, including a chats-root
lookup failure, drives recovery because the loader returns retained data on
failure. Runtime changes retire the old timer and start a fresh load immediately;
late completions cannot restart the old timer or seed the new runtime.
A refresh that comes due while the document is hidden does not run; it runs
once when the document is visible again, and the cadence resumes from there.
Live events keep the list current meanwhile; only sessions another OpenCode
process created wait for the window to be seen. On desktop that includes a
window closed to the tray.
The sidebar and tray consume the same store and must not start their own
full-list timers. The tray renders only the sessions the sidebar can place — a
configured project or worktree, a managed chat, or an isolated space — because
its twenty rows are the recent-work shortcut, and a session from an
unconfigured or deleted directory has no row in the sidebar's project or chat
lists (Pinned and In work can still list one). Pending approvals from a hidden
session still appear. Surface-specific refreshes, such
as opening the mobile session sheet or returning from suspension, may still
request freshness at their explicit lifecycle edge; the store coalesces an
overlapping in-flight load.
Until a load has succeeded, OpenCode's first `server.connected` in the runtime
runs the refresh at once instead of waiting for the next startup retry or the
45-second interval; when it arrives during a load that then fails, one more
load follows immediately. After a success it changes nothing.

**Startup seed.** The global store starts from the managed-chats snapshot plus
a global snapshot of active sessions outside the chats root (see
`stores/DOCUMENTATION.md`), so worktrees and other projects paint before the
first list arrives. The seed is never authoritative: `hasLoaded` stays false and
`status` is not `ready`, so authoritative cleanup and last-session restore wait
for a complete load, which replaces the seed silently.

**Isolated spaces.** With the feature on, the first global page carries the
host's `spaces` mark: one entry per space with its name, the state of its last
answer (`complete`, `partial`, `stale`, `unknown`), the registered project it
was made for and its directory inside. `lib/spaces/spaces-store.ts` keeps the
marks of the last complete load, reset on a runtime switch. A space's sessions
live at `/spaces/<id>/<folder>`, and the server sends a request that names
such a directory in its query or its directory header to that space, so the
sidebar's per-directory reads of a space go to the space; a request that names
its directory only in its body passes it to `runtimeFetch` as `directory`,
which `lib/spaces/space-route.ts` turns into that header for a space. Rules that follow from the
mark: a session of a space whose answer was not `complete` may be missing from
the snapshot without being deleted, so the authoritative cleanup skips it; the
event pipeline hands the host's `openchamber:space-stream` announcement to
`sync-context.tsx`, which marks a lost stream as stale and, when it is back,
re-reads that one space's directories with `refreshSessionsForDirectories`,
whose answer marks the space reachable again; a stream back on a space the
journey list holds as stopped means it was started from another window, so
the list is read again too. The models of a space folder are grouped under the host's providers of the
project the space was made from, which the mark names; `space-catalog-sync.ts`
reads the catalogs this page loaded for a space's folders again when that
space's project first becomes known, since a space made while the page is
open is chatted in before the list names it; a stopped space is skipped. While the journey list says a space is stopped or
its container is gone (`isSpaceDirectoryStopped`), the active-session
watchdog skips that space's directories, status poll, stale resync and child
discovery alike, because every request would be the dispatcher's refusal
and a log line on the host; the sessions keep the status they last reported,
and the polls resume with the list that says the space runs. The browser
panel's dev-server look pauses on the same rule, and so do the sidebar's
speculative message loads and the chat's load of a session it opens: the
chat shows `SpaceChatPlaceholder` (the space's state, with Start for a
stopped one) instead of waiting for a load's timeout, and loads the session
once the list says the space runs. The active-session snapshot that
settles an unfinished turn is the host's, global, and never covers a space, so
`getActiveSessionStatuses` asks a space directory's own server for it; the
host's empty answer would otherwise mark a turn running inside as interrupted.
A space that dies in the middle of a turn sends no settle event, so the
session keeps the busy state it last reported until the space answers again
or the user acts; the group's stale mark is what says the space is gone, and
the group's status line turns it into "not answering" with a restart of the
container (`lib/spaces/space-repair.ts`). That module derives the line from the
journey entry (`state`, `damage`), the mark, and the one action this window has
under way or saw fail on the space, which `spaces-store.ts` keeps per space and
clears on a runtime switch. After a start or restart that went through it marks
the space reachable, because the host answers those only once the server inside
is ready, and it reads the journey list again whatever the outcome; the action
stays the line's word until that read lands, and for a start or a restart until
the global session list is read again too, because its mark is what the host
set stale when the space did not answer during its own restart. Shown as they
came, the lists of before said "stopped" with a Start at the end of a start, or
"not answering" with a restart after a restart, for about two seconds. After a
removal that went through it also reloads the global session list, saying
"deleting" meanwhile: the mark of the removed space goes only with the host's
next complete list, and until then the sidebar kept an empty group for the
space, about forty seconds measured.
A deleted space's chats are on the Archive page under the archive's own
directory, so what this browser cached for the space's directory is a lie
from then on: a store seeded from it listed the chat under the project and
addressed it through the prefix of a space the host answers with 404
("Session could not be loaded"). Two rules close that. A store of a space
directory seeds its session list from the persisted cache only while this
window knows the space, by its mark or its journey entry (`seedsSessions`, given
to `ChildStoreManager` at construction so no store escapes it,
`isDirectoryOfKnownSpace`); at start-up, before
the first lists, a space's chats wait for the authoritative list instead of
painting from the cache. And when a space leaves both lists, deleted here or
from another window, `sync-context.tsx` forgets every store of its
directories (`ChildStoreManager.forgetDirectory`: the list emptied, the cache
dropped, the store disposed once nothing holds it) and moves the open chat of
that space to the archive directory once the global list names it, which may
be a later page than the one that dropped the mark. A reset of the store, a
runtime switch or the switch turned off, empties the lists without deleting
anything and forgets nothing.

The host also announces each step of a creation as
`openchamber:space-progress`; the pipeline hands it to `sync-context.tsx`, which
moves the space's entry in `spaces-store.ts` on. That store also keeps the
journey route's list, the only source that knows a space still being made or
one whose making failed, read on every (re)connection while the switch is on:
a step announced after a read began wins over that read's answer, and a read a
runtime switch overtook is dropped. The sidebar shows a group for every space
of either list (`useSidebarSpaces`). VS Code never applies
the prefix and never shows a space (decision 16 of the design).

Not done here: the session-keyed actions still fall back to the current
directory when nothing confirmed the session's own, in `session-actions.ts`
and inside the SDK wrapper's `clientFor`. A guess that names the wrong side is
refused by the server's guards or answered not-found by the far side, which
cannot act on a foreign id, so nothing crosses the boundary; the action fails
where it used to succeed by luck. Making those actions fail before the request
is a later stage.

### Session retention

`session-retention.ts` owns eligibility and cleanup execution;
`useSessionAutoCleanup.ts` connects it to the app and Settings. Manual and
automatic runs share a lock acquired before loading. Each run requests a fresh
complete global snapshot and refuses the loader's error/fallback state. A
runtime switch stops the batch and prevents writing its cooldown into the new
runtime. Automatic attempts are limited to once per day while the app is open;
manual runs bypass the cooldown and enabled checkbox.

Retention targets unarchived sessions by last activity by default. The opt-in
`sessionRetentionOnlyArchived` setting switches both the preview and execution
to archived sessions and measures their retention period from `time.archived`.
It forces Delete in the store and cleanup runner; Archive is disabled in Settings.
Turning it off leaves Delete selected and makes Archive available again. The
setting uses the instance settings registry across web, desktop, VS Code and mobile.

Both modes preserve the five most recent sessions in the selected scope, ranked
by that scope's retention timestamp, plus the selected session, shared sessions,
sessions with observed live activity, and sessions the user keeps: pinned on this
client (pins live in local storage, so another device does not see them) or in
the In work block. Parents with an attached `/btw` conversation also stay,
because the canonical archive/delete actions remove that temporary fork.
Sessions outside the selected scope remain protected. Because
OpenCode cascades deletion, every ancestor of a retained session is protected
too. Eligible deletions run children first and recheck current selection,
activity, sharing, age, and child membership before each request. A failed child
blocks deletion of its ancestors while unrelated sessions continue.

Cleanup uses the canonical archive/delete actions, including confirmed `404`
deletion, persisted-state cleanup and runtime guards. Settings shares the run
state and shows loading or fetch failure separately from an eligible count.

### Live cross-directory session/status view

Extension session subscriptions project these same stores through `lib/guests/workspace.ts`; they own no poller or git discovery. `global-session-status.observedById` retains explicit live activity/outcomes for at most 2,000 sessions in memory. A status snapshot can establish current activity but does not manufacture a successful turn. An error followed by idle retains its failed outcome until another run starts; runtime reset clears observations. Extension task status remains extension-owned.

The session creation action accepts `navigation: "preserve"` for background extension launches. It still registers the returned directory, initializes message loading, marks the session as OpenChamber-created, and updates the global cache, but never selects it. Explicit guest `openSession` performs selection later. `session-ui-store.worktreeDiscoveryByProject` publishes topology loading/ready/error separately from retained worktree records; the existing sidebar discovery and control-event refresh own these flags.

An explicit creation title is recorded as `metadata.openchamber.workTitle`
with `by: "user"`, preserving the caller's other metadata. Titleless creation
leaves metadata unchanged. The title and its ownership reach OpenCode in the
same create request, so `work.name` cannot replace a user-given title before
a later metadata write completes.

Use the sync hooks backed by aggregated child stores when the UI needs **live truth** for sessions or statuses across all initialized directories.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx`
- `Header.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()` / `useAllSessionStatuses()`

A cross-project session list (a picker or panel listing every project's sessions) merges two sources, as `MobileSessionsSheet.tsx` does: `useGlobalSessionsStore().activeSessions`, replaced by the live copy from `useAllLiveSessions()` where one exists, plus live sessions the global list does not hold yet. `useSessions()` is scoped to one directory and the global list alone does not cover every initialized directory. Call `refreshGlobalSessions()` or `ensureGlobalSessionsLoaded()` on open for projects not bootstrapped, and map a session to a project by prefix-matching its directory against the project root and its worktree paths (`pathBelongsToRoot`), not by an exact directory lookup.

Cross-directory selectors subscribe to the narrow child-store field they aggregate. Session aggregation listens to `state.session`. Live busy/retry state is also maintained in `global-session-status.ts`, where each row subscribes to one session ID instead of scanning every child store. Events update the index incrementally; authoritative per-directory status snapshots seed it, clear sessions omitted as idle, and reconcile missed events. Unrelated streaming events such as `message.part.delta` must not trigger global session/status scans.

Directories that are not bootstrapped get their initial activity from the host instead: `host-session-status-seed.ts` fetches `/api/sessions/status`, the cross-project map the OpenChamber host keeps from its single upstream event stream, after each global session load. One request, no OpenCode instance creation. The seed is additive only. It adds busy entries (retry collapses to busy; the next live event restores details) for sessions the client has not observed itself, resolves each session's directory from the global session cache, skips entries the host last updated more than 30 minutes ago because nothing reconciles the host map after a stream gap, and never clears anything: the host payload carries no directory, so absence proves nothing. A live event that arrived first wins. In VS Code the webview shim answers the same route from the extension host's activity watcher, whose phases collapse busy and retry and settle themselves, so every entry it reports is current. The host also reads OpenCode's running list each time its event stream connects and marks those sessions busy, so a turn that started before the host (an external OpenCode, or a host restarted mid-turn) is seeded too. The seed also applies the host's turn starts (`buildHostTurnStarts`): a busy entry's start is its running turn's; an idle entry's is its last turn's and is applied only to a session this device does not see running itself, which is a parent whose subagent or background command keeps that turn open here.

Pending permissions and forms get the same treatment in `global-blocking-requests.ts`: the dispatcher feeds it `permission.asked`/`permission.replied`, `form.created`/`form.settled`, and `session.deleted` for every directory, and the host seed adds the `pending` map the server keeps from its own stream (`getPendingBlockingRequestsSnapshot` in `session-runtime.js`; dropped on reply, deletion, and OpenCode restart, so it carries no age cutoff). The index keeps only the fields its consumers render (`id`/`sessionID`/`action`/`resources`/`save` for a permission, `id`/`sessionID`/`title` for a form), which is also everything the host can carry. It is additive from the seed and never cleared by absence. Directory stores stay the source for open directories; desktop row badges also count the index's forms while that directory's store has not completed a bootstrap, because such a store learns only of live ones. Once the bootstrap completes, the store alone answers for forms, since its reply and reconnect paths clear forms the index can keep after a lost `form.settled`; a status change notifies form subscribers so rows switch source. The index serves the tray's approval list and any surface without a mounted row. The mobile shell has no global poller, so its sessions sheet runs the seed after the list load it does each time it opens; without it, phone rows, which read only the index, miss every request already waiting at startup. A page an agent shows that waits for the user's answer (`render.page` with `awaitAnswer`) is a third kind, `pages` (`id` is the tool call id, plus `sessionID`/`title`). OpenCode never hears of that wait, so no directory store holds it: the server announces both ends as `openchamber:page-waiting` and `openchamber:page-settled` (`applyWaitingPageEvent`, placed by the session's directory when the server does not name one) and lists it in the seed's `pages`. Every surface counts it as a form: collapsed and expanded rows, mobile rows, run overviews and the tray, which only opens the session for either. Pages stay apart from `forms` so the form dock never tries to answer one. While one waits, the composer sends a message at once instead of queueing it, because the turn cannot end until the wait does; the message reaches the agent's plugin, which ends the wait.

### Why page snapshots replace waits while form and permission seeds stay additive

The host owns waiting pages directly, so its complete `pending` map is authoritative for its own page waits. `readHostBlockingRequestsSnapshot` clears pages omitted from that map and overlays page events received during the read, including a settlement whose ask never reached this client. Otherwise a delayed snapshot can resurrect an answered page, and a lost settlement leaves a question badge indefinitely. Observers live only for the read and runtime reset invalidates them. Unchanged entries keep their references. Failed reads and hosts that omit `pending` clear nothing; isolated-space page waits belong to their own server and are left untouched. Forms and permissions remain additive because their host map only forwards OpenCode events and can itself miss a settlement.

A `permission.asked` in a session whose permission mode answers without the user (`auto`, or `safety` while a classification provider can run) is held back in `handleEvent`: no card, no row badge, no toast, and no entry in the cross-directory blocking-request index (which feeds collapsed rows, the tray and run overviews), so a request the server accepts never flashes on screen. The replay for the user applies global effects, which adds it to the index then. The host seed is not filtered this way: a page loaded while the server is still classifying a request can show it until the server answers. The server reports a request it did not answer (the safety net held it, Jev failed, or the reply failed) as `openchamber.permission-left-for-user`; the held-back event is then replayed as an `ask` request, stored and announced, in a directory with or without a store. `permission.replied` drops a held-back request. A report that arrives before its request is remembered (bounded), and that request is shown at once. VS Code never holds back: its extension host answers in the webview. A request held back while the client disconnects reaches the store through reconnect reconciliation, which does not consult the mode.

Holding back is only safe while the client hears both the modes and the reports. The main event stream carries them only over the WebSocket; over SSE it is OpenCode's own stream. So the server also sends `openchamber:permission-auto-accept.updated` and `.left-for-user` on the control stream, which every web, desktop and mobile window keeps open, and `subscribePermissionPolicySync` (`permission-mode-sync.ts`) feeds them into `handleEvent`. Over the WebSocket each arrives twice; a second policy of the same revision and a second report for a request already shown change nothing. Each connection of the control stream reads the modes again, the host's (`usePermissionStore.hydrate`) and each known space's (`refreshSpaceModes`): a mode changed in another window while this one was cut off was never announced to it, and a stale `auto` would hide every request of that session for the life of the window. The host's `openchamber:space-permission-stream` announcement re-reads that space's modes from the control stream too.

In-app permission and form toasts for a directory without a store are shown from `handleEvent` directly, except in VS Code, whose extension host owns the auto-accept path. VS Code's `/api/sessions/status` shim reports no pending requests.

"Open session" on a permission or form toast opens the session and passes the request id to `request-reveal.ts`. The permission or form dock that holds that request expands, and the permission dock switches to it. Selecting the session alone would leave a dock the user collapsed collapsed when that session is already open. The id waits until a dock holds it, so a dock that mounts after the session switch still expands.

An MCP elicitation arrives as a `form.created` whose `sessionID` is the `global` sentinel (`LOCATION_SCOPED_FORM_SESSION_ID` in `location-scoped-forms.ts`): no session record exists for it, so event routing does not treat it as a session address and it never enters the session routing index, otherwise a second directory's elicitation would land in the first one's store. Since 2.1.4 OpenCode publishes these forms, `form.created` and `form.cancelled` alike, with their location, so the event is filed by that directory. The directory store keeps the form under `form["global"]`, bootstrap's directory-scoped `form.list` returns it like any pending form, `useScopedBlockingForms` surfaces it from every session of that directory, and reply/cancel resolve the directory from the store that holds it.

Error details for a failed turn (`notification-store.ts`, shown under the turn by `SessionErrorNotice`) are recorded before the directory-store lookup in `handleEvent`, so an unopened directory still keeps them. The subtask check reads the directory store when the directory is open and the global session cache otherwise. Event routing likewise consults the global session cache: a session-addressed event with no directory is routed to the directory the cache records for that session before any active-session or single-store fallback, so another project's events cannot land in the one open store.

Session display order is independent from streaming-frequency `time.updated` publications. `session-ordering.ts` promotes a session exactly when its authoritative activity phase crosses `settled` (`idle`/`error`) and `active` (`busy`/`retry`) in either direction. Repeated busy/retry or idle/error events are no-ops. The first authoritative status snapshot establishes a baseline without synthetic promotions; later snapshots reconcile missed transitions. Root sessions compare lifecycle rank only with other roots, while child sessions compare lifecycle rank only with siblings sharing the same `parentID`, so child activity never moves its root conversation. Pins remain the first ordering bucket. The timestamp/creation fallback is frozen when a session first participates in ordering, so later metadata-only updates cannot reorder it; creation time and ID provide deterministic ties. Runtime switches clear all phases, baselines, and ranks.

`session-activity-timing.ts` counts how long a turn has been running. `SessionStatus` carries no timestamps, so the OpenChamber host keeps when each session's latest turn began (`session-runtime.js`: `session.execution.started`, or the turn's first message read back from history for a turn already running when the host connected) and hands it out beside the status: `turnStartedAt` on `openchamber:session-status` events and on `/api/sessions/status` entries, on the host's clock. The client moves it onto its own clock by elapsed time (`hostTurnStart`: now here minus the host's now minus the start), so a phone whose clock is off still shows the host's elapsed time. The module is driven from the same two write paths as `global-session-status.ts`, so a row can never count a turn that index calls idle. A session entering a turn takes the best start known: a host start, this device seeing `session.execution.started` (stamped on arrival), or a start persisted before a reload. The last two stand in until the host's arrives and make the host request below. A running session with none of them is held in `startUnknown` and shows no duration. The first time in a turn that a session has no host start, the module asks once through `setHostTurnStartRequester` (wired by `sync-context.tsx` to `requestHostTurnStarts`, which waits 300 ms for the host's own status event and then reads the host map through the seed when a start is still missing). A host start replaces a stand-in and fills a missing start. Against an earlier host start, a difference under 1 s is network delay and is ignored; a later start is ignored for a turn this device holds open through background work (`global-session-status.ts` reports that hold), because it is the session running again inside the turn already counted; any other different start means this device missed a turn change, and the host's is taken. A host map read is ignored for a session whose start this device learned while the read was in flight: the map describes the turn before it. A session this device only joined from a status snapshot is not such a case, so the read's start still applies. Settling converts the start into a finished duration, kept in memory only. Rows show a finished turn's length while the session is unread, through `session-turn-duration.ts`: the length the server recorded on the session (`metadata.openchamber.turn`, `lib/sessionTurnMetadata.ts`) wins, and this page's measurement covers the moment before that record arrives. That is what keeps the length on a row after a restart and on every device. VS Code's extension host reports the start of a running turn it saw begin as an age, and the webview anchors that age on its own clock, so a webview reload resumes the count. A turn that began before the extension host was listening still shows no duration until a live event marks a later turn.

A background subagent keeps its parent's turn open for display. The parent goes idle while the child session works and runs again when OpenCode hands the result back; `global-session-status.ts` therefore holds the parent's timer through that pause (an idle parent with a running descendant does not settle, the last descendant to finish settles it, and snapshots count ancestors of running sessions as active). `useSessionTurnActivity` exposes that display state to rows, tabs and switchers. `statusById` and `activeSessionIds` stay the session's own status: sends, cleanup and retention must not treat an idle parent as busy. The parent lookup comes from the global sessions store through `setSessionParentResolver`, wired by `sync-context.tsx`.

### Why auto-fusion observes transitions before batch publication

`subscribeSessionStatusTransitions` synchronously exposes the active-ID draft
after each busy/retry or idle/error event. Listeners must consume it during the
callback without retaining or mutating it, and unsubscribe on unmount. Auto-fusion
uses its own merged session map to record a parent waiting for a descendant.
The store still publishes once per batch. A React effect alone misses the wait
when the parent and child settle in the same batch and can fuse an earlier answer
before the parent resumes.

A background shell command keeps its session's turn open the same way. OpenCode settles a `shell` call with `background: true` at once, the session goes idle, and it runs again when the command's result is handed back. `background-shells.ts` indexes the commands OpenCode runs on behalf of a session (the shell tool tags each with `metadata.sessionID`): `shell.started`/`shell.ended` events keep it current for every directory, applied before status events in the same flush; a directory's `/api/shell` list is authoritative for that directory and is read by directory bootstrap and, on `server.connected`, for directories without a store that the index holds commands for. The list is keyed by the directory OpenCode answered for (symlinks resolved), which its shell events carry, and events that arrive while it is read win over it. A failed read changes nothing; a runtime switch resets the index and discards reads started before it. OpenCode runs every shell call as such a command, including one the turn waits for, so each entry carries `background`: set when the call that started it settles while it runs (`message.tool.transition` success with `metadata.status: "running"` and the `shellID`, remembered when it arrives before the start), false until then, and true for a command first seen in a list, which has no event to tell. The turn state below counts every command; the composer's background commands strip shows only background ones. A command that leaves the index moves to its `ended` list (extensions read it through `lib/guests/shells.ts`) with how it ended: `shell.exited` gives `exited` / `timeout` / `killed`, its exit code and the event time; `shell.deleted` of a running command is `stopped`, since only a user's Stop (the shell route) or an aborted turn removes a running command; a list read that no longer has the command records `unknown`. Removing a running command kills it, and OpenCode usually reports that kill as `shell.exited` with no exit code before the `shell.deleted`, so the index remembers each stop note (`message.updated` with `openchamberShellCancellation` metadata, written by `stopBackgroundShell` before it removes the command) and reads an exit without a code after one as `stopped`; an exit with a code after a stop that failed stays `exited`. Only the first end of a tracked command counts, so OpenCode evicting an exited command later (also `shell.deleted`) changes nothing. The list holds the latest `ENDED_SHELLS_MAX` (200) and resets with the index on a runtime switch. The session turn activity combines this index with live session status; the turn timer does not settle while a command runs, and the last command of an idle session ending settles it. The session's own status and the queue gate are unchanged: a dev server left running in the background must not hold queued messages.

An agent that ended its turn to wait on its pull request reads as working too, last in that order (`pullRequest`). `pr-watch.ts` is the projection of the server's watches (`packages/web/server/lib/pr-watch`): `pr-watch-sync.ts` reads `GET /api/pr-watch` at mount and after every control-stream reconnect and applies `openchamber:pr-watch.updated` by revision, so an older update or snapshot never undoes a newer one; a runtime switch clears it. It only marks: the turn timer settles as usual, the queue is not held, and the server wakes the session. The composer row (`PullRequestWatchStrip`) stops a watch optimistically and puts it back when the server refuses.

Starts are persisted so a reload resumes the same count, but a persisted start is a lookup table and never a claim of activity. **A busy status does not mark where a turn begins.** OpenCode publishes busy at every step of the agent loop, so a busy event means "still running", not "just started"; after a refresh one of those repeats normally beats the first status snapshot, so treating it as a turn boundary reset the counter on nearly every reload. Only `session.execution.started` marks a start, and a reload or a late join never sees it. Turn *ends* are marked — `session.idle` and `session.error` fire once, live, and retire the persisted record — while a snapshot that omits a session is not evidence of anything, since it may simply not see it yet.

That leaves the case with no observable answer: a turn that ended, and another that began, entirely while the tab was gone. Two bounds stand in for the evidence the client cannot have. A liveness stamp sits beside the start — refreshed while the session is observed active, at most every 15s, and stamped precisely as the page hides (`pagehide`/`visibilitychange`/`freeze`, written immediately rather than through deferred storage so it cannot lose that race) — and is compared against this page's `performance.timeOrigin`, so the measure is how long the app was absent rather than how long bootstrap took; a 20-second startup must not spend the allowance. Records may only be adopted within 90s of load, after which they are discarded — a backstop for a runtime whose event stream is down and where snapshots are therefore the only signal. A runtime switch resets the module, since the previous instance's turns are not ours.

Reconciliation walks the running turns and asks the snapshot whether it covers each one, rather than being handed everything the snapshot covers. Only a live start can settle, and there are a handful of those against a directory's hundreds of sessions, so the pass stays proportional to the timing work and allocates nothing per poll. Malformed, wrong-shaped, over-age, and future-dated entries are rejected on read. The payload is not runtime-scoped: records live for seconds and are keyed by instance-unique session IDs, whereas the runtime key is derived from injected globals and is not guaranteed stable across early startup — a read under a key the previous page never wrote to is indistinguishable from "no turn was running".

**Only the stamp expires a persisted start.** A snapshot that covers a session without reporting it busy is not proof the turn ended: bootstrap fetches status and sessions in parallel and directory scopes resolve at different times, so a snapshot legitimately arrives before it can see a running session. Treating one of those as a settle deleted the start moments before the real busy snapshot arrived, which reset every counter to zero on reload. Settles therefore act only on sessions that already have a live start in this page session.

### Why a turn with no known start shows no duration and not the time since this client looked

Counting from the moment a client first saw a session busy made every late joiner wrong: a phone opening a 20-minute turn read "12s", and the same happened on one device after a reload past the persisted bounds (#5259). The host now records each turn's start, so the client waits for it instead of guessing; a turn that neither the host nor this device can date shows no duration rather than a wrong one. Host starts travel as "elapsed on the host's clock" for the same reason: a phone's clock can be minutes off.

Forks (`forked-session.ts`): OpenCode 2.x publishes only `session.forked` for a fork, with ids and no record, and no `session.created` follows. `handleEvent` reads the fork's record with `session.get` and replays it as a `session.created`, so other clients show the fork without a list reload. A session the global cache already holds (the forking client inserted it from the fork response) is skipped; a failed read or a runtime switch applies nothing.

Fork permission modes are independent copies of the source's effective mode, including `ask`. Web, Electron, hosted mobile and Capacitor use the permission runtime's `session.forked` handler. VS Code's fork actions refresh the extension host's policy and persist the source mode through `permissionStore`, preserving any explicit fork choice already present. A policy failure is logged and keeps the created fork usable at `ask`; metadata cleanup and goal objective copying continue. A runtime switch stops further policy and metadata work. Ordinary new sessions continue to use Settings defaults.

Child-session discovery (`child-session-discovery.ts`) adds only children the global sessions cache does not list as archived: the listing asks for active children, but a response that left the server before an archive completed still carries them without `time.archived`, and re-adding them would show the just-archived subagents as active orphans until the next refresh.

The active-session watchdog in `sync-context.tsx` sends status recovery through the active-session priority of `runBackgroundNetworkTask`. Its child-session discovery pages use `runSessionListNetworkTask`, alongside global and bootstrap session pages. Both lanes live in `@/lib/background-network`. Git, skills, and directory initialization use the background lane. These limits reserve browser connections for interactive message requests rather than letting startup fan-out occupy the whole pool.

Queued reads belong to the instance where they were submitted. On an instance change, both lanes retire their waiters and the new instance gets its own capacity. Active old requests finish against their original lane counters. A retired task resolves `undefined`; value-consuming callers must preserve state or signal failure, never turn retirement into an empty snapshot. Multi-step reads also check ownership before their next request, because the queue cannot stop a callback that has already started. Session pagination retains one owner across pages and retries.

### Why queue ownership follows instances, not transports

`captureRuntimeInstance` in `lib/runtime-switch.ts` captures the instance key and an instance-change generation. Returning to the same instance cannot revive work from a previous visit. A LAN/relay rebind of the same instance keeps its work and concurrency budget. Lanes retire on the will-change event so changed-event listeners can enqueue new work without losing it to listener order.

Reconnect and watchdog candidates come from non-idle status, the viewed session, or unresolved materialized messages and tool parts. Only ancestors of those candidates join recovery. The watchdog's 5 s status poll and its child discovery run only for sessions with live work of their own; the viewed session joins them only when it is busy or unresolved. An idle viewed session gets its updates from the event stream, and the stale-stream check still covers it. Polling it every 5 s kept the private relay awake for as long as a session stayed open on any device, because the relay hibernates only after 10 s without a message. Parentage in cached session history alone starts no status polling, child discovery, or message materialization; an idle directory with only cached metadata does not scan its history.

### Why failed watchdog polls back off per directory

A failed watchdog status read preserves the previous status and waits 10, 20, 40, then at most 60 s after failure completion before retrying. A successful snapshot, including an empty one, restores the 5 s cadence and reconciles normally. Directory disposal, having no recovery candidates, and restarting the watchdog for a new SDK clear the delay.

### Why stale resync and child discovery have separate retry state

Stale resync and child discovery each wait 30 s after a failed attempt completes, then 60 s after subsequent failures. A successful attempt clears only its own delay and restores its 15 s cadence. The watchdog keeps its 5 s tick and per-directory overlap guards. Failure in one directory cannot delay another directory or reset another mechanism's outstanding failure. The 60 s cap bounds the added wait for a missed idle event or an undiscovered child once reads become available again.

The no-candidates branch also clears the last-discovery timestamp, making the first discovery after an idle-to-busy transition eligible on the next tick without waiting for any remainder of the previous 15 s window.

A resync reports failure when its active-session snapshot is null, a session record cannot be fetched, the message loader reports a tail-load error, or a form or permission read fails. Successful parts still reconcile and failed parts retain their previous data. `resyncBlockingRequestsForDirectory` returns whether both requested lists succeeded; callers that only need its best-effort updates may ignore the result. Stream-reconnect recovery bypasses the watchdog delay, so a restored stream can repair state immediately. The watchdog's own stale-stream check is different: its reconnect-and-resync attempt waits out the stale-resync delay, while transport-level reconnects and gap recovery stay ungated.

Discovery keeps the session-page helper's existing 3 attempts, with waits of 500 and 1,000 ms. An exhausted page starts the outer delay, and a complete empty list clears it. This preserves brief-error recovery within one attempt while pacing repeated failures of the whole discovery. Disposal, loss of recovery candidates, and a new SDK clear both mechanisms' delays. Late discovery completions from an obsolete watchdog or directory store publish nothing.

Visible sidebar change-request discovery is separate from child-store bootstrap demand. Worktree topology supplies directory ownership only. The sidebar acquires at most 50 unique demanded directories through the shared [repository binding owner](../lib/source-control/DOCUMENTATION.md), with cold reads behind the background-network gate, then asks the provider-neutral status store for one-shot status under each binding's primary provider account and revision. Binding publications refresh only the affected directory's status demand. Connected accounts outside the binding do not add requests. Hiding the sidebar or collapsing a project removes that demand; missing, unsupported, and failed binding reads issue no status request. A provider association must have ready endpoint authority; aggregate `needs-attention` on an unrelated provider or transport does not suppress it.
The watchdog calls the stream stale after 20 s without stream activity. Stream activity is anything the event pipeline receives, reported through `onStreamActivity`: an event, a WebSocket frame, or a keepalive that carries no event. OpenCode 2 sends its heartbeat as an SSE comment and the WebSocket bridge sends `openchamber:heartbeat`, and neither becomes a delivered event. Counting delivered events alone made an idle viewed session look stale, so the stream reconnected and resynced every 15 to 20 s, as reported in #4062. Starting a connection attempt is not activity, so a stream that receives nothing still goes stale.

Imperative cross-directory session lookups use the cached ID index from `getAllSyncSessionMap()`. The index is rebuilt only when a child store's `state.session` reference changes; permission lineage checks must reuse it instead of rebuilding a full session map per call.

VS Code does not run the server permission-auto-accept runtime. The extension host persists and broadcasts authoritative policy, while its foreground UI runtime resolves missing child-session lineage through the OpenCode API before deciding whether to suppress and answer a `permission.asked` event. Once policy is enabled, a live `permission.asked` event sends the directory-scoped `permission.reply` immediately and does not block on a permission-state preflight request. Enabling the policy treats permission cards already present in the directory store the same way and replies immediately, then reconciles the server's pending list by replying to listed requests directly without a permission-state preflight: `permission.list` is served by the V1 pending map while the state check reads the separate V2 map, so a preflight "resolved" verdict cannot prove a listed request settled. Reconnect/bootstrap reconciles pending requests in the session directory the same way, including requests inherited by child sessions. Unknown lineage and exhausted reply retries fail closed and leave the request available for manual action. A later `permission.replied` event invalidates any older deferred ask so the async policy check cannot resurrect a resolved request. With every OpenChamber webview closed or suspended no responder runs; this is an intentional VS Code limitation. Other runtimes remain fully server-owned.

### Why child discovery lists each live parent's children

Each discovery pass lists the children of every live session in the directory with `parentID`, one paged list per parent, one after another. It used to page through the whole directory list and keep the children of live parents. In a directory with 1,100 sessions that was 3.6 MB every 15 s for as long as any session there was working, about 1 GB an hour over loopback, which users saw as the app's network traffic. A parent's own children are a few kilobytes. A live subagent is itself a live session, so its children are listed by the same pass.

### Mutation responsibility

`useGlobalSessionsStore` is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. session create/update/delete events; recency-only updates for existing sessions are retained latest-per-session and committed once on `session.idle`/`session.error`, while structural updates and create/delete remain immediate and runtime switching discards pending updates. Display ordering reacts separately to active/settled lifecycle transitions, not to these recency publications
3. direct mutation from session actions after successful SDK calls:
   - create
   - title update
   - share
   - unshare
    - archive
    - delete
    - move to another worktree directory
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive without requiring a refetch after every change.

Live activity/status indicators must not depend on this cache. They must use the event/snapshot-reconciled global live status index.

### Unread sessions

`session-unread.ts` owns the unread mark, and OpenCode owns the state behind it. A session record carries `time.idle` (when its last turn ended, whatever the outcome) and `time.viewed` (a watermark of the last turn end a viewer saw, which OpenCode keeps monotone). A top-level, unarchived session whose `idle` is past its `viewed` is unread. Rows, tabs, switchers, collapsed aggregates, run overviews, the tray, the dock badge and the iOS widget all read that one rule from the global sessions store. The tray and the dock badge also require a sidebar row (`sessionHasSidebarRow`): an unread session the user cannot see or open would hold a dock count nothing clears. The badge counts a session that only the Chats, Pinned or In work section lists while that section is shown; the tray list keeps it with the section hidden, because a tray row opens the session directly.

Marking a session seen (`markSessionViewed` in `notification-store.ts`, which also clears its native notifications) writes the watermark locally at once and sends `POST /api/session/:id/view` with the `idle` it saw; a failed write restores the previous watermark unless a newer record replaced it. OpenCode announces the view as `session.viewed` to every client, so a session seen on one device stops being unread on the others. The global store's change signatures include `idle` and `viewed`, so these updates publish immediately instead of waiting with recency-only updates.

Archive and delete clear the mark whatever did them (the archive action, retention cleanup, worktree removal): an archived session is never unread and a deleted one has no record. Restoring an archived session marks its last turn seen, so it does not come back unread.

OpenChamber clients recorded no views before they read this state. The server keeps a baseline per data dir (`packages/web/server/lib/openchamber-sessions/unread-baseline.js`; the VS Code extension shares the file) and serves turns that ended before it as seen, so the first run does not light up every old session.

### Why OpenCode's viewed state and not an OpenChamber store

The unread mark used to be a client-side list of turn-complete events. It lived in one window's memory, so a restart lost every unread session and each device kept its own. OpenCode 2.x already persists exactly this state per session and broadcasts views, and its own apps read the same fields, so the record is the single authority and OpenChamber adds only the baseline.

### Viewed sessions and surface attention

A turn that ends in the selected session counts as seen only while the user can see this surface; otherwise the session stays unread. `sync-context.tsx` watches the sessions on screen (the selected one and those shown in side panels) and marks one seen when its record turns unread while it is viewed. `lib/surfaceAttention.ts` owns that answer. Web, desktop, and mobile use document focus; on web and desktop, `App.tsx` also marks the selected session viewed when the window regains focus. A VS Code webview document's focus does not track what the user sees: it loses focus whenever the code editor takes it while the chat stays on screen, and it can keep focus while VS Code is in the background. There the extension host reports window focus and webview visibility (`viewerStateChanged`); once a report arrives it replaces document focus, and `VSCodeApp` marks the selected session viewed whenever a report says the webview is seen again.

## Session message loading

The event pipeline's reconnect callback carries `replayReset`. A global WS
`ready` frame with that flag means the server's bounded replay suffix no longer
covers the client cursor. The pipeline clears that cursor and the sync provider
runs normal authoritative gap repair even during early boot. Ordinary reconnects
retain their existing startup grace period.

While `useAuthSessionStore` says the OpenChamber session is not usable
(confirmed expiry, or a login in progress), the event pipeline and the
OpenChamber control stream do not reconnect: every attempt would be refused
with 401 (#3778). A stream that is still connected keeps running. The store
returns to `ok` when a login succeeds, a confirm probe finds the session alive,
or the session gate's status check answers 200, including the check behind the
banner's "Log in" after the user already logged in from another tab. Then both
streams reconnect at once, cutting short any backoff wait, and the normal
reconnect callback repairs the gap. VS Code never reports an
expired session, and native mobile clears it on the spot, so the pause applies
where the session gate's banner and login exist.

`SessionMessageLoader` is the shared authority for session message requests. Navigation, reactive chat loading, sidebar prefetch, pagination, reconnect/recovery, and optimistic reconciliation must delegate to it rather than issuing parallel initial requests.

Rules:

1. Request identity is runtime key + normalized directory + session ID. Session IDs alone are not globally unique across runtimes or directories.
2. One in-flight request is shared by all callers. Foreground demand may promote the visible load kind of an existing prefetch without starting another request. A promoted prefetch reads the session's inbox once it settles; prefetch alone does not.
3. Load state is explicit per session: `idle`, `loading`, `ready`, or `error`. Fetch failure preserves prior materialized records and exposes retry; it never becomes authoritative empty success. An initial load that started before the page's first OpenCode connection (`openCodeStartupSignal`) reads at once, since OpenCode may already answer; if that read fails, the load stays `loading` and reads once more when OpenCode connects, so a session opened at launch never ends on an error or an empty transcript just because OpenCode was still starting. Callers share that one held load. It becomes `error` only when the second read fails or OpenCode does not connect within the startup wait. Prefetch does not wait. A cold open and a tail refresh also read `GET /api/session/:id/inbox` and repaint the session's pending `user` and `synthetic` items; the read is best effort, never changes the load state, and is skipped by a prefetch.
4. Async commits are generation-checked. Runtime switches, forced refreshes, eviction, and disposal must reject stale completion.
5. Prefetch coverage and persisted directory data are runtime-scoped. Legacy persisted directory entries may seed startup continuity, but they are not live truth.
6. Message and part materialization preserves references for unchanged records and maintains direct message-to-parts lookup. Consumers subscribe to the selected session's records rather than broad message/part containers.
   Directory `sessionStatusReady` records successful status-snapshot authority independently of bootstrap's general readiness. Before that flag or an explicit session status arrives, telemetry treats an omitted status as unknown. Archiving invalidates status authority for that session alone: restoring it cannot inherit the directory's older snapshot as proof of idle. A live status event or a successful fresh status read clears the invalidation; a failed read leaves it unknown. Neither the flag nor invalidations are persisted.
7. Pagination demand must carry the selected session's effective directory. It must not fall back to the sync provider directory because the visible session may belong to another worktree.
8. A stream gap (reconnect, transport switch, or `server.connected` outside the boot window) advances the loader's history epoch. A cached transcript confirmed before that epoch still renders at once when opened, and its tail (30 records) refreshes in the background; prefetch never does this. A tail that does not reach the cached records is read back until it joins them, or until the cold-navigation window is full, in which case the window replaces the cache so no hole is left behind it. After a gap the tail joins only through the gap anchor: the newest record the transcript held when the first gap since its confirmation happened. Records that arrived by live events after the gap may sit past a hole, so holding one of them is not a join; a stale transcript without an anchor (its load was still running at the gap) takes a fresh window. A refresh without a gap joins through any record cached before it started. A successful read confirms the transcript at the epoch it started in; a failed one keeps the cached records and the stale mark, so the next open tries again. A tail refresh repeats the inbox read so items enqueued during the gap reappear.
9. The ref-stable loader is disposed only after the current task when its provider unmounts. This lets React Strict Mode's development setup → cleanup → setup probe retain a usable loader for child effects, while real disposal still invalidates the preceding lifecycle's work.
10. Transcript arrays are chronological by `message.time.created`. Within one millisecond a `synthetic` record sorts before any other role, then message ID breaks the tie deterministically: composer context is admitted right before its prompt, often in the same millisecond, while the prompt's ID is minted earlier on the client. Sends mint context IDs before the prompt ID and show those synthetic records optimistically with the prompt's timestamp, so the context renders on the prompt from the first frame and the server records reconcile in place. Optimistic records carry the client's clock, so a page that returns the server's copy of one replaces the client's copy outright, unless a live event already did; otherwise a remote client whose clock runs ahead keeps its prompt sorted after the reply. Message IDs are identity and reconciliation keys, not chronology: OpenCode's fixed-width sortable timestamp prefix rolls over, so a newer `msg_000...` can follow an older `msg_fff...`. Fetch, pagination, materialization, optimistic insertion, events, reconnect inspection, rendering, and revert/undo/redo must preserve this contract.
11. Session-scoped ArrowUp and ArrowDown recall merges the visible transcript's user prompts (`useUserMessageHistory`) with the persisted input-history bucket for runtime + normalized directory + session identity. Revert markers hide prompts from the transcript source only; the persisted bucket still recalls them. Global scope reads the persisted runtime bucket alone.
12. Part arrays preserve authoritative response/event order. Part IDs are identity keys and have the same rollover limitation; identity lookup/removal must not require a part array to be lexically ID-sorted.

Pages the loader reads ask for finished tool results as shells
(`lib/opencode/toolContentShells.ts`, server side
`packages/web/server/lib/opencode/message-shells.js`): a completed or failed
call keeps its status, time, input, metadata and error, and its result text is
replaced by an `openchamberContentShell` marker in its metadata. The adapter
sends the request header only to a server that lists
`api.message-part-shells.v1` among its `/api/version` capabilities, learned
once per runtime when the sync provider starts; an older server on another
origin would refuse the unknown header at CORS preflight and fail the page.
Rows that need the result (an expanded tool, an extension header that reads
`{output}`) complete the message by id through `tool-content-completion.ts`;
a failed or empty completion shows a retry, never an empty result. A page's
shell never replaces a whole call the store already holds
(`mergeMaterializedPart`), so a tail refresh cannot undo a completion or a
live call. Every tool row opens on a click, so the client keeps no tool whole;
file edits and subagent calls are never shelled by the server. Single-message reads are
always whole, and so are calls arriving by the event stream, except `read` and
`skill`: their rows open the file in the app and never show the result, so the
reducer drops it the moment the call finishes (`withoutUnshownResult`), with
the same marker.

Tool completion checks existing transcript membership and a result shell before
requesting `getToolContentMessage`. This dedicated adapter operation may read
ancestors as described in `lib/opencode/DOCUMENTATION.md`; ordinary message
reads remain session-strict. Completion writes only into the original store
while the runtime and message are still current, so an evicted store or a
removed message is never recreated by the response.

A successful local session creation publishes its session record and calls `SessionMessageLoader.initializeCreatedSession` before selection starts navigation loading. The create response establishes an empty transcript only if no transcript has arrived yet. Initialization supersedes an earlier unresolved history load, preserves any messages or metadata received before the create response, and uses the server-returned directory. Opening that new session needs no history read; forced recovery and later eviction still use normal fetching. Creation responses from a previous runtime cannot select or initialize a session in the current runtime.

Initial loads use smaller requests on constrained VS Code/mobile surfaces and publish the cursor-extended ten-turn window described above. The mounted chat timeline requests one history batch when its pinned viewport is underfilled, when the user scrolls toward history, or when load older is pressed; mobile uses the explicit button. Timeline caches, pending work, prepend snapshots, and stale checks use runtime + directory + session identity so equal session IDs in different worktrees cannot share lifecycle state. Older pages are fetched through the same loader and merged with optimistic records before publication. The same chronology contract applies in the VS Code webview because it consumes this shared loader and sync store; the extension bridge must transport OpenCode records without introducing its own ID-based ordering.

## Failed-turn diagnostics

Successful HTML responses and the packaged protocol's `runtime-unavailable` response are definite routing failures. The SDK boundary rejects them before decoding and marks the normalized error through `lib/relay/transport-error.ts`. Send-failure classification uses that authority before HTTP timeout heuristics, so even the packaged `503` uses normal optimistic rollback. These failures do not count against a model provider's circuit. Requests whose outcome the transport cannot confirm remain ambiguous and are not retried as definite rejections.

A `session.error` event is the live account of a turn OpenCode stopped, and
it can arrive with no assistant message to attach to. Since OpenCode 2.0.27
the `idle` record that closes a failed turn keeps the same error, so after a
reload `SessionErrorNotice` reads it from history (`findRecordedTurnError`)
and shows it where the live event would have. `session-error-log.ts`
keeps the last 20 of them in memory (`recordSessionError`, fed from the
event pipeline next to the error notification) and `summarizeOpenCodeError`
reads the `{ type, message }` structured error the event carries. The chat shows the newest
error for the open session under its last message while that turn is the
latest one (`SessionErrorNotice`), and also names a user message that an idle
session has left unanswered for five seconds, since an accepted send that
produced neither a message nor an error would otherwise look like nothing
happened. Before that no-reply notice shows, the session tail is re-read
from the server (the live stream may have dropped the reply); the notice
appears only if that read settles with the prompt still last, or fails. Two
more reads, at 10 and 30 seconds, keep running under the visible notice so a
late reply still replaces it. An error the transcript prints on a message is
classified before it is shown: `lib/messages/assistantError.ts` reads the
`{ name | type, message }` shape once and names the interruptions — OpenCode's
`MessageAbortedError` / "Step interrupted" and this client's own `aborted`
close — as the stop they are, so a deliberate Stop never reads as a failed
send. Both buffers — session errors and rejected sends — appear in full
in `__opencodeDebug.statusReport()` together with the managed OpenCode
process's last error and stderr tail. The diagnostic timeline
(Ctrl/Cmd+Shift+L, see `lib/diagnostics/DOCUMENTATION.md`) carries them
with numbered session labels and the error class only.

## Loading diagnostics

Session loading instrumentation is disabled by default. Set `localStorage.openchamber_session_load_perf` to `"1"`, reproduce the interaction, then inspect `window.__openchamberSessionLoadPerformance.events`.

The bounded event buffer records only controlled bootstrap, message, and global-list operation/caller labels with queue/duration, outcome, retry count, and downloaded record count where applicable. Message-page events also record the requested limit and whether a cursor was present. When diagnostics are enabled, the selected chat records its first painted renderable message snapshot once per recent session identity and immediately clears the corresponding browser performance entry after emitting the trace mark. Canceled frames retain no measured identity, so returning to that session can schedule a replacement measurement; completed identity tracking uses the same 1,000-entry ceiling as the event buffer. Exported events never retain runtime keys, directories, session IDs, credentials, or message content. Initial-message expansion counts every downloaded page, not only the accepted page. The browser profiler independently validates the known labels and finite numeric fields before export. Instrumentation is diagnostic only; unit/type/lint checks do not replace production runtime profiling at representative project/session scale.

High-frequency sync diagnostics are separately disabled by default. Set `localStorage.openchamber_sync_perf` to `"1"` before reload to enable fixed numeric counters for pipeline traffic, reducer publications, streaming reconciliations, entries/messages visited, targeted heartbeat work, and persistence serialization/write volume. The hot path performs only a null check while disabled; counters never retain IDs, payloads, or user content.

Browser profiling also enables `localStorage.openchamber_stream_perf` to capture bounded aggregate timings and render counts for chat projections, message components, and major sidebar boundaries. These metrics contain no session IDs or user content and are reset immediately before each recording.

The profiler also emits a user-timing mark when pending global-session recency is committed at a lifecycle edge. `summary.json.longTaskAttribution` correlates that mark with enclosing long tasks without recording session data.

Streaming assistant and reasoning text is throttled once before reaching the
Markdown renderer. The existing visibility/commit layer controls when source
is shown; Streamdown owns parsing and React block updates after that boundary.
The renderer adds no character-pacing timer or application HTML block cache.
Native code components own their shell, line numbers and application-owned
highlighting: Highlights on the main thread for the languages it has a lexer
for, the Shiki worker for the rest. Non-Markdown code views and CodeMirror use
the same split independently of Markdown rendering.

The event pipeline delivers each ordered per-directory flush as one reducer batch. Events retain their individual notifications, cleanup, routing, materialization, and debug side effects, while directory mutations accumulate in order and publish one store transaction per touched directory. Global session mutations and live status, ordering, and timing transitions also accumulate in event order and each owner publishes at most once for the flush. Each top-level state slice is cloned lazily at most once in that batch; no-op events do not change references.

A sustained stream is flushed at most every 100ms (`FLUSH_FRAME_MS`); the first event after a quiet spell is flushed at once, so a lone permission or status event is never held back. The interval matches the 100ms at which streamed text is shown: each flush publishes the directory store and re-renders the streaming message, so a shorter interval pays for renders that change nothing on screen. Measure with `bun run profile:session` against the fixture provider before changing it.

Streaming lifecycle derivation has two paths. Directory attach, switch, bootstrap, and reconnect may perform a full reconciliation. Normal store publications reconcile only sessions whose `session_status` or `message` bucket changed; part-only events update the affected streaming message heartbeat directly and must not rescan all busy sessions.

A trailing assistant message that the server stamped `time.completed` is never marked as streaming: the stamp means the whole response (text plus every tool call) finished, so even while the session stays busy for the next step of the turn, the typing indicator and the streaming part-update suspension must not linger on finished content. The message-level streaming state (`streamingMessageIds` / `messageStreamStates`) is therefore a *message* lifecycle, not a turn lifecycle — it is completed by an explicit `time.completed`, by a newer trailing message, or by the session leaving `busy`.

When an assistant `message.updated` event carries `time.completed` and the store still believes the session busy, sync schedules one deferred status check (`maybePollStatusAfterMessageCompletion`, ~750ms). The status is re-read when the timer fires, so a normal turn whose `session.idle` lands inside that window issues no request at all; only a still-busy session spends a directory status poll, sharing the watchdog's one-in-flight-per-directory guard. The invariant is unchanged from the watchdog escalation: the monotonic pass confirms or raises active status and never lowers it, and an authoritative resync runs only when the snapshot disagrees with a store that still believes the session busy. This narrows the stuck-spinner window after a lost `session.idle` from a watchdog interval to one round-trip; the 5s watchdog poll remains the backstop.

A sent prompt sets its session busy before the request goes out, and OpenCode answers the request only after it admits the prompt. A directory starting cold, with plugins or MCP servers that take a while, holds the request open for that long, and until then the active-session list does not name the session. `prompts-in-flight.ts` counts the prompt requests `optimisticSend` has open per session. While one is open, no status snapshot lowers that session: the authoritative pass and the directory bootstrap snapshot keep its busy status in the directory store and in the global status store the sidebar reads, and the watchdog does not escalate for it. Lowering it there made the chat read as idle on an unanswered prompt, and five seconds later `SessionErrorNotice` reported a reply that never started while the folder was still starting (#4875). Live `session.status`, `session.idle` and `session.error` events still settle the session, and a rejected send rolls its status back to idle itself.

Incomplete-session materialization is deduplicated by runtime, directory, and session for the full cooldown window, including after a fast success or failure. A settled-running-tool recovery may supersede a different request in that window so an earlier pre-settlement refresh cannot consume the only terminal recovery signal. Deferred recovery is dropped if its captured runtime is no longer active. If recovery requests a tail refresh while an older load is in flight, one refresh runs after that load instead of losing the newer authority demand. Completion retains the cooldown marker until expiry, and an older completion cannot clear a newer request marker. Recovery starts after the current ordered event batch and rechecks whether local state already contains the requested entity before starting HTTP. An explicit empty part bucket is authoritative fetched-empty state, not a missing snapshot. This prevents repeated orphan/missing-part events from creating message-tail and status request storms while preserving later recovery.

When `session.idle` or `session.error` settles a session but the trailing assistant message still contains a `pending` or `running` tool, sync refreshes that session tail. This narrowly reconciles a missed terminal tool-part event without refetching normally completed turns or stale tools from older turns. A stale refresh or delayed part event cannot regress a locally observed terminal tool to an active status.

A completed assistant message is authoritative for its own tool parts. During materialization, a `pending` or `running` tool under `time.completed` becomes `error`/`Interrupted` with an end time. This handles stale persisted tool state during reload. The merge preserves a terminal part already observed live, and a later terminal server snapshot can replace the local interrupted marker.

A turn is marked stopped only when OpenCode says it stopped: a `session.execution.interrupted` event (any reason but `shutdown`, which keeps the turn for resumption) or `session.execution.failed`, translated to `session.idle` with `outcome: "interrupted"` and to `session.error`, or, in loaded history, an `idle` record after the trailing assistant message whose outcome is `interrupted` or `failed` (`markRecordedInterruptedTurn`, run after every message load; the newest record after that message decides). The server does not always finalize the message and its parts before that record (anomalyco/opencode#19023), so with no pending form/permission and the session not running again, the unfinished assistant message is completed locally (`closedLocally`) with the error OpenCode reported for a failed turn (the live `session.error`, or since 2.0.27 the `idle` record's `error`) and with an `aborted` structured error for a stopped turn or a failure that came without one, including text-only turns and turns whose tools had already finished, and any active parts are finalized as `error`/`Interrupted` with an end time (`errorSource: "local"` marks the manufactured end, so `sync/recoverable-questions.ts` can tell it from OpenCode's own report and a later authoritative tool transition supersedes it), so tool timers stop and cards render the error state. A later terminal event can supersede the mark, while a stale unfinished refresh cannot regress the locally finalized message or parts. Supersession is concrete: a `message.patched` that carries `time.completed` without an error drops the local mark and its error, and a server snapshot whose assistant record is completed replaces a record this client still holds open or marked. Nothing else marks a turn: not an idle status, a status snapshot that lowers or drops a session, a `session.idle` without outcome or with `succeeded`, nor an unfinished answer on its own. OpenCode keeps run state per process, so a turn another OpenCode process runs on the same database (the TUI, `opencode run`) reads exactly like that while it is still going (openchamber#4156). The cost is deliberate: a turn whose process was hard-killed (crash, force quit, power loss) has no record, because nothing ran to write it, and stays open until the session is stopped or continued. A plain `opencode serve`, which is what OpenChamber manages, does not sweep such turns on start; OpenCode's registered service mode does (`SessionRestart`).

Directory stores also own session-keyed sidecar notification channels for permissions, forms, and message materialization. Collapsed sidebar rows group their hidden descendants by owning directory and subscribe to the exact permission and form buckets; expanded rows subscribe only to their own buckets. High-frequency realtime part events annotate the exact session/message before committing, so visible records, user history, renderability, and sidebar permission and question rows are not notified by unrelated sessions. Structural message replacements notify only changed subscribed session buckets; unannotated bulk part replacement conservatively resets active message subscribers so bootstrap, pagination, rollback, and legacy writers cannot leave stale projections.

Message sidecar consumers also filter targeted updates by purpose before notifying React. Suspended live-tail text/reasoning changes do not rebuild visible message records, but structural Task session identity changes bypass suspension so a parent can link a newly created subagent immediately. Assistant-only part changes do not rebuild user input history, and targeted updates that preserve authoritative part buckets do not recheck a session that is already renderable. Message replacements, removed final part buckets, and conservative resets always notify.

## Session directory resolution

`session-directory-resolution.ts` owns the precedence used to answer "which directory does this session belong to". Every send, message fetch, message-queue key, and send-confirmation lookup is routed by that answer, so a wrong value is not a display problem: the prompt is posted against a directory that does not own the session, the request is rejected, and the optimistic message is rolled back with no visible error.

Precedence, highest authority first:

The discriminator is whether the server confirmed the path, not whether the value is local or synced.

| Source | Meaning |
|---|---|
| `authoritative` | The session record's own directory, then a child store that holds it |
| `selected` | Server-confirmed directory captured at selection; a guessed one is never passed |
| `attachment` | Worktree attachment recorded by this client; the *requested* path |
| `worktree-metadata` | Worktree captured when the session was created in one; the *requested* path |
| `remembered` | Per-runtime directory persisted across restarts |

Rules:

1. Ownership comes from the session record's own `directory`. When directory sync has no owning record yet, the global session index supplies that record's directory before local selection, worktree, or remembered hints. `getSyncSessionDirectory()` reports *containment*, not ownership, and is only the fallback for a record without a directory: a project's session list includes the sessions of its worktrees so the sidebar can group them, so the parent repository holds worktree sessions too, and reading ownership from membership routes a worktree session to its parent. `null` means "not indexed yet", never "no directory".
2. A project opened on a folder of its repository (`repo/ai`) starts the sessions of its worktrees in the same folder of the checkout, so a session's directory can lie inside its worktree. `WorktreeMetadata.path` and `worktreeRoot` stay the checkout root for Git, bootstrap, removal and moves; only the session directory, the attachment's `cwd` (`setWorktreeMetadata(sessionId, metadata, cwd)`) and the draft's first directory take the folder. `lib/worktrees/worktreeStartDirectory.ts` is the one owner: it reads the project's folder from git (`resolveGitRepositoryPrefix`, one operation on every runtime: the toplevel route's `prefix` over HTTP, `api:git/repository-prefix` in VS Code), waits for the checkout, confirms the folder exists inside it, and answers with the root plus a reason otherwise. Its only rejection is a checkout that never populated; `resolveCreatedWorktreeStartDirectory` then removes the worktree the caller just created, with its branch, and rethrows. A guest's `startSession` keeps that worktree instead, because the SDK contract hands it to the guest as `bootstrap-failed`. A session moved into another worktree takes the folder of its own project (`resolveFolderProjectRef`, `projectPathForCheckoutFolder` in `lib/worktrees/worktreePaths.ts`): with `repo` and `repo/ai` both registered, the project owning the worktree list is `repo`, yet a session in `<worktree>/ai/src` keeps `ai`, as `session.moveToWorktree` on the server does. Every lookup that maps a session's directory to its worktree is prefix based (`findWorktreeHoldingDirectory`, `findPrefixWorktreeEntry`, `isWorktreeDirectory`, the parent walk of the sidebar's session ownership, the guest workspace projection, multi-run's `locateRunMember`): the longest checkout holding the directory wins, and a checkout that holds a registered project, such as the primary checkout `repo` of the project `repo/ai`, is never a session's worktree. Exact comparison stays where the input is a worktree root by contract: refreshing one worktree's metadata (`getLatestWorktreeMetadata`), a guest naming an existing worktree, and the draft rule above, which resolves a start folder only for a draft aimed at a worktree's root. `attachment` and `worktreeMetadata` hold the worktree path this client asked for, before the server canonicalized it. They are a hint for a session sync has not indexed yet, never a correction of a confirmed directory — otherwise a stale local path re-creates the very mismatch this precedence exists to prevent.
3. Never persist or rank a guessed directory. `selectSession` may fall back to the active directory to keep routing usable, but that value is not written to runtime memory, not written to the last-active snapshot, and not passed as `selected` — a persisted guess outlives the race that produced it and survives reloads and restarts.
4. Components must not read `currentSessionDirectory` to build request or queue keys; use `getDirectoryForSession()` so every consumer resolves identically. `session-actions.ts` resolves the directory for rename, share, archive and delete the same way: the global record's own directory first, directory-store containment only as a fallback. A project root's store indexes status, permissions and questions for its worktrees' sessions, so containment there named the root for a worktree session and the server rejected the mutation with 404/500.
5. A disagreement between sources is logged once per session, and `__opencodeDebug.diagnoseSessionDirectory()` reports every source in precedence order.
6. Opening a session by id (`?session=` routes, deep links, in-chat session links) can select it twice: first with a guessed directory, then with the real one after `ensureGlobalSessionsLoaded`. The directory is part of the chat's session key, so the timeline remounts, and the first timeline may already have shown the target. Work tied to the entry must survive the second entry: a message-link request (`lib/router/messageFocus.ts`) ends on a user gesture, on entering another session, on a missing message, or after 60 s, never because the message was shown once.

## AI session titles

`use-session-ai-rename.ts` connects the shared menus to Small Model and the
existing title action. `session-title-context.ts` uses `SessionMessageLoader`
to page backward only until three completed user/final-answer pairs are covered.
Opening a menu checks eligibility on demand; row mounts do not load history.
The collector uses chronological records (a turn is a user message plus the last
assistant message before the next one), excludes unfinished, failed, summary,
synthetic-only and reverted turns, and retains user-attached context even when
its transport part is synthetic. The Small Model input is the current session
title followed by those turns. Sessions usually end on housekeeping requests
such as "commit and push", so the system prompt in `lib/sessionTitle.ts` names
the work those requests refer to and uses the current title as the anchor when
the turns still match it.

`session-title-generation.ts` owns runtime/directory/session-scoped pending
operations. Manual title saves cancel generation before sending their write.
Runtime changes abort pending generation, including a switch away and back.
After generation, a fresh session read rejects changed titles, directories,
archive state and revert markers before the normal title action saves. Failure
retains the old title and always releases pending state. The current OpenCode
title endpoint has no compare-and-set operation, so another client's write
after this final read cannot be guarded atomically.

`lib/messages/messageMarkdown.ts` formats attached quotes and user comments for
both title context and Markdown export. Export keeps full text; title input
limits individual fields and each message while retaining head/tail excerpts.
Web, Electron, hosted mobile and Capacitor use the existing Small Model route.
Mobile session rows expose the same action inside the manual rename editor
(swipe, then rename), with a session-scoped generation spinner on the row.
VS Code has no Small Model route and exposes a disabled action with an explicit
explanation.

## Session action rules

- Archive, restore and delete return booleans and id lists through the store contract shared by sidebar rows, the bulk bar and the mobile sheet. The reason behind a failure is recorded separately in `session-action-failures.ts` at the catch site and taken once by the surface that reports it, so the toast can quote the OpenCode status, error class and log `ref` (`OpencodeApiError` from `lib/opencode/client.ts`, which keeps `tag`, `detail` and `ref` from the tagged body) instead of a bare "failed". Rename fails loudly the same way and closes its form.

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. Sending after a revert commits the new branch optimistically: remove the reverted tail and marker before inserting the new message, and restore both if the send is rejected.
5. Composer and queued sends carry their captured runtime, directory, and session through asynchronous preparation. A runtime change cancels the send instead of re-resolving it against the new runtime. Outside VS Code the queue itself is server-owned (`packages/web/server/lib/message-queue/`): the UI hands the server the captured send configuration, resolved text, attachments, and attached context at queue time and the server delivers on idle; the composer only sends a queued message itself after taking it back from the server (`takeForSend`). See the `messageQueueStore.ts` section in `stores/DOCUMENTATION.md`.
6. A draft aimed at a worktree's root creates its session in the project's folder inside it (`resolveDraftStartDirectory`), and the composer's agent and model catalog is activated for that folder while the draft is open. The preview stays quiet; the send reports a fallback to the worktree root. After session creation, the directory returned by the server is authoritative over the requested draft directory. The server may canonicalize a worktree path, and the first prompt must use the same directory identity as the created session. A first send shows the message in the worktree root before that folder is resolved; when the session ends up elsewhere, `adoptSessionMove` carries the transcript there and the chat follows (see *A draft's first send*).
7. Regular new-chat drafts that inherit the persisted current/last directory must not create a session against a confirmed-missing path. Fall back to the active project only when OpenChamber's directory stat reports the directory missing; keep explicit worktree targets, in-flight worktree creation, and unknown/offline probes unchanged, and do not persist the fallback until session creation succeeds. A concurrent draft rewrite to that same active-project fallback must not abort session creation while the draft is still open (`materializeOpenDraftSession`); a first send has already closed the draft, so its probe (`recoverMissingDraftDirectory`) has no draft change to check for.
8. A prompt send that fails **after** the request left the client is ambiguous, never a definite failure: the server may already be answering it. Transports tag those errors (`markAmbiguousTransportFailure` in `@/lib/relay/transport-error`): the relay tunnel tags every stream that dies with a request in flight, and the SDK boundary tags the plain `Transport` reason, which is a fetch that rejected or a body that died mid-read. `isAmbiguousSendFailure` reads the tag before falling back to status/text heuristics. An ambiguous failure waits for the connection to return, refetches recent messages, and confirms the optimistic message in place instead of rolling it back — rolling it back lets the message queue re-send a prompt the engine is already running, producing two independent AI responses for one user message.
9. `SessionLiveActivity` has three answers and `unknown` is never `idle`. `getSessionLiveActivity` reports `active` when any child store or the global session-status index holds a non-idle status. Idle requires an explicit idle event or a successful status snapshot in the session's owning directory. A loaded list, a parent repository containing the worktree session, or an omitted global active-index entry does not grant idle authority. Callers that gate a destructive action, such as worktree moves, must refuse on `unknown`.
10. Revert and unrevert cascade through known descendant sessions before mutating the parent. Revert uses the first descendant user message at or after the parent's target timestamp, including equal timestamps because message IDs do not define chronology. A descendant failure is logged and does not block its siblings or the parent. The parent runs last so its shared-directory file snapshot remains authoritative. A busy descendant is aborted before it is reverted, like the parent, so nothing keeps writing past the revert boundary. Redo clears the revert marker on every descendant, including markers the user set on a subagent independently of the parent undo.
11. Starting a session from an assistant answer carries the source session ID, rendered directory, and answer text into the action. It must not rediscover that context from the globally active child store or the OpenCode client's fallback directory: the visible session may belong to an existing worktree while the active provider directory points elsewhere. New isolated worktrees resolve their registered parent project from that captured directory, preferring recorded worktree metadata when available. The dialog offers creation only after the project root is confirmed as a Git repository, and the creation boundary repeats that check so stale or bypassed UI state cannot run Git commands against a non-repository directory; failures leave the dialog open and visible.
12. Slash commands use `session.command` so OpenCode expands their templates. Slash skills use the optimistic prompt path with native skill attachments, preserving the original text and any inline skill mentions. A cached command takes precedence over a same-name skill in the session's directory. Both routes carry files and admit attached context, including session knowledge, as synthetic messages before sending.
13. A prompt's optimistic message appears before the session's project knowledge is written (`POST /api/session-knowledge/sync`, which puts it into the session's OpenCode instruction entries). `sendMessage` starts the write alongside the goal write and hands it to `routeMessage` as `knowledgeSync`; `optimisticSend` inserts the prompt at once and only the prompt request waits for it (`ready`). The command route awaits it before `session.command`; shell sends do not write it. The knowledge is never a message in the transcript, so a revert cannot cut it.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` / `archiveSessions()` -> wait for server confirmation, then upsert each archived session
- `unarchiveSession()` / `unarchiveSessions()` -> wait for server confirmation, then upsert each restored session. Restoring a top-level session brings its archived subsessions back with it. A subsession under an archived or unknown parent comes back only with that parent, and its id alone fails. A subsession archived on its own while its parent stays active restores alone and brings its own archived subsessions; `isRestorableOnItsOwn` (`session-restore-rule.ts`) is the one rule, shared with the Archive page and the chat header's session menu. `undo` still puts back exactly what an archive just moved.
- `deleteSession()` / `deleteSessions()` -> wait for server confirmation or `404`, then remove the session and its persisted state
- `moveSessionToDirectory()` -> move the session between directory stores and update the global directory index
- `session.moved` (an agent's `session_move`, another client, or the echo of our own move) -> `adoptSessionMove()` does the same store move, routing registration and open-chat directory switch. A move the event already applied is kept when the request's response lands later. Without this the chat kept reading the source store while sends went to the destination, so a new prompt never appeared until the session was reopened. A chat pinned in the side panel (a subagent opened from the parent) is not the open chat; it reads the directory its session record names (`usePinnedSessionDirectory`), so it follows the move too instead of freezing at the move step. In a flushed batch the move runs after the stores publish, so the batch cannot write the session back into the source. The move also drops the session's transcript and status from every other store and moves any pending permission or form they held into the destination; their session lists keep it, because a parent repository lists its worktrees' sessions. OpenCode reports the move's own steps (the delivered move notice) in the source directory in that same flush, and the transcript recovery they ask for runs after the move. A recovery for a session the store removed, no longer lists, and the global list places in another directory goes to that directory's store instead: read in the source, it put the transcript back into the store the session left, and the gap stayed in the one the chat reads.

### Blocking-request (form/permission) reply routing

`replyToForm`, `cancelForm`, `respondToPermission`, and `dismissPermission` route the reply through `resolveDirectoryForBlockingRequest`. The directory chosen decides which OpenCode instance resolves the pending request, so it must be the **session record's own server-confirmed directory** (ownership), never the containing child-store key (containment): a project store legitimately holds its worktree sessions, and a reply addressed to the parent instance makes the server answer `FormNotFoundError` while the form stays pending in the worktree instance — the session is then stuck on the running form tool with no recovery. When a form reply/cancel comes back not-found, the stale request is removed locally and a `settled-running-tool` tail materialization is enqueued so the trailing tool part converges to the server's actual state instead of leaving the UI on "asking question" forever. A permission reply/reject that comes back not-found only removes the request locally.

Sending a message while forms are open cancels them through `dismissOpenFormsForSession`, which removes them from the store before the cancel request so the card disappears at once. A not-found answer keeps them removed. Any other failure puts each form back into the store and session it came from: the agent is still waiting, and no event will return it. The mounted chat's form-only recovery would refetch the open session's own form, but a subagent's form shown in the parent chat has no other path back. Open permissions follow the same rule through `dismissOpenPermissionsForSession`, which rejects them: a not-found answer keeps them removed, any other failure puts each one back. Permissions have no in-chat recovery at all, so without the restore even the open session's own prompt stays hidden until a reconnect. A restored card can belong to a request the server already settled (its response was lost, or another client answered it); any reply from the card then comes back not-found, and `respondToPermission` removes it. The same cleanup applies to its other callers, VS Code auto-accept and the desktop tray's approve action.

A lost question can be answered through a new paid turn in the asking session. `recoverable-questions.ts` captures only observed session-owned question forms with a tool link. Recovery requires that linked call's exact interruption error or a local interrupted-turn mark. A recorded interrupted or failed turn also grants that mark to stale active tools finalized by materialization under an already completed assistant message; the server's completed message stays unchanged. Explicit replies and local dismissals veto recovery; shutdown, still-running calls and unknown evidence do not qualify. Later authoritative tool transitions supersede local marks.

Recovery is memory-only and retains the last 100 captured questions together with their outcomes and tool dispositions. Closed questions remain tombstoned within that window; eviction forgets the question and its auxiliary records together. Session deletion clears its entries and runtime switching clears everything. These cards do not hold directories, protect caches or count as blocking requests. Both form surfaces warn about the new paid turn, use the normal send path with a per-request lock, and retain drafts after rejected sends. Recovered answers explicitly disable Goal Mode for their turn and leave the main composer's armed goal untouched.

### Why recovery needs a linked tool outcome

A missing form can have been answered on another client. Recovery therefore requires request-specific turn-death evidence; missing forms, idle status and disconnects alone cannot re-ask a question.

### Restore (unarchive) contract

An explicitly user-initiated composer send restores an archived top-level
session after OpenCode accepts the prompt or command. Queueing from the
composer is the same intent: the session is restored once the queue accepts
the message, so delivery itself never restores anything and the server queue
has no archive logic. A prompt an agent or the CLI sends through
`session.send` is the same intent, and the server restores the session there
once OpenCode accepts it (`restoreAfterSend` in
`packages/web/server/lib/openchamber-sessions/routes.js`), with its archived
subsessions. Opening the archive, typing, shell commands, scheduled
tasks and automated continuations do not restore it. The send captures the
session's archive timestamp and runtime; a newer archive, manual restore or
runtime switch supersedes that intent. Restoration uses the existing tree
action, so archived subsessions come back with the session, and reports
failure separately from the accepted message, so a restore failure cannot
cause a duplicate send.

OpenCode holds archive state since 2.1: archive and restore go through
OpenChamber's batch routes (`session-archive-batch.ts`), which set it on
OpenCode's record, and OpenCode announces `session.archived` /
`session.unarchived` to every client, so a session archived in the TUI moves
here too, and since 2.2 that works for a session whose directory was deleted.
The server folds the archive file an older OpenChamber wrote onto the records
it serves until its entries move to OpenCode, and announces the change as
`openchamber:session-archived` when one leaves. Restore clears
`time.archived`; every reader classifies archive state by its truthiness.

OpenCode's `archived` list filter cannot see the sessions only that file
marks, so the global sessions store loads every session of a scope and splits
active from archived client-side (`splitGlobalSessionsByArchived`). A restored
session re-enters its live directory store through the event; until then it
remains fully visible through the global store (sidebar, switcher) and
addressable by ID (message loading).

The full-app collection retains active records whose directory is absent from
the current topology. Display grouping first resolves exact configured
project/worktree ownership. If that fails, authoritative OpenCode project
metadata may resolve the record only when its canonical worktree maps to a
configured project root. The fallback never replaces the session's real
directory for requests. An unresolved record has no guaranteed project group.
VS Code keeps exact workspace-directory scope without this fallback. Mobile
uses the same resolver as the full-app sidebar.

Archive and delete actions capture the active runtime key when they start and
recheck it before every store reconciliation, so a response
produced by the previous runtime is rejected instead of mutating the current
runtime's live or global session state. Restore follows the same guard: a
stale completion returns `false` without touching any store. A guarded batch
stops at the first observed runtime change: sessions the server already
confirmed remain archived, restored, or deleted and stay in
`archivedIds`/`restoredIds`/`deletedIds`, while every ID not confirmed on the
captured runtime is returned in `failedIds` so existing partial-failure
feedback stays truthful.
Callers whose confirmation can span a runtime switch may pass an
`expectedRuntimeKey` captured earlier; ordinary callers are guarded by default.

`unarchiveSession` clears the archive timestamp in the session's existing directory. It never moves the session, including when that directory is missing. Server failure keeps the session archived locally; confirmation updates the global cache and reads fresh live status for an existing child store. A failed status read does not undo a confirmed restore or claim the session is idle. If the runtime switches after confirmation, the status read cannot write into the new runtime, but the confirmed restore still returns success on the captured runtime. `unarchiveSessions` preserves partial results and stops committing when its captured runtime changes.

### Deletion runtime guard

Deletion needs this guard more than archiving does. Session IDs are not unique
across runtimes, and a committed deletion does more than hide a row: it evicts
the session from every live store, removes it from the global cache, clears the
current-session pointer, and calls `cleanupPersistedSessionState`, which erases
that session's queued messages, todos, folder membership, inline-comment drafts,
chat draft, and pins. Committing a stale deletion can therefore destroy user
state belonging to an unrelated session on the new runtime.

`cleanupPersistedSessionState` already refuses an identity whose runtime is no
longer active, so `finalizeConfirmedSessionDeletion` must forward the **captured**
runtime key. Passing the live key would make that check compare a value with
itself and always pass. The in-memory live, global, and UI stores it mutates are
not runtime-scoped, so the calling action must reject a stale runtime before
committing rather than relying on that helper alone.

A `404` still means "already deleted" and commits cleanup, but only while the
captured runtime is active. After a runtime change the `404` describes either
the previous runtime or one this session never belonged to, so the action
reports failure instead of committing. The deletion already accepted by the
server stays deleted there; its persisted state is left as harmless stale
metadata and the next authoritative load reconciles it.

### Missing worktree directories

Existing sessions keep their directory when a worktree disappears. Session activation makes no directory-availability probe, and terminal failures and archive restoration never move sessions. Manual movement still goes through `moveSessionToDirectory`. Worktree deletion still archives its sessions before removing the worktree. Missing-worktree groups stay visible with a warning so users can choose either action.

After a restore succeeds while its captured runtime is still current, the
action promotes the session through the ordering-only restore entry point. That
rank is ephemeral and resets with runtime ordering. It does not alter server
timestamps, synthesize activity, or change live status. Recent keeps its
existing active/48-hour membership rule.

## The golden rule

### Managed chat directories

Ordinary user-created drafts default to the OpenChamber-managed Chat target. The first submit creates one isolated directory under the server-resolved managed chats root (`OPENCHAMBER_CHATS_DIR`, default `~/.config/openchamber/chats`) as `YYYY-MM-DD/session-<id>` before creating the OpenCode session. That root acts as a system project owner for sidebar membership and Notes, Todo, Plans, pinned knowledge, and project memory, but it is never persisted or rendered as a user project and exposes no Git/worktree controls. Project and worktree actions remain explicit targets. Archiving retains a chat directory so restore remains lossless. Confirmed deletion accepts only descendants of the configured root or the actual server home's legacy chats root. It rejects both shared roots themselves, dot segments, lookalike paths elsewhere, and a runtime switch during root resolution. It also removes a directory only once no other known session still resolves to it: forks, side threads, and subagents share the directory of the chat that created them, and OpenCode fails every prompt in a session whose directory is gone. The deleted session's own subtree does not count, because the server cascade-deletes it, and an unloaded global cache keeps the directory because it cannot prove it is unused. It never removes project directories.

The home API also supplies filesystem-confirmed `canonicalChatsRoot` and
`canonicalLegacyChatsRoot` aliases. Membership and cleanup compare each alias
exactly, protecting the shared roots themselves. Helpers still return the original
configured/legacy root as the identity for folders and scopes. Older servers
without these fields retain exact matching against their original roots; the UI
never guesses filesystem case sensitivity from the client's operating system.

The UI never guesses the chats root from the home either. `getChatsRoot` is
null until the home API answers, and `useChatsRoot` re-renders its readers
(the sidebar's chats group, a chat draft's effective directory, the project
context owner) once it does. With `OPENCHAMBER_DATA_DIR` the root is outside the
home and the home's legacy folder does not exist, so a guessed root failed to
initialize and the chats group said "Could not initialize workspace."

Typing the first character in a managed Chat draft starts one deduplicated directory preparation for that draft. The first send consumes the prepared directory before `createSession`, removing filesystem creation from the usual submit path. Closing the draft, changing it to a project target, or completing preparation after the runtime/draft changed deletes the unclaimed directory. A create failure also deletes the consumed directory.

### A draft's first send

Enter in a draft makes it a session on the spot. `sendMessage` mints the session id (`descendingId("ses")`: OpenCode mints session ids counting down with time, so the client's lists where the server's would, and `session.create` accepts the id), opens an empty transcript for it (`openPendingSessionTranscript`), saves its selection, selects it with the `submitted-draft` transition (which closes the draft), and publishes a `pendingDraftSends` entry for it. The prompt then goes through the same `routeMessage` and `optimisticSend` as any other send: the user message is inserted at once, without marking the session busy (no agent works yet, so no working status shows next to "Creating session…"), and the request waits on `ready`, which is the session's creation (`createSession` with the minted id and `navigation: "preserve"`, so the response does not re-navigate), the post-creation bookkeeping, the busy mark, the armed goal and the knowledge write. Whether the server has the session is answered by the create response alone; a session created under another id than the minted one is not this one, counts as not created and is deleted best effort. A send that fails once the session exists (a goal or knowledge write, a command lookup, a lost connection before the insert) leaves the session in place, idle again, with its text back in its composer. The waits that decide where the session is shown (a worktree still being made, a chat folder being prepared) happen before the switch, with the draft still open and its own status line; the waits that only delay creation (a worktree's setup commands, the start folder inside a worktree, the missing-directory probe) run while the message is on screen, and a session that ends up in another directory than the one it was shown in has its transcript carried there by `adoptSessionMove`.

The entry says what the composer shows: `sessionCreated` false is the "Creating session…" line (shown once the wait has held 300 ms, so a fast server never flashes it); while the entry exists, Send is disabled and Enter does nothing, so a second message cannot reach OpenCode before the first prompt. The response style rides in the same knowledge sync that `ready` covers, so the first prompt reads it from the session's instructions and the message still appears without waiting for that read. The sidebar lists the session once the server has it, as before #5783; the early busy mark that listed it at once is gone. The entry goes when the request that starts the turn leaves the client (`beforeSend` from `opencodeClient.sendMessage` and `sendCommand` right before their last request, after the context parts ahead of it; before `shellSession`), never when it resolves: a prompt request can resolve only after the directory's services started, long after the agent began answering. A shell command therefore does not hold the composer for its lifetime. A draft is sent once (`sentDraftIds`): a second `sendMessage` with the same draft snapshot is refused at the store, creates nothing and keeps the caller's text.

A rejected `ready` is a definite failure, not an ambiguous one: `optimisticSend` rolls the message back without a confirmation read. The store then reopens the same draft object (same `draftId` and `workDraftId`, so the composer's draft key is unchanged and the sent text returns there), clears the pointer a cold launch would restore, removes a chat's directory, and rejects with `DraftSendError`, which names the session, its directory and whether the server created it. The composer restores the text under the identity the error names: the created session's when it exists, the draft's otherwise, with the text typed meanwhile kept above it. A user who moved to another session or draft meanwhile is left where they are; the created session simply is in the sidebar, and a draft that failed to create stays listed.

### Why the session is selected before the server creates it and not shown from inside the draft

The transcript, its scroll, its optimistic shadow and every status index are keyed by session id and directory. Showing the message inside the still-open draft would need a second message system that is re-keyed when the response arrives, and that is what a 450-line attempt grew into. Minting the id on the client makes every record valid from the first frame; the create response finds the transcript, the record and the selection already in place, and nothing is re-keyed. The sidebar lists the session when the server has it, as before.

The global sessions store persists and hydrates one bounded, runtime-scoped startup snapshot containing only active managed chat sessions. Every global session surface, including the main sidebar and Electron Mini Chat switcher, sees that stale snapshot while the global list is unresolved or failed; the first authoritative global snapshot replaces it. Full and directory-scoped global loads resolve the active server's chats roots before fetching or classifying sessions. The store enters loading before resolving roots and hydrates its saved snapshot once roots are available, preserving any newer mutations. Root lookup failure preserves the snapshot for a later retry; a failed global request retains the hydrated sessions. Old runtime completions cannot hydrate or fetch for the destination runtime. Persistence waits for root authority; before hydration it overlays explicit mutations onto the saved seed rather than replacing it with a partial list, and the first page of a still-paginating full load is merged into the visible lists (status stays `loading`) without ever being persisted as that snapshot. Hydration happens once per runtime, so a later global load cannot undo an earlier directory refresh. Runtime reset to idle must hydrate rather than erase the destination runtime's snapshot; authoritative empty, archive, and delete updates do persist the resulting empty or reduced list.

VS Code uses managed Chats only when the host's workspace folder list is empty.
Regular drafts then ignore the last project directory, and the global session
store, sidebar and switcher admit Chats. Windows with folders retain workspace
drafts and exclude Chats from snapshots and live upserts. VS Code does not read
or write the managed Chats startup cache; reopening uses the OpenCode session list.

### Remembering the last draft target

`session-ui-store.ts` persists the side of the composer's target selector the user last worked on under `oc.chatInput.lastDraftTarget`, so a plain new session reopens there instead of always landing on Chat. The record holds a project id, a directory, and `target`, which is `"chat"`, `"project"`, or `null`.

`null` is what a record written before `target` existed reads as, and it leaves the Chat default in place rather than guessing a side from the directory. A recorded project that no longer exists falls back to Chat the same way. Only a picker choice writes `"chat"` or `"project"`.

A session's own directory is not a target choice. "New session in the current directory" forwards the current session's directory even when that session is a managed chat, and a chat scratch directory names no project, so those overrides resolve to a chat draft. Treating one as an explicit project target is how a plus pressed inside a chat opened a project draft.

A live directory that names no registered project is not a target choice either: an implicit, user-initiated open stays on the managed Chat target for that draft and leaves the recorded project target untouched. Delayed stale-directory recovery repairs only project drafts, so it cannot replace that Chat target or its remembered project target.

When creating a draft in `handleDirectoryEvent`, **only clone the state fields the event will mutate**. Never spread all fields eagerly.

```typescript
// WRONG — clones everything, breaks referential equality for all subscribers
const draft = {
  ...current,
  session: [...current.session],
  message: { ...current.message },
  part: { ...current.part },
  permission: { ...current.permission },
  // ...
}

// RIGHT — only clone what this event type touches
const draft = { ...current }
switch (event.type) {
  case "message.part.delta":
    draft.part = { ...current.part }
    break
}
```

## Why this matters

Zustand skips re-renders when a selector returns the same reference (`Object.is`). If you spread `session: [...current.session]` but the event only modifies `part`, the `session` array gets a new reference. Every component using `useSessions()` re-renders for nothing.

During streaming, `message.part.delta` fires ~60 times/sec. Eagerly cloning all fields caused every subscriber in the entire app to re-render 60/sec — a 10x overhead. Targeted cloning reduced MessageList renders from ~1972 to ~296 per session.

## Event → field mapping

Queue recovery is independent of the directory-bootstrap debounce. The sync
provider subscribes to `message-queue-sync.ts` (and to `auto-review-sync.ts`,
which follows the same triggers for auto-review runs) for control-stream updates and
requests a queue refresh on every main-stream connection or transport switch,
including the first connection. The queue store coalesces these requests with
bootstrap and owns snapshot ordering and legacy-upload lifetime.

Chat folders follow the same shape through `session-folders-sync.ts`: the
provider subscribes for the runtime it mounted with, a
`session-folders-changed` control event with a newer revision reads the
server's folders again, and every control-stream connection reads them and
sends the changes still queued. `useSessionFoldersStore` owns the revision
ordering, the queue and the first contact with a server.

Keep this in sync with `handleDirectoryEvent` in `sync-context.tsx`:

| Event type | Fields to clone |
|---|---|
| `session.created/patched/deleted` | `session`, `permission`, `form`, `part`, `sessionEventRevision`, `sessionDeletedRevision` (an archive patch also clears caches) |
| `session.status/idle/error` | `session_status` |
| `message.updated` | `message` |
| `message.patched` | `message` |
| `message.removed` | `message`, `part` |
| `message.part.updated/delta`, `message.tool.transition`, `message.parts.replaced` | `part` |
| `vcs.branch.updated` | (none — mutates `draft.vcs` directly) |
| `permission.asked/replied` | `permission` |
| `form.created/settled` | `form` |
| `openchamber.notification`, `openchamber.permission-auto-accept`, `openchamber.permission-left-for-user` | (none — side effects only) |
| `openchamber.workflow-run` | (none — applied to `useWorkflowRunsStore` in `lib/workflows/store.ts`) |

These are `SyncEvent`s from `packages/ui/src/lib/opencode/events.ts`, not OpenCode wire events: the event pipeline translates every OpenCode 2.x wire event (`session.text.delta`, `session.tool.called`, `session.step.ended`, ...) into this vocabulary before coalescing. Wire-level knowledge lives only in that translator; the reducer applies patches and tool-state transitions against the store.

### Directory-less session events

The global stream can omit a directory for a session-addressed event. OpenCode 2.1.4 can send `permission.asked` without a location. A permission or form event without a directory goes to the directory the global session list records for its session, when that store exists: the chat reads a session's requests from that store, and holding the session proves nothing, since a store the session moved out of gets a copy back when that directory is read again later (a stream reconnect, opening it) and that read points the index at it. Other events resolve through the session routing index first. If the index is briefly stale during a session transition, route only when the event session matches the active session and that directory store exists; otherwise leave it un-routed rather than updating another directory.

## Adding a new event type

1. Add the case to the event reducer (`event-reducer.ts`)
2. Add a corresponding case to the switch in `handleDirectoryEvent` (`sync-context.tsx`) that clones **only** the fields your reducer writes to
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Selector hygiene

### Runtime context versus directory context

`SyncProvider` publishes two contexts. `SyncRuntimeContext` (`useSyncRuntime()`)
holds the child-store manager, message loader, SDK, runtime key, and a
subscribable `currentDirectory` source; its value changes only on runtime
reconfiguration. `SyncContext` (`useSyncSystem()` / `useSync()`) adds the
current directory string, so every consumer re-renders on each directory
switch.

A hook that takes an explicit directory, or needs only runtime fields, must
read `useSyncRuntime()`. `useDirectoryStore(directory)` reads the current
directory through `runtime.currentDirectory` with `useSyncExternalStore`, so a
consumer that passes its own directory gets a constant snapshot and is not
re-rendered by a cross-project switch. This is what keeps sidebar rows
(pending permissions and forms, session lookups) out of the switch commit: a
row must not pay for the chat changing directory.

### Why registry changes reach React readers a microtask later

Sidebar rows call `ensureChild` during render, so a row can create a directory
store mid-render. `subscribeAll` and `subscribeAllSelected` feed
`useSyncExternalStore` readers; calling them from inside that render made React
report a setState in another component (`VisibleSessionProjects`) during a
row's render. Their registry callback attaches the new store's subscription at
once, so no store update is missed, and defers only the reader's notification
by one coalesced microtask. Plain `subscribeRegistry` stays synchronous:
`SessionCacheRetention` must have attached a store before the loader's
`admitPrefetch` that follows `ensureChild`.

### Session switch commit

The sidebar click publishes `currentSessionId`/`currentSessionDirectory`
synchronously, and the message fetch starts before that publication so the
request is on the wire while React renders. `ChatContainer` consumes a
`useDeferredValue` copy of the selection: the first commit paints the cheap
reactions (active row, URL, tabs) and the timeline for the new session renders
in a transition behind it. Selection *policy* inside `ChatContainer` (auto-
opening a draft when nothing is selected) reads the live store value, because
the deferred one still names the previous session for one commit. A selection
arriving from nothing (a draft just submitted, an empty chat) is not deferred:
there is no previous conversation to keep, and a deferred `null` beside the
already-closed draft rendered the empty state for a commit, remounting the
whole column, composer and work-status card included. The same session in
another directory is not deferred either, whatever changed it: the old
directory no longer holds the session or was only a guess (the directory
adopted at startup, a runtime switch, following the chat to its archive, a
new worktree session), so reading the session there is wrong. A move is the
main case: it already took the session out of the old directory's store, and a
commit still naming that directory had the chat's load effect read the session
and its transcript back into it.

A session whose messages are not in memory at the click keeps the previous
timeline on screen while they load (up to 400ms), then swaps straight to the
finished view; the skeleton appears only when loading takes longer. A session
the user waited for fades in (100ms); one that was ready appears in the same
frame. The sidebar prefetches the row on either side of the open session shortly
after it settles, and a row the mouse rests on or keyboard focus reaches for
180ms (`useSessionHoverPrefetch`), so most switches are warm. Both share one
queue with a concurrency cap; VS Code does neither.

The column changes as one. The composer and the status chip above it read
the session the timeline shows (`components/chat/chatColumnSession.ts`), not
the live selection: read live, they re-shaped a commit ahead of the swap
(a taller draft, chips, a working chip) and the outgoing timeline, pinned to
its end, jumped before it was replaced. The reveal effect below runs once per
gate for the same reason — `revealWaited` flips for the outgoing session at
the click, and re-running on it hid that timeline before the next one mounted.

The timeline's first paint for a session is atomic. `ChatContainer` owns a
`TimelineRevealGate` per session key (`components/chat/timelineRevealGate.ts`).
Holds are only for work that moves things on screen: the scroll hook holds it
until the viewport is in place, and a remembered position whose message must
first be loaded raises the cap (below). Markdown does not hold it. Its native
code shell can show readable source while highlighting loads; Streamdown and
the shared CSS own code/table geometry. Highlight updates must preserve content
and avoid moving unrelated rows. Layout parity and large-input costs require
renderer/browser evidence; the shared worker's tests do not establish them.
The timeline root stays at
opacity 0 until every hold releases (capped at 250ms) and the content height
has held still for two frames, then fades in once as a whole. The gate stops
accepting holds after the opening commit so rows mounting during scroll never
hide the timeline. Once the lazy markdown
module has loaded, `MarkdownRenderer` mounts it synchronously instead of
through `Suspense`: a suspended boundary shows its fallback for a tick and
React then throttles later-resolving boundaries by ~300ms, which staggered
user and assistant text on a cold open.

An opened session is shown already in place: at its end, or where the reader
left it. When a list detaches (session switch, chat unmount) and its reader is
away from the live end, `useChatTimelineScroll` records the topmost visible
message and its offset (`lib/scroll/messageViewportAnchor.ts`) in an in-memory,
100-session memory keyed by runtime, directory and session
(`lib/scroll/sessionScrollMemory.ts`); a reader on the end clears the record.
Nothing is persisted across reloads. Re-entering the session aligns that
message frame by frame until it holds still, with follow off and the
scroll-to-bottom pill shown; any wheel, touch, pointer or key input ends the
alignment. Turn group expansion is cached by turn ID in `MessageList` so the
restored rows have the shape they were left with. When the message lies before
the loaded window (the history was evicted meanwhile),
`useChatTimelineController.loadHistoryUntilMessage` loads at most three older
batches while the timeline stays hidden; that hold raises the gate's cap to
800ms, so a fast load shows the session already in place. A slower one reveals
the end first, and the reader is moved only if the message arrives and they
have neither scrolled nor sent in the meantime. Mobile skips that search because it
loads history only on an explicit tap.

A message link opens the session on one message instead. Links are built and
parsed in `lib/sessionLinks.ts`: the web copies `?session=<id>&message=<id>` on
its own origin, desktop and the Capacitor app copy
`openchamber://session/<id>?message=<id>`, and VS Code offers no link because
its sessions live on its own OpenCode. Every entry point (the web route, the
desktop `openchamber:open-session` event, mobile deep links, a session link
clicked in chat content) calls `openSessionLink`, which records the message in
`lib/router/messageFocus.ts` and opens the session through the route opener so
a cross-project session resolves its directory. The timeline serves the
request on entry, ahead of a remembered position, or immediately when that
session is already open. Being shown does not end the request: a link can
select its session twice, first under a guessed directory and then under the
one the session list reports, and the second timeline must show the message
again whether the first was torn down mid-search or had already shown it. The
request ends when the message proves missing, when the reader takes the
viewport (any real gesture), when another session is entered, or after a
minute. A repeated click on the same link is a new request and is shown
again. Controls that raise a request can show progress through a separate
status channel (`subscribeMessageFocusStatus`, `readMessageFocusInFlight`):
the timeline marks a request shown when it lands, which is progress and does
not serve the request again. The message lands just below the scroller's top fade
(`--scroll-shadow-size` plus a small gap), not inside it where it reads as
cut off, and is tinted briefly (`[data-message-link-target]`). A target
folded into a collapsed turn (an assistant step before the turn's last one,
whose text lives in the folded activity) opens that turn first
(`MessageList` `revealFoldedMessage`), the way a browser's find opens a closed
`<details>`; the final answer is visible folded and opens nothing. Message
search uses this path: a hit in Cmd+P (`components/ui/commandPaletteMessages`)
opens its message through `openSessionLink`, and the in-conversation bar
(`components/chat/search`) moves between hits with `requestMessageFocus`,
painting matches with the CSS Custom Highlight API. The index itself is the
server's (`packages/web/server/lib/message-search`). A linked message outside the
loaded window is first checked with one `session.message.get` request: a 404
shows a "not in this session" toast, anything else loads older history until
the message or the start of the history, on every runtime including mobile.
Chat markdown keeps `openchamber://` hrefs only for session links and turns
pasted ones into links; pairing and other routes stay stripped. A web session
link opens in place when it points at the page's origin or at the instance
the app is connected to (the desktop page has its own scheme, so a link to
its connected remote host would otherwise leave through the host-window
path). On desktop a link to a saved instance opens in that instance's app
window: an open window for the instance takes it (brought to the front and
moved to the session through `openchamber:open-session`), otherwise
`openHostWindow` creates one on the session route; "New window" from the
instance switcher always opens a fresh one. A link to any other address
keeps the external path. A session
deep link that launches the desktop app arrives before the renderer listens:
`main.mjs` keeps it pending and the main window takes it on mount through
`desktop_take_pending_session_links` (`takePendingDesktopSessionLinks`); a
late flush still emits it to a renderer that never asks. A desktop session
link can name the saved instance that owns the session (`?host=<id>`, `local`
for the app's own server). Main passes it on as the runtime key a
notification click carries, and the receiving window routes both the same
way: a window on that instance opens the session in place, any other hands
it to `openHostWindow` through `desktop_open_host_session`, together with
the `?message=` it names. A mini-chat routes them the same way, since with
the main window closed it is the window that receives them. The renderer
decides because main cannot: a window can switch instance in place, so
only its runtime key says what it shows. On desktop a window reports that
key to main at boot and on every switch (`desktop_set_window_runtime_key`),
and `openHostWindow` looks for a window to reuse first by the live key,
then by the creation-time tag: a link that names an instance lands in
whichever open window shows it, including a main window switched in place
and a switcher window opened for a direct instance, which main marks the
same way it marks relay windows. A notification a window forwards names its
owner by the same rule: the instance the window reports, and the creation-time
tag only before it has reported. A notification click brings the receiving
window forward only when it already shows the instance that owns the
session; otherwise the window it hands the session to is the one raised.

On launch the app reopens the session that was open when it closed
(`sync/last-session-restore.ts`, used by `App` for web and desktop and by the
Capacitor shell). `setCurrentSession` persists the pointer per runtime and a
user-opened draft clears it, so the pointer names exactly what was on screen;
without one the launch stays on the automatic draft. The shell shows before
OpenCode is ready, so `App` selects the session in a layout effect
(`beginLastSessionRestore`), before any passive effect of the tree runs;
ChatContainer's passive effect would otherwise open the automatic draft first
and the launch would flash it. Selecting needs no OpenCode answer: the
directory is the pointer's own, or the persisted session list's. The header
takes the title from the directory's persisted session list when that holds
the session, and the transcript shows its loading state, or the cached
transcript, until OpenCode answers (see *Session message loading*). The
authoritative session list checks the choice afterwards. While OpenCode is
starting the list falls back to what the store holds and marks itself
`error`; the check reports `failed`, changes nothing, and `App` runs it again
once initialization completes. Only a completed list load may say the session
is gone (deleted or archived): then the pointer is dropped if it still names
that session, and the chat falls back to the draft only if that session is
still the one on screen. A session the list places in another directory is
reselected there. When the directory is unknown, or a route names a session,
nothing is selected up front and the restore waits for the list as before
(`restoreLastActiveSession`). The Capacitor shell keeps its own overlay and
calls `restoreLastActiveSession` after it connects. A route, link, or click
that selected a session first wins. The sidebar's project session selection
(`useProjectSessionSelection`) ignores the project active when the list
mounts and reacts only to later project switches; it used to pick that
project's remembered or first session on launch. For the same reason the
restore passes `keepSingleProject`, so reopening a session does not rewrite
the sidebar's remembered One project picker: the restore is launch state, not
the user choosing a project. The selection keeps that policy in memory until
the next navigation, so a space's project arriving later also leaves the picker
alone while making the restored session's project active.

The scroll hook holds the gate
until the viewport is in place. The reveal itself runs on the frames after the
last hold releases, pinning against the content height until it settles. Afterwards "at the end" is an invariant, not a scroll:
while the reader sits on the end of a session that is not producing output,
content growth re-pins with one instant write; output growth belongs to the
follow logic, which glides only while the session is working.

`useChatTimelineScroll` retires an outgoing scroll container through
`components/chat/lib/scroll/retireScrollContent.ts`. Chromium can retain a
queued scroll event's target while animation frames are suspended, keeping its
detached conversation tree alive. After React's commit, a microtask clears the
retired container's remaining children. The
cleanup requires both a disconnected node and released ownership, so ref
reattachment, Strict Mode and connected hidden views keep their contents.
Markdown has no detached DOM transfer cache. This shared cleanup runs
independently of animation frames across all chat runtimes.

`bun run profile:switch` measures both moments; see `scripts/perf/DOCUMENTATION.md`.

### Pinned chat columns

A chat opened in the side panel ("Open in side panel" or Shift-click on a
sidebar row, a subtask, a review session) is a second `ChatContainer` in the same app, pinned to its session
(`pinnedSession`). It used to be an iframe that booted a whole second app per
tab. The main chat follows the app's selection; a pinned column keeps its own
and changes only through its own navigation (open a subtask in place, return
to the parent), never the main chat's selection or draft.

Everything inside a chat reads its session through `chatColumnSession.ts`:
`useChatSessionSelection()` is the column's session inside a column and the
live selection elsewhere (it does not subscribe to the selection inside one),
`useEffectiveDirectory` resolves the column's session, and
`useChatColumnActions()` routes what a chat does on its own behalf: open a
session, open the timeline dialog, focus its composer. App-wide state the main
chat drives stays the main chat's: the work-status panel and its flags, the
prompt navigator's keyboard panel, the global timeline dialog, the expanded
composer preference, and the new-session draft. A pinned column keeps local
copies where it needs them and leaves the global ones untouched, including on
mount and unmount. Double Escape in a column's composer stops that column's
session: the column root names its session and whether it runs
(`data-chat-column`, `data-chat-session-id`, `data-chat-working`).

The composer's per-column state (model selection, attachments, pending text
and context) is described in the composer documentation, *Pinned composer*.

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
useDirectorySync((s) => s.permission)

// RIGHT — returns the value for one key, stable unless that key changes
useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)
```

Same applies to `useStreamingStore` — select `.get(key)` not the Map itself.

A session record and a session's message list are replaced on every streamed
step (`session.updated` moves `time.updated`), so always-mounted chrome that
reads a few fields of either goes through `useSessionSelector` or
`useSessionMessagesSelector` with an equality for the derived value, never
`useSession` or `useSessionMessages`. `useSessionDirectory` is one such
selector. The same holds for a directory's session list: `useSessions`
changes on every streamed step, so a reader that needs when sessions started
uses `useSessionStartTimes`, which changes only when a session is added or
removed. A list that must ignore sessions another source already holds reads
`useLiveSessionsExcluding(ids)` instead of filtering `useAllLiveSessions()`.

## Store splitting pattern

### Why split

A single Zustand store with N properties means every subscriber's selector re-evaluates on every state change — even if the change is unrelated to what that subscriber reads. During streaming, `sessionMemoryState` updates ~60/sec. Before the split, all 68+ `useSessionUIStore` subscribers re-evaluated on each update. After splitting into focused stores, only `useViewportStore` subscribers (2-3 components) re-evaluate.

The optimization multiplies with targeted event cloning: fewer new references per event × fewer subscribers per store = dramatically less work per SSE frame.

### The stores

| Store | Owns | When it changes |
|-------|------|-----------------|
| `session-ui-store.ts` | Session selection, draft lifecycle, abort, worktree, SDK actions | Session switch, draft open/close |
| `voice-store.ts` | Voice connection/activity state | Voice toggle |
| `input-store.ts` | Pending input text, synthetic parts, attached files, pending guest attach | User typing, file attach, revert/fork, guest chip |
| `selection-store.ts` | Per-session model/agent/variant choices | Model/agent picker |
| `viewport-store.ts` | Scroll anchors, session memory state, sync status | Streaming, scroll, session switch |

### Rules for new UI state

1. **Never add to `session-ui-store`** unless it's session selection, draft lifecycle, or abort state
2. **Group by change frequency** — state that changes during streaming (viewport, memory) must not live with state that changes on user action (selections, input)
3. **Skip canonical no-ops** — selecting a session must not republish an already-reset draft; session ID and directory remain the authoritative navigation publication.
4. **Group by subscriber set** — if only 2 components read a value, it should be in a store that only those 2 components subscribe to
5. **Prefer a new store over growing an existing one** if the new state has different subscribers or change frequency
6. **Cross-store reads use `.getState()`** — actions in one store that need to read another store call `useOtherStore.getState()` (imperative, no subscription)

### Anti-patterns

```typescript
// WRONG — stuffing unrelated state into one store
const useEverythingStore = create(() => ({
  voiceMode: "idle",
  scrollAnchor: 0,
  selectedModel: null,
  pendingInput: "",
  // 20 more fields...
}))

// RIGHT — separate stores by concern + change frequency
const useVoiceStore = create(() => ({ voiceMode: "idle" }))
const useViewportStore = create(() => ({ scrollAnchor: 0 }))
const useSelectionStore = create(() => ({ selectedModel: null }))
const useInputStore = create(() => ({ pendingInput: "" }))
```

## Sends before OpenCode is ready

The app shell and composer are usable before OpenCode answers its first health check. `opencode-startup-gate.ts` holds a send made in that window: `sendMessage` and `waitForConnectionOrThrow` await `waitForOpenCodeStartup`, which resolves when the page first connects, and rejects after three minutes or on a runtime switch so the composer restores the text. Only the page's first connection waits this way; after OpenCode has connected once, a disconnect keeps the short reconnect grace and fails a send quickly. `useOpenCodeStartupStore().waitingSends` counts the held sends; while it is above zero the composer footer shows a quiet "Waiting for OpenCode…" note beside the send button. `sendMessage` runs through `runAfterOpenCodeStartup`, which releases held sends one at a time in the order they were made: each starts only after the one before it was handed to OpenCode or failed, and a send made while held sends are still going out queues behind them. Released together, a later message could reach OpenCode first.
