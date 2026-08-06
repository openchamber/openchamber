# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Layout (web/desktop): top navigation (`SidebarNav`: New session, Scheduled, Multi-run, Archive), then the `recent` zone, then one zone per project with a **flat** session list. There is no rendered worktree grouping level.
- **Two grouping display modes** (`useSessionDisplayStore.sessionGroupingMode`, toggled in the view dropdown): `'by-worktree'` (default) renders the worktree-grouped `sectionsForRender` with slim PR-aware branch sub-headers inside each project zone; `'flat'` renders `flatSectionsForRender` — one merged non-archived group per project (`id: 'flat'`, `folderScopes` listing every contributing scope) with per-row branch markers. Both derive from the same `projectSections` data layer, which alone feeds bootstrap demand planning and PR polling.
- When sticky zone headers are enabled, project headers are sticky "zone" bands (`SortableProjectItem`); on a vibrant desktop the scrolling content fades behind an unmasked, non-interactive copy of the stuck icon/title without painting a background. The transparent fade zone blocks interaction with obscured rows. The `recent` section uses the same overlay while it is the leading sticky header. Collapsed projects show an aggregated busy/unseen indicator (`ProjectAggregateStatusIndicator`), derived from the live status index and notification store scoped to the project's directories.
- **Activity is a dot plus a counter, never a spinner.** The row's left gutter shows a static dot — primary while the session runs (`busy`/`retry`), info while it is unread — and the metadata slot on the right swaps the goal/branch/date group for the elapsed time of the turn (`SessionActivityDuration`, ticking once per second). The readout takes the dot's color in each state — primary while running, info once it is waiting to be read — so the pair reads as one indicator. A running spinner repainted a composited layer per row every frame for the whole turn; the counter conveys the same "something is happening" at 1 fps. The counter follows the unread marker's lifetime exactly: it survives the turn ending, disappears when the session is read, and never lingers on the session being watched (which is marked read as it goes idle). Aggregate indicators for collapsed groups, folders, and projects show the dot only — a group may hold several running turns, so a single counter would have nothing to count. The same treatment applies to the mobile sessions sheet and session switcher rows. The worktree-move indicator stays a spinner: it marks a short user-initiated operation, not a session state.
- Session rows have a single layout (former `minimal`); the `default`/`minimal` display mode was removed (`session-display-mode` store v4 migration drops the key). Rows show an inline branch label (from `node.worktree` or recent's `secondaryMeta`) when the session lives outside the project root, and bold titles while unread.
- Folders render **flat** after the loose sessions: nested folders keep `parentId` in the data model but display at one level with a "Parent / Child" path label (`SessionFolderItem.displayName`); collapsing a folder hides its whole subtree. Folder actions resolve their owning scope per folder entry (folders from multiple worktree scopes can coexist under one project).
- Archived sessions are not shown in the web/desktop sidebar; the Archive page (`ArchiveView`, `useUIStore.isArchivePageOpen`) replaces the old toggle. VS Code keeps inline archived buckets behind `showArchivedSessions` (compact webview has no page surfaces). Restore (unarchive) is available per session (row context menu, Archive page row) and in bulk (selection bar) and writes `time.archived = 0` — the server cannot clear the field over HTTP, so the global session cache splits active/archived client-side (see "Restore (unarchive) contract" in `sync/DOCUMENTATION.md`).
- Scheduled tasks (`ScheduledTasksDialog`, now a full-page surface on web/desktop) and per-project worktree management (`WorktreesView`, opened from the project menu) render as overlays inside `<main>` in `MainLayout`; the sidebar no longer mounts them.
- Group-level PR-status polling/indicators and worktree-group drag-to-reorder were removed together with the worktree grouping level; `oc.sessions.groupOrder` is no longer read or written. Worktree PR/branch context lives in the Worktrees surface.
- Root session menus can quickly create a worktree from the session directory's current branch and move the full session subtree there while idle.
- Directory loading is demand-driven: the sidebar publishes one complete priority plan for all known project/worktree directories, while the sync layer owns bounded execution.
- When multiple configured projects are checkouts of the same Git repository, exactly one project owns the shared worktree topology: the configured canonical primary root when present, otherwise the first configured source for that repository. Any worktree path that is also a configured project is omitted from subordinate worktree groups, so every directory has one sidebar location while remaining part of bootstrap demand.

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group and emits **no per-worktree subgroups** (worktrees aren't registered in VS Code). `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no worktree/close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning therefore work natively, scoped to the workspace root.

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI for add-project, session search, selection mode, project sort, and the display menu (recent toggle, collapse/expand all).
- `SidebarNav.tsx`: Text navigation rows above the tree (New session, Scheduled, Multi-run, Archive); hidden in VS Code.
- `SidebarActivitySections.tsx`: Global top section renderer; currently used for the `recent` section only, styled as a zone header.
- `SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, and about actions.
- `SidebarProjectsList.tsx`: Main scrollable renderer for project zones and their flat/archived groups plus empty/search states; owns project drag-to-reorder.
- `SessionGroupSection.tsx`: Renders one flat (or archived) group: sessions first, then flat folder entries with path labels, show-more batching, and explicit loading/error/retry state for empty groups. Archived buckets (VS Code) virtualize past 50 rows.
- `SessionNodeItem.tsx`: Renders one session row/tree node with a single-line layout, inline branch label, indicators, menu actions, and nested children. Pending-question counts stay per-session while expanded and roll up hidden descendants from their owning directory stores while collapsed. Rows do not initiate directory bootstrap on mount.
- `collapsedActivityIndicator.tsx`: Aggregate busy/unseen dot for collapsed groups and folders.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrapper for project ordering plus the sticky zone-band project header and its action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sessionOwnership.ts`: Resolves session directories once into shared project/worktree ownership and folder-scope indexes.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Publishes directory-aware nearby/active session prefetch demand to the shared message loader. Recent may prefetch across projects without substituting the current directory.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/pinned/group order/active session) to storage + desktop settings.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `hooks/useAuthoritativeSessionCleanup.ts`: Establishes the first complete active+archived list as a non-destructive baseline, then cleans persisted state only for sessions omitted by a later authoritative snapshot.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `activitySections.ts`: Persisted top-section storage/helpers for the current `recent` session list.
- `sessionBootstrapDemands.ts`: Builds the deduplicated directory demand plan. Selected directories rank above active projects, expanded groups, visible collapsed groups, and background/collapsed projects.
- `utils.tsx`: Shared sidebar utilities (path normalization, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting). Shared session ranking lives in `sync/session-ordering.ts`.

## Loading rules

- Always publish every known project root and worktree directory. Collapse/visibility changes priority only; they do not opt a directory out of authoritative refresh.
- Current directory and selected-session directory are `selected` demand and therefore run first.
- Expanded projects/worktrees outrank merely visible and background groups.
- The sync scheduler deduplicates, promotes, retries, and limits work. Sidebar components must not reproduce that lifecycle with mount effects.
- Hide speculative work when the sidebar/chat surface is hidden: message prefetch, Git/PR enrichment and subscriptions, search listeners, sticky-header observation, and archived-folder derivation stop. The session row tree unmounts so row-owned status, permission, unseen, and viewport subscriptions do no background work. The outer sidebar remains mounted, preserving UI state and authoritative directory refresh for an immediate reopen; deferred derived work reruns from current state when visibility returns.
- The sidebar does not subscribe its whole tree to the cross-directory live-session aggregate. Global create/structural/lifecycle snapshots drive rendered session metadata; the cached sync index only fills sessions not yet present globally and provides refresh fallback data. Row activity continues to come from the session-keyed live status index.
- Session selection does not invalidate the sidebar orchestration component. Each mounted row selects only whether its own session ID is active, while parent expansion, project selection memory, and neighbor prefetch run in small effect-only subscribers.
- Parent expansion is exclusively manual. Selecting or navigating to a subsession never expands its parent automatically. Project/worktree and `recent` trees use independent persisted context keys and receive separate stable projections, so expansion changes in one context neither invalidate nor change the other. The persisted storage key remains `v3`; older state mixed contexts and is not migrated into this contract.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, share, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event retriggers bounded worktree discovery so a newly created external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- Recent membership includes active root sessions immediately even when their last committed `time.updated` falls outside the 48-hour window. Children and archived sessions remain excluded, and inactive roots remain timestamp-based. The active-ID subscription is disabled while the sidebar is hidden and ignores retry/status detail changes, avoiding streaming-frequency rerenders.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, or branch changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
