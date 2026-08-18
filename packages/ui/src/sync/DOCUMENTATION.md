# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Directory-scoped sync stores**
   - Owned by the sync layer child stores created in `sync-context.tsx`
   - Source for per-directory live session/message/part/permission/question state
   - Backed by SSE / directory-scoped polling
   - Read via hooks like `useSessions()`, `useDirectorySync()`, `getSyncSessions()`, `getDirectoryState()`

2. **Global sessions cache**
   - Owned by `packages/ui/src/stores/useGlobalSessionsStore.ts`
   - Shared source of truth for the Sessions sidebar global lists and Session Retention cleanup
   - Holds:
     - global active sessions
     - global archived sessions
     - active sessions indexed by directory

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

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| `ChildStoreManager` and child directory stores | Priority-scheduled directory bootstrap plus `session`, `message`, `part`, `permission`, `question`, etc. | One runtime and one store per directory |
| `SessionMessageLoader` | Initial message loading, pagination, prefetch, retries, load state, and optimistic reconciliation | One runtime, directory, and session ID |
| `global-session-status.ts` | Incremental non-idle session status index reconciled from events and authoritative directory snapshots | All known directories in the active runtime |
| `session-ordering.ts` | Ephemeral lifecycle rank used by every user-visible session list | All known sessions in the active runtime |
| `session-activity-timing.ts` | Elapsed time of the running turn and of the turn that just finished, plus the persisted starts that survive a reload | All known sessions in the active runtime |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `attachment-files.ts` | Attachment picker allowlists, MIME/content validation, structured-text sanitization, and HEIC conversion | Local chat attachments across shared UI runtimes |
| `document-attachments.ts` | Bounded Office/OpenDocument extraction, document text serialization, embedded-image extraction, and positional citations | DOCX, PPTX, XLSX, ODT, ODP, and ODS chat attachments |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

Local chat attachments are normalized by `attachment-files.ts` before entering `input-store.ts`. PNG, JPEG, GIF, WebP, and PDF retain their media type; HEIC/HEIF is converted to JPEG; recognized text/code formats and unknown files whose first 4 KB are text are sent as `text/plain`; binary files outside the supported media types are rejected. Jupyter notebooks become readable markdown with non-text outputs omitted. HAR credentials, cookies, and sensitive URL parameters are redacted, while request/response body text is omitted. SVG and Draw.io files are attached as source text, not executable/rendered content. Browser and VS Code pickers expose the same allowlist, while drag-and-drop may still accept an unknown extension after content inspection.

Office and OpenDocument packages are metadata-validated before asynchronous extraction, with limits of 20 MB compressed input, 5,000 archive entries, 25 MB per entry, 8 MB per XML part, and 100 MB total uncompressed content. Unsafe or non-canonical archive paths reject the whole attachment, and only XML, relationship, and supported image entries are decompressed and retained. Extracted text, including its explicit truncation notice, is bounded to 500,000 characters so compact but dense Office files cannot consume an entire model context window. XLSX dense rows are serialized as quoted TSV under a single source range instead of repeating every cell address; highly sparse rows retain explicit cell coordinates so distant cells do not generate vast empty TSV spans. Confirmed Office/OpenDocument `@file` mentions are loaded through the runtime filesystem route before submit and use this same extraction pipeline instead of being forwarded as `text/plain` `file://` parts that OpenCode rejects as binary. A failed mention load or extraction leaves the composer intact, and a runtime switch discards preparation from the previous runtime. At most 50 signature-validated PNG, JPEG, GIF, or WebP images and 40 MB of image bytes are retained, with a 20 MB per-image limit; unsupported, invalid, omitted, and truncated content remains explicit in the extracted text. Images whose citations fall beyond text truncation are not attached. Extracted document content remains a `text/plain` file attachment with the original document filename, rather than becoming visible user-message text. Supported embedded images become separate image file parts; the extracted text contains `[filename]` citations at the source paragraph, slide object, spreadsheet cell anchor, or OpenDocument text position. Generated image filenames are re-evaluated if the composer changes during asynchronous preparation, avoiding collisions. The store publishes all generated parts atomically only after every data URL is ready.

