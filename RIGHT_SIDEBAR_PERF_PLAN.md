# Right Sidebar Performance Plan

## Status — DONE (PR #1674)

### P0 — Correctness / leak fixes

- [x] **RightSidebar**: drop dead `useEffect` that re-nulled refs the resize handler already nulled; collapse redundant `width`/`minWidth`/`maxWidth` triple into `width` + the existing `--oc-right-sidebar-width` variable.
- [x] **useUIStore**: clamp `setRightSidebarWidth` to `[MIN, MAX]`; simplify `setRightSidebarOpen` (22 lines → 12).
- [x] **RightSidebarTabs / `useRightSidebarGitSync`**: takes right tab + main tab; only polls when the right git tab is the visible consumer AND the browser is online + visible. Replaces a poll that ran for the lifetime of any open sidebar.
- [x] **GitView**: commit-files fetch refactored to `cancelled` + `Promise.all` (was a per-hash loop that could `setState` after unmount); `getRemoteUrl` and `refreshRemotes` gated on `cancelled` / `mountedRef`; new module-scoped `mountedRef` guards `setIsSettingIdentity` from firing after unmount.
- [x] **GitView + `useGitmojiList`**: extract gitmoji fetch/cache into a hook with module-level inflight promise + subscribers Set; stale-while-revalidate from localStorage; `ensureLoaded()` for call-site-initiated hydration; `cancelled` flag on `setIsLoading` to avoid the React setState-after-unmount race.
- [x] **ProjectNotesTodoPanel**: 400 ms notes debounce now cancels on blur (was double-saving); `persistProjectData` chained per project through a module-level `Map<projectId, Promise>` so a fast todo toggle racing the debounced save no longer hits the server in parallel; resize auto-adjust guards against same-value pings.

### P1 — Render fanout

- [x] **RightSidebarTabs**: all three tab content components now always mounted with the `hidden` attribute. State and cache survive tab switches. When `activeMainTab === 'git'` (or `'context'`) the matching right tab is filtered out of the tab strip and a redirect effect snaps any persisted-but-now-hidden right tab to `'files'`. `onSelect` is now a type-guarded handler instead of `as RightTab`.
- [x] **GitView**: 13 separate `useGitStore` action selectors collapsed into one `useShallow` block (one re-evaluation per store change instead of 13).
- [x] **GitView**: new `isGitViewActive` flag (true when this instance is the visible consumer) gates the 7 live effects — load identities, fetch remote URL, refresh remotes, `ensureAll`, `sessionEvents.onGitRefreshHint`, worktree bootstrap poll, default-identity auto-apply. Hidden GitView instances no longer run these.
- [x] **GitView**: `gitViewSnapshots` module-level Map is now backed by an LRU wrapper (cap 20) so per-directory draft snapshots cannot leak across hundreds of project switches. Removed the dead `unique.set` dedup in `changeEntries` — `GitStatus.files` is already unique by path.
- [x] **SidebarFilesTree**: `statusByPath` `Map<path, FileStatus>` and `badgeByDir` `Map<dirPath, { modified, added }>` are precomputed once per `gitStatus` change. Tree render is O(1) per node instead of O(N) per node. `badgeByDir` walks each file's path segments and increments counters for every ancestor dir.
- [x] **SidebarFilesTree**: `FileRow` wrapped in `React.memo` with a custom comparator. Context-menu open state moved INTO `FileRow` as local state — opening a menu in one row no longer re-renders siblings.
- [x] **SidebarFilesTree**: `loadDirectory` accepts an `isCancelled` predicate; the batch-load effect for `expandedPaths` passes a stable predicate so per-dir fetches stop touching state once the effect tears down.
- [x] **SidebarFilesTree**: module-level `fileTreeCacheByRoot` Map (LRU, cap 8 roots) hydrates `childrenByDir` / `loadErrorsByDir` / `loadedDirsRef` on mount or root change. Mirror effects write state back to the cache. Survives close-and-reopen of the right sidebar.

### Review fixes (post-review)

- [x] **Blocker**: `inFlightDirsRef` leak — removed `isCancelled` guard from `finally` so inflight flag always cleans up. Re-expanding a cancelled directory correctly retries.
- [x] **Non-blocker**: duplicate `RIGHT_SIDEBAR_MAX_WIDTH` — exported from `useUIStore`, imported in `RightSidebar`. Single source of truth.
- [x] **Non-blocker**: `useRightSidebarGitSync` poll gating — verified `shouldPoll` already includes `rightTab === 'git'`. No code change needed.

## Files modified

| File | Change |
|------|--------|
| `packages/ui/src/components/layout/RightSidebar.tsx` | Drop dead useEffect, collapse width props, import constants from store |
| `packages/ui/src/components/layout/RightSidebarTabs.tsx` | Always-mount tabs, gated poll, redirect effect, type-guarded onSelect |
| `packages/ui/src/components/layout/SidebarFilesTree.tsx` | Precomputed maps, React.memo(FileRow), isCancelled predicate, LRU cache |
| `packages/ui/src/components/git/GitView.tsx` | Cancelled + Promise.all, isGitViewActive, useShallow, LRU snapshots |
| `packages/ui/src/components/project/ProjectNotesTodoPanel.tsx` | Debounce cancel on blur, chained persistProjectData |
| `packages/ui/src/stores/useUIStore.ts` | Clamp setRightSidebarWidth, simplify setRightSidebarOpen, export constants |
| `packages/ui/src/hooks/useGitmojiList.ts` | **New** — module-level inflight + subscribers, localStorage cache |

## Architecture notes

- The redirect effect snaps `rightSidebarTab` to `'files'` whenever `activeMainTab === 'git'`, so the right and main `GitView` instances are mutually exclusive — `isGitViewActive` cannot be true for both.
- The 7 gated effects plus the `useRightSidebarGitSync` poll cover all cases where git state should advance: visible consumer fetches; the poll keeps the store warm when only the right git tab is visible.
- The `loadDirectory` cancellation predicate prevents stale state writes in `try`/`catch`; the `finally` block always cleans up `inFlightDirsRef`.

## Out of scope (deferred)

- Virtualization of `SidebarFilesTree` (large refactor; current precomputed maps already address the main bottlenecks).
- Lazy plan titles (requires `openchamberConfig` schema changes).
- Extracting remaining sub-views from `GitView` (large refactor, not perf-critical).
