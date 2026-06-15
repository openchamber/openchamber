# Session Sidebar Performance Plan

## Goal

Speed up opening the Session Sidebar tree (`packages/ui/src/components/session/SessionSidebar.tsx`) and switching between sessions on the Windows desktop client when a project has many sessions, many worktrees, a large archived bucket, or a deeply nested subagent tree.

The plan is **strictly behavior-preserving**: every change keeps the visible behavior 1:1 with the current build. Differences are only in the cost of doing the work, not in the UX, the layout, the limits, the persistence, or the order of operations.

The two scenarios that prompted this plan:

- Expanding a large project or the archived bucket, where the sidebar mounts hundreds of `SessionNodeItem` rows.
- Switching the active session in a large project, where the right pane churns live state and the sidebar re-renders its entire tree.

A secondary goal is to reduce the initial worktree-discovery fanout on cold start so the sidebar paints faster and the chat panel on the right does not have to compete with up to 10 concurrent `git worktree list` / `checkIsGitRepository` calls.

## Upstream context

Before implementing, check these open/closed upstream PRs for overlap and lessons:

- **#1282 — "Optimize large-session sidebar trees, switching UX, and chat scroll restore stability"** (`vhqtvn`, **CLOSED**). This PR attempted a broader optimization (archived/subagent pagination, backend session search, optimistic session-switch spinner, scroll-restore rAF loop). It was **closed by maintainer** because it introduced session-switching instability, selection/chat desync, and UX regressions. Key lesson: keep this plan focused on render-cost reduction and stable memoization; do **not** add optimistic transitions, backend search endpoints, scroll-restoration changes, or pagination unless explicitly asked.
- **#1504 — "fix: include sessions in project subdirectories in sidebar"** (`youfch`, **OPEN**). Touches the same file as Layer 4 item 13 (`useProjectSessionLists.ts`). It adds prefix matching for sessions whose `directory` is a subdirectory of the project root. Coordinate before editing `useProjectSessionLists.ts`, or merge its intent into our changes.
- **#1480 — "Detect external worktrees instantly"** (`colinmollenhour`, **OPEN**). Adds a server-side `fs.watch` for worktree metadata and pushes `worktree.changed` events through the global event stream. Independent of this plan, but any worktree-state changes should not conflict with its client store updates.
- **#1448 — "feat: implement unified multi-server sidebar (#1412)"** (`panzeyu2013`, **DRAFT**, +7526/-3294). A large rewrite of `SessionSidebar.tsx`, `SidebarProjectsList.tsx`, `SessionNodeItem.tsx`, and `useSessionActions.ts` that adds server-aware sections. **High conflict risk.** If this draft is likely to land soon, consider scoping this performance work to files it does not touch, or wait until it merges and rebase.

## Current Architecture Notes

### Data flow

- `SessionSidebar` is the orchestrator. It subscribes to `useAllLiveSessions` and `useAllSessionStatuses` from the sync layer, merges them with `useGlobalSessionsStore.activeSessions`/`archivedSessions`, then runs the resulting list through a stack of `useMemo` chains: `sortedSessions` -> `sessionOrderIndex` -> `useProjectSessionLists` -> `useSessionGrouping.buildGroupedSessions` -> `useSessionSidebarSections.projectSections` -> downstream views.
- `useProjectSessionLists.sessionsByDirectory` (`packages/ui/src/components/session/sidebar/hooks/useProjectSessionLists.ts:23-36`) groups **all** loaded sessions by directory, including sessions for directories that are not in `availableWorktreesByProject` and not in `normalizedProjects`. Downstream `getSessionsForProject` then filters with `seen`/`collected` patterns. This is wasted work when many projects and many worktrees are loaded.
- `useSessionGrouping.buildGroupedSessions` (`packages/ui/src/components/session/sidebar/hooks/useSessionGrouping.ts:61-243`) is invoked once per project per `useSessionSidebarSections` recompute. For each project it: dedupes + sorts the input list, builds `sessionMap` and `childrenMap`, recursively calls `buildProjectNode` to assemble the parent/child tree, sorts worktrees, and materializes three group types (root / worktree / archived). The output array is a new reference every time the useMemo's deps change.
- `useSessionSidebarSections` (`packages/ui/src/components/session/sidebar/hooks/useSessionSidebarSections.ts:63-91`) iterates `normalizedProjects.map((project) => buildGroupedSessions(...))` for every project. Its `useMemo` deps include `getSessionsForProject` and `getArchivedSessionsForProject`, both of which are `useCallback` whose identities depend on `sessionsByDirectory` and `availableWorktreesByProject`. When any of those flip, the whole stack re-runs.
- `prVisualStateByDirectoryBranch` (`packages/ui/src/components/session/SessionSidebar.tsx:1360-1379`) is rebuilt on every `prVisualSummaryMap` change and passed as a `Map` to every `SessionGroupSection`. `Map` identity flips frequently during bootstrap, but the content of the map for any one group is usually stable.
- `useDirectoryStatusProbe` was a transitional artifact from commit `ce39dad5`. That commit replaced runtime directory probing (which used the expensive `opencodeClient.listLocalDirectory`) with `buildKnownSessionDirectories` + `isKnownActiveSessionDirectory` to filter stale sessions at list-build time. The file, the `directoryStatus` state, the prop, and the `isMissingDirectory` checks were removed in **Layer 0 / PR #1660**.
- Initial worktree discovery (`SessionSidebar.tsx:403-445`) for each project calls `listProjectWorktrees`, and for projects without a cached `isGitRepo` in `useGitStore` it dynamically imports `@/lib/gitApi` and runs `checkIsGitRepository`. On a project with many worktrees this can take seconds on cold start. `listProjectWorktrees` itself already has a 30s client cache and in-flight deduplication, so the main cost is the per-project `isGitRepo` resolution and the unbounded `Promise.all` fanout.