The composer compares normalized attachment MIME types with the selected model's declared input modalities. It warns when a newly attached file or an existing attachment after a model change requires an unsupported modality, but does not block sending. Missing modality metadata remains unknown and does not produce a warning.

## Session list rules

### Directory bootstrap scheduling

`ChildStoreManager` is the single owner of directory bootstrap scheduling. Consumers publish demand; they must not start bootstrap from row mount effects.

- The scheduler runs at most two directory bootstraps concurrently.
- Selected session/current directory demand outranks active-project, expanded, visible, and background demand.
- Demand is deduplicated by normalized directory and can be promoted while queued.
- The complete known project/worktree set is always published. Collapsed and off-screen directories remain background demand, so they refresh eventually rather than waiting for expansion.
- A bootstrap holds its scheduler slot through critical state and the authoritative directory session-list fetch. Deferrable command/MCP/LSP/VCS/question/permission enrichment starts afterward without extending slot ownership or competing with the initial session-list request.
- A system-resume signal, including Capacitor foreground resume, refreshes pending questions and permissions only for the active materialized directory. The refresh is deduplicated while in flight, preserves existing state on fetch failure, and leaves unopened directories untouched; normal stream reconnect recovery remains the broader catch-up path.
- When a materialized current turn contains a pending/running question tool but that session's pending question record is missing, the mounted chat performs a question-only recovery scoped to that session. It tries at most three times with delays of 0, 500, and 1,500 ms, stops when the chat unmounts or changes sessions, and guards every attempt against runtime changes. This closes cold-start races without adding requests to ordinary session opens or scanning unrelated sessions and directories.
- A mounted directory-store consumer pins that store for its lifetime. Eviction may dispose only unmounted directories, so optimistic actions and realtime events cannot move to a replacement store while visible React consumers remain subscribed to an older identity.
- Reconfiguration and runtime switching invalidate stale generations. A stale completion must not publish state into the new runtime.
- Failure is recorded as `failed`; it is not converted into a successful empty snapshot. Forced demand can retry failed or completed work.
- A failed bootstrap is classified as `os-permission` only when the owning runtime filesystem API independently confirms `EPERM`/`EACCES` for that exact directory. OpenCode/proxy error text is never used as permission evidence. The scheduler retains the directory-scoped reason so local Desktop can offer native folder selection before a forced retry.

Bootstrap remains stale-while-revalidate: a directory store may paint persisted sessions immediately, but only a successful authoritative fetch may replace that cached list.

Directory session lists record whether their current snapshot is empty, persisted, live-event-derived, or authoritative. Bootstrap captures a mutation revision before starting its requests. Its completion replaces persisted data, including with a successful empty response, then overlays only session events and direct move/archive/delete mutations newer than that revision. It must not preserve the entire cached list as a race fallback because that would retain stale persisted sessions.

The roots request is authoritative for root completeness. The broader child-session request has independent completeness: a successful empty response clears stale children, while a failed request preserves known children and their required ancestors without turning the failure into an empty snapshot.

The persisted session snapshot keeps up to 50 sessions selected by `time.updated`/`time.created`, not ID ordering. Non-empty updates coalesce to the latest runtime-directory snapshot and flush on lifecycle suspension; runtime switches reject stale pending writes. Successful empty results persist an empty v2 tombstone synchronously so legacy data cannot reappear on restart. If localStorage quota prevents the full snapshot, persistence retries with progressively smaller recent snapshots and removes stale current/legacy values rather than leaving an old list indefinitely.

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

An authoritative `session.deleted` event also clears persisted UI state before routing metadata can be removed. Confirmed local deletion and accepted `404` deletion do the same directly instead of depending on the event echo. Cleanup is identity-owned by runtime, normalized directory, and session ID: queued messages, persisted todos, composer drafts, inline-comment drafts, and pins clear only that tuple, while the active runtime's folder store removes the session from every active or archived folder scope. Stale-runtime events and unresolved/global directory identities do not mutate persisted state.

