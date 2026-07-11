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
- Use **aggregated child-store snapshots** for live session/status truth across already initialized directories
- Sidebar-only consumers may create and subscribe to a child store with
  `ensureChild(directory, { bootstrap: false })`. Global events can still route
  live status/permission updates into that store, but merely rendering a cached
  row must never start the directory's full bootstrap.

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| child directory stores in `sync-context.tsx` | `session`, `message`, `part`, `permission`, `question`, etc. | One directory |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

## Session list rules

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

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

### Mutation responsibility

`useGlobalSessionsStore` is not maintained by SSE directly. It is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. direct mutation from session actions after successful SDK calls:
   - create
   - title update
   - share
   - unshare
   - archive
   - delete
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive without requiring a refetch after every change.

Live activity/status indicators must not depend on this cache. They must derive from aggregated child-store state.

Sidebar directory refreshes are intentionally bounded snapshots, not full catalogs:

- active and archived requests are independent and capped at 20 rows per directory
- directory-sync bootstrap also loads only 20 root sessions; it no longer performs a 500-row full pagination pass or a 200-row mixed root/child prefetch
- active requests coalesce by directory with bounded concurrency
- active pagination stores a per-directory cursor; reaching the local Show more boundary requests and appends the next 20 roots
- child sessions arrive through live `session.created` events. Historical
  `session.children` recovery is requested only when the user selects that
  parent session; the startup watchdog must not fan out one request per active
  or persisted parent
- `loadingDirectories` means no usable active snapshot; `refreshingDirectories` keeps stale rows visible
- archived rows load only when the archived bucket is expanded
- retention must wait for `hasLoadedFullCatalog` and use `ensureFullGlobalSessionsLoaded()`, never treat a bounded directory snapshot as authoritative for cleanup

### Electron cold-start ownership

Electron has one durable session-summary source: the runtime-isolated SQLite
session index. The legacy per-directory `localStorage` session list is removed
on child-store creation and must not be reintroduced. `main.tsx` establishes a
startup barrier before React effects; `SessionStartupCoordinator` restores the
SQLite snapshot, refreshes each known root/worktree directory through the
bounded scheduler, writes one transaction batch, then releases normal global
and directory bootstrap. A successful empty root page replaces stale index
rows; a failed page preserves its last good cache.

## Session message loading

- The imperative session-selection path and the reactive `useSync()` path share
  one app-wide single-flight request keyed by runtime, directory, session, and
  pagination cursor. They must not issue duplicate tail requests during a React
  mount or provider remount.
- Session materialization coalescing is scoped to the owning directory store.
  A remounted `SyncProvider` must start its own commit path even when the
  runtime, directory, and session ids match an old in-flight request; transport
  single-flight can still share the HTTP response, but the new store must not
  reuse a promise that only commits into a detached store.
- Initial history is a 30-message tail page on every surface. Commit that page
  immediately; do not expand it to 100/150 messages while searching for a turn
  boundary.
- Older history is user-driven pagination (`loadMore`) only. Desktop and VS Code
  must not automatically prepend a 100-message page after initial render.
- A rejected shared request is removed from the coordinator so the next
  explicit/reactive attempt can retry; failure must never be cached as an empty
  authoritative history.
- Reconnect recovery may poll lightweight status for multiple active sessions,
  but it materializes `session.get + session.messages` only for the currently
  viewed session. Background busy/incomplete sessions wait until selection and
  continue receiving live events without fetching their bodies.
- Network session-detail and message-page reads for the current selection use
  high fetch priority; background materialization of other sessions does not.
  Broad
  cold-start discovery reads (status, config, Git, quota, and bounded session
  lists) use low priority, so opening a chat is not stuck behind an already
  queued bootstrap burst. This is only a direct-network scheduling hint; relay
  request ordering and request payloads are unchanged.

## Runtime endpoint lifecycle

- A runtime transport identity change means the normalized direct endpoint URL
  or relay descriptor changed. A direct-runtime key alias on the same endpoint
  is storage metadata, not a transport change, and must not reset app state or
  remount `SyncProvider`.
- Updating a bearer token or request headers for the same endpoint is a
  credential refresh, not a runtime switch. It must update transport auth in
  place without re-running global bootstrap, authentication checks, or opening
  another global event stream.
- Startup host restoration can publish several intermediate endpoint identities
  in one short burst. App reset and authentication consumers coalesce that burst
  and apply only its final identity; never remount `SyncProvider` once per
  intermediate host/token state.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. `setCurrentSession()` announces a monotonic session-switch intent before directory resolution or store publication. Delayed visual/transition callbacks must validate that intent and silently discard stale work.
5. Sidebar previous/next navigation is scope-aware. `SessionSidebar` publishes the Recent order plus logically visible project rows to `session-navigation.ts`; keyboard and native-menu actions share that registry and update the explicit session Focus before committing current-session authority. Project-origin navigation is restricted to the current expanded project and never falls through to hidden rows or another project.
6. Global Mod+1…9 navigation is session-row based, not project based. `SessionSidebar` combines the currently revealed Recent rows with logically visible project rows, caps the visual order at nine, and publishes it through `sidebar-numbered-navigation.ts`. The numbered activation preserves the selected row's exact Recent/Project Focus identity.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> `archiveSessions([id], archivedAt)`
- `deleteSession()` -> `removeSessions([id])`

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
3. **Group by subscriber set** — if only 2 components read a value, it should be in a store that only those 2 components subscribe to
4. **Prefer a new store over growing an existing one** if the new state has different subscribers or change frequency
5. **Cross-store reads use `.getState()`** — actions in one store that need to read another store call `useOtherStore.getState()` (imperative, no subscription)

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