### Render hot path

- `SessionGroupSection` (`packages/ui/src/components/session/sidebar/SessionGroupSection.tsx`) is **not** wrapped in `React.memo`. Every change to `prVisualStateByDirectoryBranch` (new `Map` identity) re-renders every group in the sidebar.
- Inside `SessionGroupSection` the following work runs on every render:
  - `compareSessionNodes` useCallback is rebuilt when `pinnedSessionIds` or `sessionOrderIndex` flip, which happens whenever `sortedSessions` changes (`SessionGroupSection.tsx:146-155`). That invalidates `sourceGroupNodes` (`SessionGroupSection.tsx:166-170`), which in turn invalidates `nodeBySessionId`, `allFoldersForGroupBase`, `allFoldersForGroup`, `sessionIdsInFolders`, `ungroupedSessions`, `rootFolders`, and the virtualizer arguments.
  - `collectGroupSessions` (`SessionGroupSection.tsx:373-383`) recursively flattens the tree every render, even though it is only used to feed the "delete all in group" handler.
  - `collectFolderSessions` (`SessionGroupSection.tsx:467-474`) is recursive and is called per folder inside `renderOneFolderItem` whenever `group.isArchivedBucket` is true. With 50 folders and 200 sessions this is O(50 x (200 + 50)) per render.
  - `allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id)` inside `renderOneFolderItem` (`SessionGroupSection.tsx:463`) is an O(F) scan for every folder. O(F^2) per render of the archived bucket.
  - A `useLayoutEffect` with no deps (`SessionGroupSection.tsx:307-344`) walks the parent chain with `window.getComputedStyle` looking for the nearest scrolling ancestor. `getComputedStyle` forces a style recalc; on every render of an expanded archived bucket this is one of the more expensive operations in the hot path.