Persisted sidebar state is never reconciled destructively from the first successful startup list. That list establishes an authoritative active+archived baseline. Only a session present in that baseline and omitted from a later complete snapshot is treated as a missed external deletion. Archive and directory moves retain the session ID across snapshots and are not deletion cleanup. This favors harmless hidden stale metadata over irreversible user-state loss when startup data is incomplete.

Session materialization recency is keyed by runtime and directory. Foreground loads and successful prefetches participate in the same bounded per-directory session LRU. Prefetch pagination metadata has a global count ceiling and is removed with session eviction, directory disposal, loader runtime reconfiguration, and loader disposal.

### Global session list

Use `useGlobalSessionsStore` when the UI needs a **shared global session cache**.

Current consumers:

- `useSessionAutoCleanup.ts`

### Live cross-directory session/status view

Use the sync hooks backed by aggregated child stores when the UI needs **live truth** for sessions or statuses across all initialized directories.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx`
- `Header.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()` / `useAllSessionStatuses()`

Cross-directory selectors subscribe to the narrow child-store field they aggregate. Session aggregation listens to `state.session`. Live busy/retry state is also maintained in `global-session-status.ts`, where each row subscribes to one session ID instead of scanning every child store. Events update the index incrementally; authoritative per-directory status snapshots seed it, clear sessions omitted as idle, and reconcile missed events. Unrelated streaming events such as `message.part.delta` must not trigger global session/status scans.

Session display order is independent from streaming-frequency `time.updated` publications. `session-ordering.ts` promotes a session exactly when its authoritative activity phase crosses `settled` (`idle`/`error`) and `active` (`busy`/`retry`) in either direction. Repeated busy/retry or idle/error events are no-ops. The first authoritative status snapshot establishes a baseline without synthetic promotions; later snapshots reconcile missed transitions. Root sessions compare lifecycle rank only with other roots, while child sessions compare lifecycle rank only with siblings sharing the same `parentID`, so child activity never moves its root conversation. Pins remain the first ordering bucket. The timestamp/creation fallback is frozen when a session first participates in ordering, so later metadata-only updates cannot reorder it; creation time and ID provide deterministic ties. Runtime switches clear all phases, baselines, and ranks.

`session-activity-timing.ts` measures how long a turn has been running, because `SessionStatus` carries no timestamps. It is driven from the same two write paths as `global-session-status.ts`, so a row can never count a turn that index calls idle. A session gains a start on its first `active` observation and keeps it across repeated busy/retry events; settling converts that start into a finished duration, which rows show only while the session is unread and which is therefore never persisted.

Starts are persisted so a reload resumes the same count, but a persisted start is a lookup table and never a claim of activity. **Nothing in the protocol marks where a turn begins.** OpenCode calls `SessionStatus.set` with `busy` at every step of the agent loop and publishes an event each time, so a busy event means "still running", not "just started"; after a refresh one of those repeats normally beats the first status snapshot, so treating it as a turn boundary reset the counter on nearly every reload. Turn *ends* are marked — `session.idle` and `session.error` fire once, live, and retire the persisted record — while a snapshot that omits a session is not evidence of anything, since it may simply not see it yet.

That leaves the case with no observable answer: a turn that ended, and another that began, entirely while the tab was gone. Two bounds stand in for the evidence the client cannot have. A liveness stamp sits beside the start — refreshed while the session is observed active, at most every 15s, and stamped precisely as the page hides (`pagehide`/`visibilitychange`/`freeze`, written immediately rather than through deferred storage so it cannot lose that race) — and is compared against this page's `performance.timeOrigin`, so the measure is how long the app was absent rather than how long bootstrap took; a 20-second startup must not spend the allowance. Records may only be adopted within 90s of load, after which they are discarded — a backstop for a runtime whose event stream is down and where snapshots are therefore the only signal. A runtime switch resets the module, since the previous instance's turns are not ours.

Reconciliation walks the running turns and asks the snapshot whether it covers each one, rather than being handed everything the snapshot covers. Only a live start can settle, and there are a handful of those against a directory's hundreds of sessions, so the pass stays proportional to the timing work and allocates nothing per poll. Malformed, wrong-shaped, over-age, and future-dated entries are rejected on read. The payload is not runtime-scoped: records live for seconds and are keyed by instance-unique session IDs, whereas the runtime key is derived from injected globals and is not guaranteed stable across early startup — a read under a key the previous page never wrote to is indistinguishable from "no turn was running".

**Only the stamp expires a persisted start.** A snapshot that covers a session without reporting it busy is not proof the turn ended: bootstrap fetches status and sessions in parallel and directory scopes resolve at different times, so a snapshot legitimately arrives before it can see a running session. Treating one of those as a settle deleted the start moments before the real busy snapshot arrived, which reset every counter to zero on reload. Settles therefore act only on sessions that already have a live start in this page session.

The active-session watchdog in `sync-context.tsx` (per-directory status polls and child-session discovery lists) runs its network calls through the shared background-network gate in `@/lib/background-network`, alongside poll-shaped git reads, global session pages, and command/skill discovery. Background fan-out must stay under that gate so the browser's per-origin connection pool keeps free sockets for interactive traffic — an uncapped startup burst previously queued the first session-open message fetch for seconds.

Imperative cross-directory session lookups use the cached ID index from `getAllSyncSessionMap()`. The index is rebuilt only when a child store's `state.session` reference changes; permission lineage checks must reuse it instead of rebuilding a full session map per call.

VS Code does not run the server permission-auto-accept runtime. The extension host persists and broadcasts authoritative policy, while its foreground UI runtime resolves missing child-session lineage through the OpenCode API before deciding whether to suppress and answer a `permission.asked` event. Once policy is enabled, a live `permission.asked` event sends the directory-scoped `permission.reply` immediately and does not block on a permission-state preflight request. Enabling the policy treats permission cards already present in the directory store the same way and replies immediately, then reconciles the server's pending list with a state preflight so stale already-resolved requests are not replied to or resurrected. Reconnect/bootstrap also uses the preflight while reconciling pending requests in the session directory, including requests inherited by child sessions. Unknown lineage and exhausted reply retries fail closed and leave the request available for manual action. A later `permission.replied` event invalidates any older deferred ask so the async policy check cannot resurrect a resolved request. With every OpenChamber webview closed or suspended no responder runs; this is an intentional VS Code limitation. Other runtimes remain fully server-owned.

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

## Session message loading

`SessionMessageLoader` is the shared authority for session message requests. Navigation, reactive chat loading, sidebar prefetch, pagination, reconnect/recovery, and optimistic reconciliation must delegate to it rather than issuing parallel initial requests.

Rules:

1. Request identity is runtime key + normalized directory + session ID. Session IDs alone are not globally unique across runtimes or directories.
2. One in-flight request is shared by all callers. Foreground demand may promote the visible load kind of an existing prefetch without starting another request.
3. Load state is explicit per session: `idle`, `loading`, `ready`, or `error`. Fetch failure preserves prior materialized records and exposes retry; it never becomes authoritative empty success.
4. Async commits are generation-checked. Runtime switches, forced refreshes, eviction, and disposal must reject stale completion.
5. Prefetch coverage and persisted directory data are runtime-scoped. Legacy persisted directory entries may seed startup continuity, but they are not live truth.
6. Message and part materialization preserves references for unchanged records and maintains direct message-to-parts lookup. Consumers subscribe to the selected session's records rather than broad message/part containers.
7. Pagination demand must carry the selected session's effective directory. It must not fall back to the sync provider directory because the visible session may belong to another worktree.
8. The ref-stable loader is disposed only after the current task when its provider unmounts. This lets React Strict Mode's development setup → cleanup → setup probe retain a usable loader for child effects, while real disposal still invalidates the preceding lifecycle's work.
9. Transcript arrays are chronological by `message.time.created`, with message ID used only as a deterministic equal-time tie-breaker. Message IDs are identity and reconciliation keys, not chronology: OpenCode's fixed-width sortable timestamp prefix rolls over, so a newer `msg_000...` can follow an older `msg_fff...`. Fetch, pagination, materialization, optimistic insertion, events, reconnect inspection, rendering, and revert/undo/redo must preserve this contract.
10. Part arrays preserve authoritative response/event order. Part IDs are identity keys and have the same rollover limitation; identity lookup/removal must not require a part array to be lexically ID-sorted.

Initial loads use smaller pages on constrained VS Code/mobile surfaces. Prefetch resolves only the initial renderable page; it does not eagerly download older history. The mounted chat timeline requests older pages when its viewport is underfilled or the user scrolls toward history, while mobile uses its explicit load-older action. Timeline caches, pending work, prepend snapshots, and stale checks use runtime + directory + session identity so equal session IDs in different worktrees cannot share lifecycle state. Older pages are fetched through the same loader and merged with optimistic records before publication. The same chronology contract applies in the VS Code webview because it consumes this shared loader and sync store; the extension bridge must transport OpenCode records without introducing its own ID-based ordering.

## Loading diagnostics

Session loading instrumentation is disabled by default. Set `localStorage.openchamber_session_load_perf` to `"1"`, reproduce the interaction, then inspect `window.__openchamberSessionLoadPerformance.events`.

The bounded event buffer records only controlled bootstrap, message, and global-list operation/caller labels with queue/duration, outcome, retry count, and downloaded record count where applicable. Message-page events also record the requested limit and whether a cursor was present. When diagnostics are enabled, the selected chat records its first painted renderable message snapshot once per recent session identity and immediately clears the corresponding browser performance entry after emitting the trace mark. Canceled frames retain no measured identity, so returning to that session can schedule a replacement measurement; completed identity tracking uses the same 1,000-entry ceiling as the event buffer. Exported events never retain runtime keys, directories, session IDs, credentials, or message content. Initial-message expansion counts every downloaded page, not only the accepted page. The browser profiler independently validates the known labels and finite numeric fields before export. Instrumentation is diagnostic only; unit/type/lint checks do not replace production runtime profiling at representative project/session scale.

High-frequency sync diagnostics are separately disabled by default. Set `localStorage.openchamber_sync_perf` to `"1"` before reload to enable fixed numeric counters for pipeline traffic, reducer publications, streaming reconciliations, entries/messages visited, targeted heartbeat work, and persistence serialization/write volume. The hot path performs only a null check while disabled; counters never retain IDs, payloads, or user content.

Browser profiling also enables `localStorage.openchamber_stream_perf` to capture bounded aggregate timings and render counts for chat projections, message components, and major sidebar boundaries. These metrics contain no session IDs or user content and are reset immediately before each recording.

The profiler also emits a user-timing mark when pending global-session recency is committed at a lifecycle edge. `summary.json.longTaskAttribution` correlates that mark with enclosing long tasks without recording session data.

Streaming assistant and reasoning text is throttled once before reaching the markdown renderer. The renderer incrementally reconciles changed markdown blocks but does not add a second character-pacing timer, which would multiply parse/morph work while catching up on large streamed chunks.

The event pipeline delivers each ordered per-directory flush as one reducer batch. Events retain their individual global indexes, notifications, cleanup, routing, materialization, and debug side effects, while their directory mutations accumulate in order and publish one store transaction per touched directory. Each top-level state slice is cloned lazily at most once in that batch; no-op events do not change references.

Streaming lifecycle derivation has two paths. Directory attach, switch, bootstrap, and reconnect may perform a full reconciliation. Normal store publications reconcile only sessions whose `session_status` or `message` bucket changed; part-only events update the affected streaming message heartbeat directly and must not rescan all busy sessions.

Incomplete-session materialization is deduplicated by runtime, directory, and session for the full cooldown window, including after a fast success or failure. A settled-running-tool recovery may supersede a different request in that window so an earlier pre-settlement refresh cannot consume the only terminal recovery signal. Deferred recovery is dropped if its captured runtime is no longer active. If recovery requests a tail refresh while an older load is in flight, one refresh runs after that load instead of losing the newer authority demand. Completion retains the cooldown marker until expiry, and an older completion cannot clear a newer request marker. Recovery starts after the current ordered event batch and rechecks whether local state already contains the requested entity before starting HTTP. An explicit empty part bucket is authoritative fetched-empty state, not a missing snapshot. This prevents repeated orphan/missing-part events from creating message-tail and status request storms while preserving later recovery.

When `session.idle` or `session.error` settles a session but the trailing assistant message still contains a `pending` or `running` tool, sync refreshes that session tail. This narrowly reconciles a missed terminal tool-part event without refetching normally completed turns or stale tools from older turns. A stale refresh or delayed part event cannot regress a locally observed terminal tool to an active status.

When a session is authoritatively settled — `session.idle`/`session.error` event, or an authoritative status snapshot that lowers a previously busy session — and the trailing assistant message is still *unfinished* (`time.completed` missing) with active tool parts and no pending question/permission, the turn is treated as interrupted (managed OpenCode process died mid-turn; the server never finalizes the parts, see openchamber#2577 / anomalyco/opencode#19023). The active parts are finalized locally as `error`/`Interrupted` with an end time, so tool timers stop and cards render the error state. The mark is gated on an explicit idle status (absent status is "unknown", never judged), never applies while the session is busy (including question/permission waits), and a later terminal event or refresh supersedes it while a stale `running` refresh cannot regress it.

Directory stores also own session-keyed sidecar notification channels for permissions, questions, and message materialization. High-frequency realtime part events annotate the exact session/message before committing, so visible records, user history, renderability, and sidebar permission and question rows are not notified by unrelated sessions. Structural message replacements notify only changed subscribed session buckets; unannotated bulk part replacement conservatively resets active message subscribers so bootstrap, pagination, rollback, and legacy writers cannot leave stale projections.

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

1. Ownership comes from the session record's own `directory`. `getSyncSessionDirectory()` reports *containment*, not ownership, and is only the fallback for a record without a directory: a project's session list includes the sessions of its worktrees so the sidebar can group them, so the parent repository holds worktree sessions too, and reading ownership from membership routes a worktree session to its parent. `null` means "not indexed yet", never "no directory".
2. `attachment` and `worktreeMetadata` hold the worktree path this client asked for, before the server canonicalized it. They are a hint for a session sync has not indexed yet, never a correction of a confirmed directory — otherwise a stale local path re-creates the very mismatch this precedence exists to prevent.
3. Never persist or rank a guessed directory. `selectSession` may fall back to the active directory to keep routing usable, but that value is not written to runtime memory, not written to the last-active snapshot, and not passed as `selected` — a persisted guess outlives the race that produced it and survives reloads and restarts.
4. Components must not read `currentSessionDirectory` to build request or queue keys; use `getDirectoryForSession()` so every consumer resolves identically.
5. A disagreement between sources is logged once per session, and `__opencodeDebug.diagnoseSessionDirectory()` reports every source in precedence order.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. Sending after a revert commits the new branch optimistically: remove the reverted tail and marker before inserting the new message, and restore both if the send is rejected.
5. Composer and queued sends carry their captured runtime, directory, and session through asynchronous preparation. A runtime change cancels the send instead of re-resolving it against the new runtime.
6. After session creation, the directory returned by the server is authoritative over the requested draft directory. The server may canonicalize a worktree path, and the first prompt must use the same directory identity as the created session.
7. Regular new-chat drafts that inherit the persisted current/last directory must not create a session against a confirmed-missing path. Fall back to the active project only when OpenCode reports the directory missing; keep explicit worktree targets, in-flight worktree creation, and unknown/offline probes unchanged, and do not persist the fallback until session creation succeeds. A concurrent draft rewrite to that same active-project fallback must not abort session creation.
8. A prompt send that fails **after** the request left the client is ambiguous, never a definite failure: the server may already be answering it. Transports tag those errors (`markAmbiguousTransportFailure` in `@/lib/relay/transport-error`; the relay tunnel tags every stream that dies with a request in flight), and `isAmbiguousSendFailure` reads the tag before falling back to status/text heuristics. An ambiguous failure waits for the connection to return, refetches recent messages, and confirms the optimistic message in place instead of rolling it back — rolling it back lets the message queue re-send a prompt the engine is already running, producing two independent AI responses for one user message.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` / `archiveSessions()` -> wait for server confirmation, then upsert each archived session
- `unarchiveSession()` / `unarchiveSessions()` -> wait for server confirmation, then upsert each restored session
- `deleteSession()` / `deleteSessions()` -> wait for server confirmation or `404`, then remove the session and its persisted state
- `moveSessionToDirectory()` -> move the session between directory stores and update the global directory index

