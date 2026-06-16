# Chat Session Performance Plan

## Goal

Reduce render cost and history-load latency when switching between chat sessions
in `packages/ui/src/components/chat/`, especially on Windows desktop with
projects that have a long-running chat history (50–500 messages per session,
tool-heavy workloads where each tool call returns 10–200 KB of output).

The plan is **strictly behavior-preserving**: every change keeps the visible
behavior 1:1 with the current build. Differences are only in the cost of doing
the work, not in the UX, layout, limits, persistence, or order of operations.

The two scenarios this targets:

- Switching between sessions in the sidebar (especially in/out of a session
  with a long history) — the main window currently blocks the main thread
  for 200–500 ms on first paint while `JSON.parse` + `materializeSessionSnapshots`
  + `projectTurnRecords` run synchronously over the full initial page.
- Returning to a session you visited a few minutes ago — the in-memory LRU
  (`SESSION_MESSAGE_RECORDS_CACHE_MAX = 40` desktop) helps, but the second
  visit to a session outside that window still pays the full network + parse
  cost.

A secondary goal is to avoid hammering the OpenCode server with large
single-shot fetches; we want smaller, more frequent, deduped requests.

## Upstream context

Before implementing, I scanned open/closed PRs for overlap and lessons:

- **#1651 — "perf: migrate chat rendering to virtua"** (`b920fd6f`, MERGED).
  Already moved chat history to `virtua` virtualization with `bufferSize: 900`
  and `MESSAGE_LIST_VIRTUALIZE_THRESHOLD = 5`, plus deferred Prism highlight,
  mermaid/file annotation, table listeners, stable plugin lists. This plan
  builds on top of that.
- **#1650 — "perf: instant startup via cache hydration + decoupled readiness"**
  (`c62f0d1c`, MERGED). Instant startup + decoupled readiness — orthogonal.
- **#1503 — "fix(chat): do not force scroll in thinking block during streaming"**
  (OPEN). Scroll behaviour during streaming — not in our hot path.
- **#1584 — "feat: improve long user message collapse, scrolling, and navigation"**
  (DRAFT). Touches long user messages; no direct conflict with this plan.
- **#1621 — "feat: comprehensive scrolling and navigation improvements"**
  (DRAFT). Broad scroll/navigation PR; no direct conflict.
- **#1282 — "Optimize large-session sidebar trees, switching UX, and chat
  scroll restore stability"** (CLOSED by maintainer). Introduced session-
  switching instability, selection/chat desync, optimistic transitions.
  Lesson: keep this plan focused on render-cost reduction and stable memoization;
  do NOT add optimistic transitions, backend search endpoints, scroll-
  restoration loops, or pagination on top of an unstable base.
- **#1448 — "feat: implement unified multi-server sidebar"** (DRAFT). Rewrites
  large parts of `SessionSidebar`. Independent of this plan.

There is currently NO open PR targeting the same render-cost or history-load
problems for the chat panel. We can proceed without coordination.

## Current Architecture Notes

### Data flow on session switch

1. `ChatContainer` subscribes to `currentSessionId` from `useSessionUIStore`.
2. `useSessionMessageRecords(currentSessionId, directory)` reads from the
   directory-scoped sync store via `React.useSyncExternalStore`. Snapshot
   cache: `SESSION_MESSAGE_RECORDS_CACHE_MAX = 40` desktop, `4` vscode/mobile.
3. `useChatTimelineController.turnWindowModel` is rebuilt via
   `buildTurnWindowModel(messages)` on first open of a session; cached per
   sessionId in module-level `turnModelCache` (max 30 desktop, 4 constrained).
4. `MessageList.baseDisplayMessages` reverses + dedupes + normalizes each
   message via `getNormalizedMessageForDisplay` (per-message `WeakMap` cache).
5. `useTurnRecords` projects turn records via `projectTurnRecords` (O(N) over
   messages + per-turn work for summary/activity/diffStats/changedFiles).
   `previousProjectionRef` stabilizes across re-renders, but there is no
   module-level projection cache — returning to a session after the component
   unmounts pays the full projection cost again.