- `SessionNodeItem.areEqual` (`packages/ui/src/components/session/sidebar/SessionNodeItem.tsx:144-215`) is the React.memo comparator for every sidebar row. For each row it calls `treeContainsSessionId(prev.node, prev.currentSessionId)`, `treeContainsSessionId(next.node, next.currentSessionId)`, `treeContainsMenuKey(prev.node, prev.openSidebarMenuKey, ...)`, `treeContainsMenuKey(next.node, next.openSidebarMenuKey, ...)`, plus the same pair for `editingId` and `editTitle`. `treeContainsSessionId` and `treeContainsMenuKey` (`SessionNodeItem.tsx:102-142`) recurse through `node.children`. `getNodeChildSignature` (`SessionNodeItem.tsx:92-100`) concatenates all child IDs into a string. Across 200 rows this is roughly 6 x 200 x average-subtree-depth operations per Sidebar re-render, i.e. O(M^2) in the number of rows.
- `SessionNodeItem` calls `useSession(session.id)` (`SessionNodeItem.tsx:300`) for every visible row. `useSession` goes through `useLiveSyncSelector` with `findLiveSession` (`packages/ui/src/sync/live-aggregate.ts:182-199`), which iterates all child-stores. With 5 child-stores and 200 visible rows that's 1000 ops per SSE event. During background streaming that fires at 60 Hz, this is ~60 000 ops/sec just for the per-row live overlay.
- `renderSessionNode` (`SessionSidebar.tsx:1259-1348`) is a `useCallback` with ~30 deps (`editingId`, `notifyOnSubtasks`, `renamingFolderId`, `editTitle`, etc.). Many of those flip for reasons unrelated to the row being rendered. When the callback identity flips, React re-evaluates `SessionNodeItem.areEqual` (whose answer does not change in many of these cases, but the work has already been done).
- `SidebarProjectsList` (`packages/ui/src/components/session/sidebar/SidebarProjectsList.tsx:149-247`) for each project calls `props.getOrderedGroups(projectKey, section.groups)`, which returns a **new** array on every call (it is memoized on the callback identity, not the result). It then does `orderedGroups.find(...)` and `orderedGroups.filter(...)` over that fresh array, allocating a third array. Three O(G) operations per project per render.
- Archive virtualization in `SessionGroupSection` (`SessionGroupSection.tsx:264-345`) only kicks in at `ARCHIVED_VIRTUALIZE_THRESHOLD = 50` rows and only for `group.isArchivedBucket`. Active and worktree groups render eagerly regardless of size, so a worktree with 80+ active sessions is still fully mounted on expand.

### Already optimized (do not touch)

- `MessageList` virtualization (`MessageList.tsx:23`) with threshold 5 and overscan 6.
- `MessageRow` / `TurnBlock` / `MessageListEntry` are `React.memo`-wrapped with custom `areRenderRelevantMessagesEqual` / `areRelevantTurnGroupingContextsEqual` comparators (`MessageList.tsx:453-508`, `MessageList.tsx:531-820`, `MessageList.tsx:899-954`).
- `getNormalizedMessageForDisplay` is cached via `WeakMap` (`MessageList.tsx:373-393`).
- `MarkdownRenderer` is lazy-loaded with `lazyWithChunkRecovery` (`MarkdownRenderer.tsx:12-26`).
- `expandedToolsStateCache` and `collapsedToolsStateCache` are module-level caches bounded at 4000 entries (`ChatMessage.tsx:39-95`).
- `aggregateLiveSessions` and `aggregateLiveSessionStatuses` bail via `areSessionListsEquivalent` and `areStatusMapsEquivalent` (`live-aggregate.ts:92-180`), and are consumed through `useLiveSyncSelector` so they re-evaluate only when the relevant slice changes.
- `useStickyProjectHeaders` uses `IntersectionObserver`.
- Targeted field cloning in `handleDirectoryEvent` is documented in `packages/ui/src/sync/DOCUMENTATION.md:120-230` and is implemented correctly.
- `useSessionFoldersStore`, `useSessionDisplayStore`, `useActiveNowStore`, `useSessionPinnedStore` are narrow-selector stores.

## Proposed Architecture

### Implementation status

- **Layer 0 — DONE.** Implemented in PR #1660: https://github.com/openchamber/openchamber/pull/1660. Reviewed and passed `type-check:ui` + `lint:ui`.
- **Layer 1–4 — NOT STARTED.** Hand off to the next agent after #1660 merges (or branch from the same `origin/main` baseline).

### Current baseline

The branch was rebased onto `origin/main` at `fa5f9a9b` before Layer 0 was committed. When resuming, ensure the next layer starts from the same `origin/main` HEAD (or rebase again if `main` has moved).

### Layer 0 - Cleanup transitional artifact (prerequisite) ✅ DONE

Commit `ce39dad5` intentionally replaced `useDirectoryStatusProbe` with `buildKnownSessionDirectories` filtering, but left the old hook, props, and checks in the tree. Clean this up first so later layers do not waste time on dead code and so `SessionNodeItem` props shrink.

0.1. **Delete `useDirectoryStatusProbe.ts`** and remove its mention from `packages/ui/src/components/session/sidebar/DOCUMENTATION.md`. ✅
0.2. **Remove `directoryStatus` state from `SessionSidebar.tsx`** (`useState<Map<...>>(() => new Map())`). ✅
0.3. **Remove the `directoryStatus` prop** from `SessionGroupSection` and `SessionNodeItem`. ✅
0.4. **Remove `isMissingDirectory` checks** in `SessionNodeItem` (always `false` today), including the `opacity-75` class and the `directoryStatus.get(directory)` comparison in `areEqual`. ✅