### Blocking-request (question/permission) reply routing

`respondToQuestion`, `rejectQuestion`, `respondToPermission`, and `dismissPermission` route the reply through `resolveDirectoryForBlockingRequest`. The directory chosen decides which OpenCode instance resolves the pending request, so it must be the **session record's own server-confirmed directory** (ownership), never the containing child-store key (containment): a project store legitimately holds its worktree sessions, and a reply addressed to the parent instance makes the server answer `QuestionNotFoundError` while the question stays pending in the worktree instance — the session is then stuck on the running question tool with no recovery. When a reply/reject comes back not-found, the stale request is removed locally and a `settled-running-tool` tail materialization is enqueued so the trailing tool part converges to the server's actual state instead of leaving the UI on "asking question" forever.

### Restore (unarchive) contract

The OpenCode server cannot clear `time.archived` over HTTP: `session.update`
only applies the field when the payload carries a finite number, so an omitted
key is a no-op and `null` is silently ignored. Restore therefore writes
`time.archived = 0` (`UNARCHIVED_TIMESTAMP` in `session-actions.ts`). Every
client-side reader classifies archive state by truthiness of `time.archived`,
so `0` reads as active in the UI, the event reducer, and the OpenCode app/TUI.

The server's `time_archived IS NULL` list filter still excludes such rows, so
any query that wants a truthful active list must fetch inclusively
(`archived: true`) and split client-side (`splitGlobalSessionsByArchived`).
The global sessions store does this for its full and per-directory loads;
directory bootstrap keeps using the server filter because live child stores
must not hold archived sessions. A restored session re-enters its live
directory store through the authoritative `session.updated` event the server
publishes for the update; until then it remains fully visible through the
global store (sidebar, switcher) and addressable by ID (message loading).

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

