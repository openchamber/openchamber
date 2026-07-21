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
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

## Session list rules

### Directory bootstrap scheduling

`ChildStoreManager` is the single owner of directory bootstrap scheduling. Consumers publish demand; they must not start bootstrap from row mount effects.

- The scheduler runs at most two directory bootstraps concurrently.
- Selected session/current directory demand outranks active-project, expanded, visible, and background demand.
- Demand is deduplicated by normalized directory and can be promoted while queued.
- The complete known project/worktree set is always published. Collapsed and off-screen directories remain background demand, so they refresh eventually rather than waiting for expansion.
- A bootstrap holds its scheduler slot through all bootstrap phases and the directory session-list fetch.
- A mounted directory-store consumer pins that store for its lifetime. Eviction may dispose only unmounted directories, so optimistic actions and realtime events cannot move to a replacement store while visible React consumers remain subscribed to an older identity.
- Reconfiguration and runtime switching invalidate stale generations. A stale completion must not publish state into the new runtime.
- Failure is recorded as `failed`; it is not converted into a successful empty snapshot. Forced demand can retry failed or completed work.

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

Imperative cross-directory session lookups use the cached ID index from `getAllSyncSessionMap()`. The index is rebuilt only when a child store's `state.session` reference changes; permission lineage checks must reuse it instead of rebuilding a full session map per call.

VS Code does not run the server permission-auto-accept runtime. The extension host persists and broadcasts authoritative policy, while its foreground UI runtime resolves missing child-session lineage through the OpenCode API before deciding whether to suppress and answer a `permission.asked` event. Enabling the policy and reconnect/bootstrap both reconcile pending requests in the session directory, including requests inherited by child sessions. Unknown lineage and exhausted reply retries fail closed and leave the request available for manual action. A later `permission.replied` event invalidates any older deferred ask so the async policy check cannot resurrect a resolved request. With every OpenChamber webview closed or suspended no responder runs; this is an intentional VS Code limitation. Other runtimes remain fully server-owned.

### Mutation responsibility

`useGlobalSessionsStore` is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. session create/update/delete events; recency-only updates for existing sessions are retained latest-per-session and committed once on `session.idle`/`session.error`, while structural updates and create/delete remain immediate and runtime switching discards pending updates
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

Initial loads use smaller pages on constrained VS Code/mobile surfaces. Older pages are fetched through the same loader and merged with optimistic records before publication.

## Loading diagnostics

Session loading instrumentation is disabled by default. Set `localStorage.openchamber_session_load_perf` to `"1"`, reproduce the interaction, then inspect `window.__openchamberSessionLoadPerformance.events`.

The bounded event buffer records bootstrap, message, and global-list operations with queue/duration, caller, outcome, retry count, and record count where applicable. Instrumentation is diagnostic only; unit/type/lint checks do not replace production runtime profiling at representative project/session scale.

High-frequency sync diagnostics are separately disabled by default. Set `localStorage.openchamber_sync_perf` to `"1"` before reload to enable fixed numeric counters for pipeline traffic, reducer publications, streaming reconciliations, entries/messages visited, targeted heartbeat work, and persistence serialization/write volume. The hot path performs only a null check while disabled; counters never retain IDs, payloads, or user content.

Browser profiling also enables `localStorage.openchamber_stream_perf` to capture bounded aggregate timings and render counts for chat projections, message components, and major sidebar boundaries. These metrics contain no session IDs or user content and are reset immediately before each recording.

The profiler also emits a user-timing mark when pending global-session recency is committed at a lifecycle edge. `summary.json.longTaskAttribution` correlates that mark with enclosing long tasks without recording session data.

Streaming assistant and reasoning text is throttled once before reaching the markdown renderer. The renderer incrementally reconciles changed markdown blocks but does not add a second character-pacing timer, which would multiply parse/morph work while catching up on large streamed chunks.

The event pipeline delivers each ordered per-directory flush as one reducer batch. Events retain their individual global indexes, notifications, cleanup, routing, materialization, and debug side effects, while their directory mutations accumulate in order and publish one store transaction per touched directory. Each top-level state slice is cloned lazily at most once in that batch; no-op events do not change references.

Streaming lifecycle derivation has two paths. Directory attach, switch, bootstrap, and reconnect may perform a full reconciliation. Normal store publications reconcile only sessions whose `session_status` or `message` bucket changed; part-only events update the affected streaming message heartbeat directly and must not rescan all busy sessions.

Incomplete-session materialization is deduplicated by directory and session for the full cooldown window, including after a fast success or failure. Completion retains the cooldown marker until expiry, and an older completion cannot clear a newer request marker. Recovery starts after the current ordered event batch and rechecks whether local state already contains the requested entity before starting HTTP. An explicit empty part bucket is authoritative fetched-empty state, not a missing snapshot. This prevents repeated orphan/missing-part events from creating message-tail and status request storms while preserving later recovery.

Directory stores also own session-keyed sidecar notification channels for permissions and message materialization. High-frequency realtime part events annotate the exact session/message before committing, so visible records, user history, renderability, and sidebar permission rows are not notified by unrelated sessions. Structural message replacements notify only changed subscribed session buckets; unannotated bulk part replacement conservatively resets active message subscribers so bootstrap, pagination, rollback, and legacy writers cannot leave stale projections.

Message sidecar consumers also filter targeted updates by purpose before notifying React. Suspended live-tail part changes do not rebuild visible message records, assistant-only part changes do not rebuild user input history, and targeted updates that preserve authoritative part buckets do not recheck a session that is already renderable. Message replacements, removed final part buckets, and conservative resets always notify.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> waits for server confirmation, then upserts the archived session
- `deleteSession()` -> waits for server confirmation or `404`, then removes the session and its persisted state
- `moveSessionToDirectory()` -> move the session between directory stores and update the global directory index

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
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part` |
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