This is behavior-preserving because the Map is always empty; the missing-directory UI never actually rendered.

### Layer 1 - Cheapest, highest impact (start here)

1. **Move heavy work out of `SessionNodeItem.areEqual`.** Replace the four recursive tree walks in the React.memo comparator (`SessionNodeItem.tsx:144-215`) with cheap `Set.has` lookups. Precompute `activeSubtreeMatch`, `menuSubtreeMatch`, `editingSubtreeMatch` once per `SessionGroupSection` (or once per `SessionSidebar`) and pass them down as props. `areEqual` then reduces to `Object.is` checks for primitive props plus the `Set.has` lookups. The function returns the same `true`/`false` for the same inputs as before; only the work changes. This is the single biggest win for the "expand large project / archive" scenario.

2. **`React.memo`-wrap `SessionGroupSection`** with a selective comparator. Bail on `Object.is` for `group`, `groupKey`, `projectId`, `hideGroupLabel`, and for the single relevant `prVisualStateByDirectoryBranch.get(key)` value (instead of comparing the whole `Map` reference). This stops the cascade where a single PR-status update re-renders every group in the sidebar.

3. **Stabilize `renderSessionNode` via the `useStableEvent` ref-wrapper pattern** already used in `MessageList.tsx:41-48`. Replace the 30-dep `useCallback` (`SessionSidebar.tsx:1259-1348`) with a stable-identity function whose body reads the latest values from refs. The `SessionNodeItem.areEqual` comparator then sees a stable `renderSessionNode` reference and bails correctly.

4. **Stop using `getComputedStyle` in a `useLayoutEffect` on every render** (`SessionGroupSection.tsx:307-344`). Thread a `scrollContainerRef` from `SidebarProjectsList` (where `ScrollableOverlay` already owns the scroll element) through to `SessionGroupSection` as a prop. If the prop is missing, fall back to the current walk, but gate it on a `useEffect` with proper deps and a ref cache, so the walk runs at most once per DOM mutation, not once per render.

### Layer 2 - Structural

5. **Replace per-row `useSession(session.id)` with a batched live overlay read.** Build a `liveSessionById: Map<string, Session>` in `SessionSidebar` from the existing `liveSessions` (already a `useMemo`-stable array from `useAllLiveSessions`). Pass that map as a prop to `SessionNodeItem` and replace `const liveSession = useSession(session.id)` (`SessionNodeItem.tsx:300`) with `liveSessionById.get(session.id)`. The `useSession` hook uses `findLiveSession` (`live-aggregate.ts:182-199`) which iterates all child-stores per call; with 200 visible rows that is 200 separate iterations per SSE event. With the batched read, it is zero. To preserve the "sub-render latency" guarantee of `useSession` (the row may want to see a session that is not yet in `useAllLiveSessions`), keep a `useSession`-style fallback only for the cases where the map lookup returns `undefined`. This is behaviorally identical for the user because `useAllLiveSessions` is invalidated synchronously by the same SSE events that would feed `useSession` directly.

6. **Narrow `sessionOrderIndex` and `compareSessionNodes` deps so `sourceGroupNodes` does not invalidate on every `sessions` flip.** `sessionOrderIndex` is rebuilt in `SessionSidebar.tsx:512-515` whenever `sortedSessions` changes identity, and `compareSessionNodes` in `SessionGroupSection.tsx:146-155` depends on `sessionOrderIndex`. Recompute `sessionOrderIndex` against a stable signature key (`sortedSessions.map(s => s.id + ':' + updatedAt).join('|')`) and use that signature as a `Map` cache key. When the signature is unchanged, return the same `Map` reference. The downstream `useMemo` chain (`sourceGroupNodes`, `nodeBySessionId`, `allFoldersForGroupBase`, `allFoldersForGroup`, `sessionIdsInFolders`, `ungroupedSessions`, `rootFolders`, virtualizer) then keeps the same references between renders that did not actually change ordering.

7. **Wrap `collectGroupSessions` and `collectFolderSessions` in `useMemo`.** `collectGroupSessions` (`SessionGroupSection.tsx:373-383`) and `collectFolderSessions` (`SessionGroupSection.tsx:467-474`) currently run in the render body. They are only used to feed handler closures, so their results can be memoized against `[sourceGroupNodes]` and `[allFoldersForGroup]`. The recursive flatten in particular goes from "every render" to "only when sessions change".