6. `useChatTimelineController` runs the `useLayoutEffect` on `[sessionId]`
   that resets `isLoadingOlder`, `pendingRevealWork`, `activeTurnId`.

### Render hot path (current cost map)

- `ChatContainer` (990 lines) subscribes to the full directory `permission`
  and `question` records via `useDirectorySync((s) => s.permission ?? {})` and
  `useDirectorySync((s) => s.question ?? {})` (`ChatContainer.tsx:436-443`).
  Any `permission.asked` or `question.asked` event for any session in the
  same directory re-renders `ChatContainer` and re-runs the `permissionsMap` /
  `questionsMap` / `scopedSessionIds` / `sessionPermissions` / `sessionQuestions`
  / `sessionIsWorking` chain. Same for `useSessions(directory)` — every
  `session.updated` event for any session in the directory re-renders the
  container.
- `MessageList.reviewTransferDirection` (`MessageList.tsx:1151`) does
  `useGlobalSessionsStore((state) => { const currentSession = state.activeSessions.find(...) })`
  — runs `find` + `some` over the entire global active list on every global
  store change.
- `MessageList` already has a `useStableEvent(getAnimationHandlers)`,
  `useStableEvent(scrollToBottom)`, and a module-level `timelineCache` for
  the virtua cache snapshot — those are the right pattern, just not applied
  uniformly.
- `ChatMessage` (1182 lines) is `React.memo`-wrapped with
  `areRenderRelevantMessagesEqual` plus `areRelevantTurnGroupingContextsEqual`.
  `MessageBody` (2121 lines) is NOT `React.memo`-wrapped but is only
  rendered through `MessageRow` → `ChatMessage` and only re-runs when
  `areRenderRelevantMessagesEqual` returns false.

### The 1.5 MB problem

The OpenCode server (separate repo, `anomalyco/opencode`) responds to
`GET /api/session/{sessionID}/message` with
`Array<{ info: Message, parts: Part[] }>` (the v1 wire shape preserved in
the v2 SDK). On a typical tool-heavy session of 150 messages, this array
serializes to ~1.5 MB of JSON. The bulk is `ToolStateCompleted.output: string`
(confirmed in `node_modules/.bun/@opencode-ai+sdk@1.17.7/.../types.gen.d.ts:357-373`).

The OpenChamber web server (`packages/web/server/index.js:1115`) installs
Express `compression()` middleware BEFORE the OpenCode proxy
(`packages/web/server/lib/opencode/proxy.js`), so the response IS compressed
on the way out (5x reduction on typical JSON, so ~300 KB on the wire). The
proxy explicitly sets `accept-encoding: identity` (`proxy.js:629`) which is
a no-op against the upstream OpenCode server (it has no compression
middleware — `server.ts` uses raw `@effect/platform-node` NodeHttpServer).

So the **wire cost is ~300 KB after gzip**, not 1.5 MB. The real cost is the
**client-side main-thread blocking**:

- `JSON.parse` on 1.5 MB of structured data: ~50–200 ms in V8.
- `materializeSessionSnapshots`: O(N) sort/filter, ~10–20 ms for 150.
- `projectTurnRecords`: O(N) with per-turn work (summary/activity/diffStats/
  changedFiles/indexes), ~30–100 ms for 150.
- `useChatTimelineController.useLayoutEffect` re-resolves pending scroll
  requests and updates `historySignals` — fast but runs synchronously.

Total main-thread block on first paint: **200–500 ms**. The user-perceived
"long load" is mostly this.

### Limit constants (current)

| Constant                              | Value                             | Location              | Purpose                                 |
| ------------------------------------- | --------------------------------- | --------------------- | --------------------------------------- |
| `INITIAL_MESSAGE_PAGE_SIZE`             | 150 (desktop), 30 (vscode/mobile) | `use-sync.ts:25-27`     | First page on session switch            |
| `HISTORY_MESSAGE_PAGE_SIZE`             | 200                               | `use-sync.ts:28`        | Scroll-up pagination                    |
| `MESSAGE_REFETCH_LIMIT`                 | 200                               | `session-actions.ts:27` | Refetch after revert/abort              |
| `RECONNECT_MESSAGE_LIMIT`               | 30                                | `sync-context.tsx:193`  | Reconnect bootstrap                     |
| `SESSION_MATERIALIZATION_MESSAGE_LIMIT` | 30                                | `sync-context.tsx:194`  | Materialize on `message.updated` recovery |
| `DEFAULT_MESSAGE_LIMIT`                 | 200                               | `sessionTypes.ts:78`    | Declarative ceiling; not enforced       |