## The golden rule

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

Keep this in sync with `handleDirectoryEvent` in `sync-context.tsx`:

| Event type | Fields to clone |
|---|---|
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part`; archived/deleted sessions also clone `question` |
| `session.diff` | `session_diff` |
| `session.status` | `session_status` |
| `todo.updated` | `todo` |
| `message.updated` | `message` |
| `message.removed` | `message`, `part` |
| `message.part.updated/removed/delta` | `part` |
| `vcs.branch.updated` | (none — mutates `draft.vcs` directly) |
| `permission.asked/replied` | `permission` |
| `question.asked/replied/rejected` | `question` |
| `lsp.updated` | `lsp` |

### Directory-less session events

The global stream can omit a directory for a session-addressed event. Resolve it through the session routing index first. If the index is briefly stale during a session transition, route only when the event session matches the active session and that directory store exists; otherwise leave it un-routed rather than updating another directory.

## Adding a new event type

1. Add the case to the event reducer (`event-reducer.ts`)
2. Add a corresponding case to the switch in `handleDirectoryEvent` (`sync-context.tsx`) that clones **only** the fields your reducer writes to
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Selector hygiene

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
useDirectorySync((s) => s.permission)

// RIGHT — returns the value for one key, stable unless that key changes
useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)
```

Same applies to `useStreamingStore` — select `.get(key)` not the Map itself.

## Store splitting pattern

### Why split

A single Zustand store with N properties means every subscriber's selector re-evaluates on every state change — even if the change is unrelated to what that subscriber reads. During streaming, `sessionMemoryState` updates ~60/sec. Before the split, all 68+ `useSessionUIStore` subscribers re-evaluated on each update. After splitting into focused stores, only `useViewportStore` subscribers (2-3 components) re-evaluate.

The optimization multiplies with targeted event cloning: fewer new references per event × fewer subscribers per store = dramatically less work per SSE frame.

### The stores

| Store | Owns | When it changes |
|-------|------|-----------------|
| `session-ui-store.ts` | Session selection, draft lifecycle, abort, worktree, SDK actions | Session switch, draft open/close |
| `voice-store.ts` | Voice connection/activity state | Voice toggle |
| `input-store.ts` | Pending input text, synthetic parts, attached files | User typing, file attach, revert/fork |
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