8. **Lower the virtualization threshold for non-archived groups and keep the archived threshold at 50.** Introduce a second threshold (e.g. 30) for `group.isArchivedBucket === false`. With `overscan: 8` and `ScrollableOverlay` already at the top, the user-visible behavior is identical; the cost is that expanding a 60-row worktree does not mount 60 rows of `SessionNodeItem` (with their `useState`, `useMemo`, `useCallback`, `ContextMenu`, `Tooltip`, `DropdownMenu`, `useSession` subscription) eagerly. This is the "expand large project" scenario's main lever.

9. **Optimize initial worktree discovery in `SessionSidebar.tsx:403-445`.** The current effect dynamically imports `@/lib/gitApi` and calls `checkIsGitRepository` for every project without a cached `isGitRepo`, then fans out `listProjectWorktrees` via unbounded `Promise.all`. Improvements:
   - Import `checkIsGitRepository` once at module level instead of per-project dynamic import.
   - Reuse `ensureStatus` from `useGitStore` (already triggered by `useProjectRepoStatus`) so the `isGitRepo` check is centralized and cached; skip projects whose `isGitRepo` is still unknown until the store resolves.
   - Constrain `listProjectWorktrees` concurrency (e.g. 3) instead of firing all projects at once.
   - Track already-discovered projects in a ref so a re-mount with an unchanged project set does not re-run discovery.
   - `listProjectWorktrees` already has a 30s client cache and in-flight deduplication; keep that and avoid busting it.

### Layer 3 - Defensive

10. **Cache `getOrderedGroups` results in `SidebarProjectsList`** keyed by `${projectId}:${groups-identity-hash}`. The callback is already stable (`useGroupOrdering.ts:5-28`), but the caller in `SidebarProjectsList.tsx:161-165` discards the result on every render. Hold the previous result in a `useRef` and return the same array reference when inputs are unchanged. Eliminates the three O(G) operations (`find`/`filter`/new-array) per project per render.

11. **TTL-cache `getRootBranch` results in `useProjectRepoStatus`.** The effect (`useProjectRepoStatus.ts:64-136`) is debounced by 150 ms but still re-runs on every `gitRepoStatus` change. Add a 5-minute TTL keyed by `${projectId}:${branch}`. Background status updates will not retrigger `getRootBranch` for projects whose branch has already been resolved recently.

12. **Isolate multi-select subscriptions from the hot Sidebar path.** `selectionModeEnabled`, `selectedIds`, `selectionScopeKey` (`SessionSidebar.tsx:1473-1584`) are subscribed at the top of `SessionSidebar` via `useSessionMultiSelectStore`. When the user activates multi-select and clicks a row, these subscriptions fire and force the entire Sidebar to re-evaluate all its useMemo chains (`prVisualStateByDirectoryBranch`, `prLookupKeys`, `sessionSidebarMetaById`, etc.). Move the bulk-action logic into a dedicated `useSidebarBulkActions` hook that subscribes only when `selectedIds.size > 0`. The boolean `selectionModeEnabled` flag is the only thing the Sidebar tree itself needs from the store.

### Layer 4 - "Many messages in the open chat"

13. **Filter `sessionsByDirectory` in `useProjectSessionLists` to directories the sidebar actually renders.** The current `useMemo` (`useProjectSessionLists.ts:23-36`) iterates **all** `sessions` and groups them by `resolveGlobalSessionDirectory(session)`. With 10 directories and 100 sessions per directory, the map ends up with 1000 entries, of which the sidebar consumes only those tied to `normalizedProjects` and `availableWorktreesByProject`. Restrict the input set via deps `[sessions, normalizedProjects, availableWorktreesByProject]` and precompute the allowed-directory set, then walk only those. Reduces `getSessionsForProject` and `getArchivedSessionsForProject` work proportionally.

   **Coordinate with upstream PR #1504**, which adds subdirectory prefix matching in the same file. Either incorporate its logic or ensure our changes do not conflict.

## What I do not propose to touch (and why)

- The SSE pipeline's targeted field cloning in `handleDirectoryEvent`. Already correct per `packages/ui/src/sync/DOCUMENTATION.md:120-230`.
- `useLiveSyncSelector`, `aggregateLiveSessions` / `aggregateLiveSessionStatuses`, and the `are*Equivalent` comparators. Already narrow and bailing correctly.
- `useStickyProjectHeaders`, `useSidebarPersistence` (with debounced persist), `useSessionFoldersStore`, `useSessionDisplayStore`, `useActiveNowStore`, `useSessionPinnedStore`, `useSessionMultiSelectStore`. All narrow-selector.
- `MessageList` virtualization, `ChatMessage` / `MessageRow` / `TurnBlock` / `MessageListEntry` `React.memo` wrapping, `MarkdownRenderer` lazy load, `expandedToolsStateCache` cap. Already working.
- **No optimistic session-switch transitions, backend search endpoints, scroll-restoration loops, or archived/subagent pagination.** PR #1282 demonstrated that these patterns introduce instability in this codebase; stick to render-cost reduction.