For 99% of sessions, users read the latest 30–50 messages and rarely scroll
beyond. The 150-initial / 200-history combination fetches ~3x more than the
visible window on first paint.

### Already optimized (do not touch)

- `MessageList` virtualization with `virtua` at threshold 5, bufferSize 900
  (PR #1651).
- `MessageRow` / `ChatMessage` / `TurnBlock` `React.memo` with custom
  comparators.
- `getNormalizedMessageForDisplay` per-message `WeakMap` cache.
- `MarkdownRenderer` lazy-loaded via `lazyWithChunkRecovery`; Prism highlight
  and mermaid deferred (PR #1651).
- `expandedToolsStateCache` and `collapsedToolsStateCache` module-level LRU
  bounded at 4000 (`ChatMessage.tsx:39-95`).
- `aggregateLiveSessions` / `aggregateLiveSessionStatuses` bail via
  `areSessionListsEquivalent` and `areStatusMapsEquivalent`; consumed through
  `useLiveSyncSelector`.
- `useStickyProjectHeaders` IntersectionObserver.
- Targeted field cloning in `handleDirectoryEvent` (sync/DOCUMENTATION.md).
- `turnModelCache` for `buildTurnWindowModel` (30 desktop, 4 vscode/mobile).
- `timelineCache` for virtua snapshot (max 16 sessions).
- `session-prefetch-cache` 15s TTL dedup of `syncSession` requests.
- `syncSessionInflightByKey` for in-flight dedup.

## Proposed Architecture

### Bugfix Layer 0 — Fix rapid project-switch race in sidebar

**Observed bug:** When connected from desktop to an OpenChamber server, with
multiple trees in the sidebar and large sessions (~200k context), rapidly
switching between recent sessions in different projects causes the focus to
follow the **fetch completion order** instead of the user's final click. The
sequence is: user clicks 1, then 2, then 3; UI briefly shows 3; when fetch 1
finishes it jumps to 1; when fetch 2 finishes it jumps to 2; when fetch 3
finishes it finally lands on 3.

**Root cause:** `useProjectSessionSelection` (`useProjectSessionSelection.ts`)
has auto-selection logic that runs when `activeProjectId` changes. Combined
with uncancelled async fetches and cross-project store updates, stale fetch
completions update the sidebar session lists, which re-triggers selection
fallbacks and overwrites the user's explicit choice.

**Fix — four parts:**

1. **Layer 0a — Generation guard in `useEnsureSessionMessages`.**
   Track a per-hook generation counter. When the effect fires for a new
   `sessionID`, increment the generation. Ignore the result (do not apply
   store mutations) if the generation is stale by the time the async fetch
   completes.

2. **Layer 0b — Generation guard in `syncSession` / `loadMessages`.**
   Add a module-level `Map<sessionKey, number>` tracking the latest requested
   generation per session. Before every store write inside `syncSession` and
   `loadMessages`, check that the request is still current. This prevents
   fetches 1 and 2 from mutating state after the user has already selected 3.

3. **Layer 0c — Debounce `handleSessionSelect`.**
   In `useSessionActions.ts`, wrap the actual navigation in a short timeout
   (~80ms). The first click executes immediately; rapid subsequent clicks
   cancel the pending navigation and reschedule for the latest target. This
   coalesces 1→2→3 into a single `setCurrentSession(3)` call.

4. **Layer 0d — Explicit-selection guard in `useProjectSessionSelection`.**
   Track the timestamp of the last explicit user selection. Suppress the
   auto-select fallback in the layout effect for ~500ms after an explicit
   click, so fallback logic never overwrites an active user choice.

**Effect:** Rapid project switching becomes deterministic: the UI stays on the
last clicked session and only loads its content. Stale fetches are silently
ignored instead of fighting for focus.

**Files:** `sync-context.tsx`, `use-sync.ts`, `useSessionActions.ts`,
`useProjectSessionSelection.ts`.

---

### Layer 1 — Narrow subscriptions in ChatContainer

**Problem:** `ChatContainer.tsx:436-443` subscribes to the **full directory**
`permission` and `question` records. Any permission/question event for **any**
session in the directory causes a ChatContainer re-render, even if the event
is for an unrelated session. Same for `useSessions(directory)` at line 427
— every `session.updated` event re-renders the container.

There are already session-scoped hooks (`useSessionPermissions(sessionID)`,
`useSessionQuestions(sessionID)` at `sync-context.tsx:2151,2165`), but they
don't aggregate across descendant subagent sessions — which
`collectVisibleSessionIdsForBlockingRequests` (`ChatContainer.tsx:458-464`)
handles for the `sessionPermissions` / `sessionQuestions` / `sessionIsWorking`
chain.

**Fix:** Replace the broad directory reads with scoped subtree selectors. The
subtree is the current session and all its descendant subagent sessions.

Add to `sync-context.tsx`:

- `useScopedSubtreeIds(sessionID: string | null, directory?: string): Set<string>`
  — returns the set of session IDs in the current subtree (current session +
  all descendants by `parentID`). Reference-stabilized: a new Set is only
  returned when the actual membership changes, using the same "compare
  contents, reuse reference" pattern as `areSessionListsEquivalent`.

- `useScopedBlockingRequests(sessionID: string | null, directory: string, kind: 'permission' | 'question')`
  — combines `useScopedSubtreeIds` with the existing `useSessionPermissions` /
  `useSessionQuestions` patterns to return a flat array of blocking requests
  scoped to the subtree only.

- `useParentSession(sessionID: string | null): Session | null` — returns
  the parent Session via a pre-computed `Map<sessionId, Session>` that only
  changes when the target session or its parent changes. Replaces the O(N)
  `.find()` at `ChatContainer.tsx:564`.

`ChatContainer` then:
- reads `useScopedBlockingRequests` instead of the full `allPermissions`/
  `allQuestions` → `permissionsMap` → `scopedSessionIds` → `sessionPermissions`
  / `sessionQuestions` chain.
- reads `useParentSession` instead of `sessions.find(...)`.
- stops subscribing to `useSessions(directory)` entirely (the subtree selectors
  provide all needed session data scoped to the active subtree).

**Effect:** Third-party sessions in the same directory stop re-rendering
ChatContainer. Streaming events for unrelated sessions no longer invalidate
the chat's blocking-requests chain.

**Files:** `ChatContainer.tsx`, `sync-context.tsx`.

---

### Layer 3 — Module-level projection cache

**Problem:** `useTurnRecords` keeps `previousProjectionRef` for in-component
stabilization, but a session that unmounts and remounts loses that ref. Full
re-projection cost is paid every time you return to a session.

**Fix:** Add a module-level LRU keyed by `sessionKey`. The cache key must
capture the exact identity of the message list to avoid stale projections:

```ts
// Includes: sessionKey, message count, last message id,
// AND the count of parts on the last message (detects streaming deltas
// that add parts to an existing message without changing id or count).
type CacheKey = `${sessionKey}|${length}|${lastMessageId ?? ''}|${lastMessagePartCount ?? 0}`
const projectionCache = new Map<CacheKey, { projection: TurnProjectionResult }>()
```

Including `lastMessagePartCount` is critical: during streaming, new parts are
appended to the same last message — the message ID and total message count
stay the same, but the projection must be recomputed.

Cap at the same limits as `turnModelCache` (30 desktop, 4 vscode/mobile)
to bound memory.

`useTurnRecords` consults the cache before running `projectTurnRecords`; on
hit, returns the cached projection and refreshes LRU order; on miss, runs the
full projection and writes the result.

**Effect:** Returning to a session within the LRU window is zero projection
work. Combined with `MessageList.timelineCache` (which already caches the
virtua snapshot), the first paint after a remount is essentially "rebuild
only what's strictly session-specific (resolvers, refs)".

**Files:** `useTurnRecords.ts` (small extension) + new helper
`lib/turns/turnProjectionCache.ts`.

---

### Layer 4a — Start message fetch synchronously in setCurrentSession

**Problem:** `session-ui-store.setCurrentSession` currently only calls
`setState` (Zustand). The actual message fetch is started by
`ChatContainer.useEffect` at `ChatContainer.tsx:787-792`, which runs on the
render AFTER the state update — adding one React commit cycle (~30–80 ms)
of latency before the network request starts.

**Fix:** Start the fetch directly from `setCurrentSession` on the same tick
as the state update, using the existing imperative access layer.

The approach uses `session-actions.ts`, which already has module-level refs
(`_sdk`, `_childStores`, `_getDirectory` — `session-actions.ts:33-35`) set by
SyncProvider at mount time. Add a `fetchMessagesForSession(sessionID: string)`
function there that duplicates the core path from `useSync().syncSession`:
checks the child store for existing messages, fetches from SDK if needed,
calls `materializeSessionSnapshots`, and writes to the directory store.

`setCurrentSession` then calls `fetchMessagesForSession(targetId)` immediately
after `set({ currentSessionId: id, ... })`. The `syncSessionInflightByKey`
in `use-sync.ts` doesn't cover this new path, so the function also uses the
existing `_ensureMessagesLoading` Set in `sync-context.tsx` (line 2668) for
dedup.

The existing `ChatContainer.useEffect` at line 787 stays as a safety net for
sessions restored from URL or other non-sidebar entry points.

**Effect:** Fetch starts on the same tick as the state update, ~30–80 ms
earlier than the current "wait for React commit → useEffect → fetch" path.

**Files:** `session-ui-store.ts` (one new call in `setCurrentSession`),
`session-actions.ts` (new `fetchMessagesForSession` function).

---

### Layer 5 — Small wins

- **`reviewTransferDirection` pre-computed map.** In
  `MessageList.tsx:1151-1164`, replace
  `useGlobalSessionsStore((state) => state.activeSessions.find(...))` with
  a selector that reads a pre-computed `Map<sessionId, ReviewTransferDirection>`
  maintained by `useGlobalSessionsStore` (built once per active-sessions
  change, in the same reducer that updates `activeSessions`). Same selector
  shape from the component's perspective, but no `.find()` + `.some()` on
  every global store change.

- **`parentSession` lookup.** Part of Layer 1 (see `useParentSession` hook
  above). The pre-computed `Map<sessionId, Session>` is maintained in
  `sync-context.tsx` and read via the hook, eliminating the O(N) `.find()`
  in `ChatContainer`.

**Files:** `MessageList.tsx`, `useGlobalSessionsStore.ts`.

---

### Layer 6a — Reduce initial payload

Lower the page sizes to match typical user reading patterns:

- `INITIAL_MESSAGE_PAGE_SIZE`: 150 → 50 (desktop), 30 stays (vscode/mobile).
- `HISTORY_MESSAGE_PAGE_SIZE`: 200 → 100.
- `MESSAGE_REFETCH_LIMIT`: 200 → 100.
- `DEFAULT_MESSAGE_LIMIT` in `sessionTypes.ts`: stays 200 (it's a ceiling,
  not a fetch target).

**How the "load more" indicator still works with a smaller initial page:**
`historyMeta` in ChatContainer is built from `sync.hasMore(currentSessionId)`,
which reads `meta.current` (set immediately after the first `loadMessages`
call, before the component renders). If the server returns a cursor,
`sync.hasMore()` returns `true` → `historyMeta.complete = false` →
`hasMoreAboveTurns = true` → scroll-up indicator appears correctly.
The `messages.length >= defaultLimit` fallback is never reached in practice
because `historyMeta` is populated before the first render of the chat.

Effect on the 1.5 MB problem:

- Initial fetch payload: 1.5 MB → ~500 KB parsed (50 messages).
- JSON.parse cost: 100–200 ms → 30–70 ms.
- projection cost: 30–100 ms → 10–30 ms.
- Combined main-thread block: 200–500 ms → 50–150 ms.

User cost: one extra round trip when scrolling past the 50th message. The
scroll-triggered `loadMore` is already in place and is the right UX for "I
want to see older messages" — the previous behavior of "fetch 150 and ignore
100" was wasted work for the common case.

**Files:** `use-sync.ts`, `session-actions.ts`.

---

### Layer 6b — Progressive mount

`use-sync.syncSession` starts the initial 50-message page synchronously.
After the first page resolves, if the cursor indicates more messages, a
second fetch of `HISTORY_MESSAGE_PAGE_SIZE` (100 messages) is dispatched
via `loadMessages(sessionID, { before: cursor, mode: "prepend" })` — the
prepend mode already exists in `loadMessages` (`use-sync.ts:373`). This
second page is non-blocking; the user sees the first 50 messages immediately.

On the client side, `useTurnRecords` and `useChatTimelineController` must
re-run projection when the prepended messages arrive. Two options:

- **Simple:** Let the full re-projection run on the second page arrival
  (50→150 messages). With Layer 6a, projection of 150 messages is ~10–30 ms —
  fast enough that a one-time re-project on the second page is acceptable.

- **Optimal:** Extend `updateTurnWindowModelIncremental` (currently handles
  only +1 message appends — `windowTurns.ts:76-84` checks
  `nextMessages.length !== previousMessages.length + 1`) to handle batch
  prepends. This requires:
  1. A new `updateTurnWindowModelBatchPrepend` that verifies the new messages
     are all prepended (all existing message references match at the tail)
     and projects only the new messages into turn windows.
  2. A corresponding `updateTurnProjectionIncremental` in `projectTurnRecords.ts`
     that merges the new turns into the existing projection.

  Because `updateTurnWindowModelIncremental` is designed for single-message
  streaming deltas (not batch prepends), this is non-trivial additional work.
  Given Layer 6a alone reduces the main-thread block to ~50–150 ms, start
  with the simple approach and measure before committing to the incremental
  path.

**Net effect:** The first 50 messages mount within the same time as today
(possibly faster, because parsing 500 KB < parsing 1.5 MB). The next 100
arrive ~200–400 ms later. From the user's perspective, the chat becomes
interactive immediately.

**Files:** `use-sync.ts`, `ChatContainer.tsx` (small — no change to `loadMore` UX).

---

## What I do not propose to touch (and why)

- `useChatAutoFollow` and the scroll-restoration logic in
  `useChatTimelineController` (the `prePrependScrollRef` / height-delta
  compensation). PR #1282 closed because of scroll-restore regressions;
  these are working and tested.
- The event-pipeline coalescing and `message.part.delta` reducer path.
  Already correct (sync/DOCUMENTATION.md).
- The Markdown renderer and Prism highlight deferral. PR #1651 already took
  the low-hanging fruit.
- The `key={currentSessionId}` on `<ChatViewport>`. Forces a full remount,
  which is expensive, but a previous PR attempt (Layer 2 in the sidebar
  plan) regressed scroll/follow. Keeping the remount for now.
- The OpenCode server response shape. It's in `anomalyco/opencode`, which
  AGENTS.md forbids us from touching.
- The SDK's internal `JSON.parse` step. Replacing it with a streaming
  parser requires owning the fetch call (the SDK doesn't expose the
  `ReadableStream`), and the response is a single JSON array, not NDJSON —
  so streaming buys us the same "first N visible, rest in background"
  pattern that Layer 6b already implements.
- Tool output lazy-load. Would need a server-side endpoint like
  `GET /api/session/{sid}/part/{partID}` that the OpenCode server does
  not currently provide.

## Expected effect

- **Initial session switch on a 150-message tool-heavy session:**
  main-thread block 200–500 ms → 50–150 ms. ~3x faster.
- **Wire payload on the same session:** 1.5 MB parsed → 500 KB parsed.
  After gzip, ~300 KB → ~100 KB.
- **Returning to a session within the LRU window:** zero projection work
  (Layer 3), zero scroll-cache rebuild (existing `timelineCache`).
- **Returning to a session outside the LRU window:** same as initial, but
  the 15s `session-prefetch-cache` TTL catches sessions visited twice in
  rapid succession.
- **Server load:** the OpenCode server processes 1/3 the volume per
  session-switch, and the warm second page in Layer 6b is deduped
  against the inflight request. Strictly less load than today.

## Files Touched by the Plan

- `CHAT_PERF_PLAN.md` (new, this file)
- `packages/ui/src/sync/sync-context.tsx` (Bugfix Layer 0a — `useEnsureSessionMessages` guard)
- `packages/ui/src/sync/use-sync.ts` (Bugfix Layer 0b — `syncSession`/`loadMessages` guard; Layer 6a — constants)
- `packages/ui/src/components/session/sidebar/hooks/useSessionActions.ts` (Bugfix Layer 0c — debounce)
- `packages/ui/src/components/session/sidebar/hooks/useProjectSessionSelection.ts` (Bugfix Layer 0d — explicit-selection guard)
- `packages/ui/src/components/chat/ChatContainer.tsx` (Layers 1, 6b)
- `packages/ui/src/components/chat/MessageList.tsx` (Layer 5a)
- `packages/ui/src/stores/useGlobalSessionsStore.ts` (Layer 5a — pre-computed map)
- `packages/ui/src/sync/sync-context.tsx` (Layer 1 — new hooks: `useScopedSubtreeIds`, `useScopedBlockingRequests`, `useParentSession`)
- `packages/ui/src/sync/session-ui-store.ts` (Layer 4a — call fetch from `setCurrentSession`)
- `packages/ui/src/sync/session-actions.ts` (Layer 4a — new `fetchMessagesForSession`, Layer 6a — constants)
- `packages/ui/src/sync/use-sync.ts` (Layer 6a — constants, Layer 6b — progressive fetch)
- `packages/ui/src/stores/types/sessionTypes.ts` (Layer 6a — sync `DEFAULT_MESSAGE_LIMIT` with new constants)
- `packages/ui/src/components/chat/hooks/useTurnRecords.ts` (Layer 3 — projection cache)
- `packages/ui/src/components/chat/lib/turns/turnProjectionCache.ts` (new, Layer 3)

## Implementation order

1. **Bugfix Layer 0** (race condition fixes) — highest priority, fixes the
   observed sidebar switching bug before any optimization work.
2. **Layer 6a** (reduce constants) — simplest performance win, also reduces
   the race window.
3. **Layer 3** (projection cache) — isolated change, immediate return-visit win.
4. **Layer 5a** (reviewTransfer map) — isolated, low risk.
5. **Layer 1** (narrow subscriptions) — more complex but well-bounded.
6. **Layer 4a** (early fetch) — depends on Layer 1 for dedup safety.
7. **Layer 6b** (progressive mount) — highest complexity, implement after
   measuring real-world gains from 6a.

## Conflict risks

- None of the open PRs touch the files above in a conflicting way. PR #1584
  (draft, long user message collapse) modifies `UserTextPart.tsx`, not the
  files we touch. PR #1621 (draft, comprehensive scrolling) modifies scroll
  and navigation components, not the chat data flow. PR #1448 (draft,
  unified multi-server sidebar) is for `SessionSidebar.tsx` and family, not
  the chat panel.
- Existing internal benchmarks for `event-pipeline` are unaffected
  (Layers 1, 3, 4a, 5, 6 do not touch event coalescing or ordering).
- `bun run type-check` and `bun run lint` must remain green.

## Open Questions

1. **Layer 2 (drop `key={currentSessionId}` from `ChatViewport`):** explicitly
   out of scope per user. Revisit after the lower-risk layers ship.
2. **Layer 7 (Web Worker for `JSON.parse` + materialize):** out of scope.
   The Layer 6a/6b combo should bring main-thread block to ~50–150 ms,
   which is acceptable. Revisit if real-user feedback still shows jank.
3. **Layer 6b incremental projection for batch prepends:** start with the
   simple full-reproject-on-second-page approach (50→150 projection is
   ~10–30 ms post-Layer-6a). Only build the incremental path if benchmarks
   show the full reproject is still noticeable.
4. **Layer 3 cache invalidation during streaming:** the `lastMessagePartCount`
   in the cache key catches part deltas on the last message. If the streaming
   model appends parts to a message that is NOT the last (e.g., tool output
   on a completed turn while a new turn is streaming), the cache would miss —
   which is correct (projection must re-run). Confirm this edge case during
   smoke testing.