## Expected Effect

Mental back-of-the-envelope, not a profile:

- **Layer 0 (done):** removes 223 lines of dead code; no runtime effect, but shrinks props and simplifies future changes.
- Expanding an archived bucket with 200 sessions and 5 levels of nesting: Layer 1 items 1-3 plus Layer 2 item 6 should cut re-render time by ~90%. Currently estimated at tens of milliseconds per click; after the changes, single-digit milliseconds.
- Cold start with 10 projects x 5 worktrees: Layer 2 item 9 (worktree discovery optimization) and Layer 4 item 13 (filtered `sessionsByDirectory`) should remove 1-2 seconds of initial load.
- Switching the active session in a large project: Layer 2 item 5 (batched `useSession`) and Layer 1 item 3 (stable `renderSessionNode`) should collapse a 200-row re-render cascade to 0-1 rows.

## Files Touched by the Plan

Layer 0 (cleanup) — **DONE in PR #1660**:

- `packages/ui/src/components/session/sidebar/hooks/useDirectoryStatusProbe.ts` (deleted)
- `packages/ui/src/components/session/sidebar/DOCUMENTATION.md` (removed hook mention)
- `packages/ui/src/components/session/SessionSidebar.tsx`
- `packages/ui/src/components/session/sidebar/SessionGroupSection.tsx`
- `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`
- `packages/ui/src/components/session/sidebar/hooks/useProjectSessionSelection.ts`
- `packages/ui/src/components/session/sidebar/hooks/useSessionActions.ts`

Layer 1 (4 files):

- `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`
- `packages/ui/src/components/session/sidebar/SessionGroupSection.tsx`
- `packages/ui/src/components/session/SessionSidebar.tsx`
- `packages/ui/src/components/session/sidebar/SidebarProjectsList.tsx`

Layer 2 (4 files): above plus:

- `packages/ui/src/components/session/sidebar/hooks/useProjectSessionLists.ts`
- `packages/ui/src/sync/live-aggregate.ts` (no API change, only read patterns)

Layer 3 (3 files):

- `packages/ui/src/components/session/sidebar/SidebarProjectsList.tsx` (ref-cached `getOrderedGroups`)
- `packages/ui/src/components/session/sidebar/hooks/useProjectRepoStatus.ts`
- `packages/ui/src/stores/useSessionMultiSelectStore.ts` (no API change, only consumer split)

Layer 4 (1 file): `packages/ui/src/components/session/sidebar/hooks/useProjectSessionLists.ts` (filter input set in `sessionsByDirectory`).

## Conflict risks

- **PR #1448 (unified multi-server sidebar)** rewrites large parts of `SessionSidebar.tsx`, `SidebarProjectsList.tsx`, `SessionNodeItem.tsx`, and `useSessionActions.ts`. If it lands before this work, most of Layer 1 and parts of Layer 2 will need to be rebased. Consider landing small, file-scoped PRs quickly or waiting for #1448 to merge.
- **PR #1504 (subdirectory sessions)** touches `useProjectSessionLists.ts`. Coordinate with it before Layer 4.

## Open Questions

1. **Layer 1 items 1-3 are the highest-impact safest changes. Start there first** before moving to Layer 2.
2. **Layer 2 item 5 (per-row `useSession` -> batched read):** behaviorally neutral for the user, but architecturally moves "where live-session data lives" from a per-row store hook to the parent. Future additions that need per-session subscriptions will need to be hoisted in the same way.
3. **Layer 2 item 8 (extend virtualization to non-archived groups at threshold 30):** visually identical due to `overscan: 8`, but introduces a new `ResizeObserver` and `measureElement` path for active groups. If strict conservatism is required, leave the active group path untouched and apply virtualization only to the archived bucket.
4. **Layer 2 item 9 (worktree discovery):** should we wait for PR #1480 (external worktree watcher) to land first, or proceed independently? The two features touch different lifecycle phases (initial discovery vs. runtime updates) but share `useSessionUIStore.availableWorktreesByProject`.
