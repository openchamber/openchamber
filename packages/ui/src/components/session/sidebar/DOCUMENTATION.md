# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar is now a single multi-project tree: `recent` top section, then projects, then worktrees/archived groups, then sessions.
- Project rows retain the persisted project-registry order while session and worktree data hydrates. Session activity never reorders the structural project tree; the Recent section represents recency instead.
- The Projects section header shows a localized session-sync status while global sessions and initial worktree discovery are still loading.
- `NavRail` is no longer part of sidebar/navigation flow.
- Project headers now own root sessions directly; there is no separate rendered `project root` subgroup.
- Active/hover rows use Codex-style inset neutral chips (`SIDEBAR_ROW_*`); nested rows indent via
  padding *inside* the chip so hover/active wash stays full-width (reserved left gutter). Nest
  step equals the folder icon column (`16 + 6`) so child text lines up under the parent folder name.
- Session rows are single-line (no inline timestamp); details (title, relative time, folder/project,
  branch) open in an immediate floating hover card (`delayDuration={0}`, top-left aligned).
- Compact relative times use `common.relative.*Compact` i18n keys.
- Row action icons (archive, menu) use title-matched `h-3.5` glyphs with `gap-1` spacing; the title
  reserves right padding on hover so icons own their space — no fade veil behind them.
- Archived groups are collapsed by default and support bulk deletion at group/folder level.
- Session rows support compact inline dates in minimal mode and simplified metadata in default mode.
- Session-row visual selection is published through a narrow row-only Focus store before authoritative navigation. Focus includes the render scope (`recent` or `project`) plus session/project identity, so duplicate representations never both receive the Active background or satisfy the wrong paint barrier.
- Previous/next-session navigation consumes ordered snapshots published from the rendered sidebar model. A Recent-origin focus cycles Recent items; a project-origin focus cycles the project tree. Project/group/folder ancestors and hidden row batches are expanded synchronously when a shortcut targets an unmounted row.
- Every session navigation announces a monotonic intent revision. A later sidebar, keyboard, deep-link, or switcher intent invalidates an older pending sidebar commit, including ABA sequences such as A -> B -> A.
- Chat LRU visibility follows the authoritative selection synchronously: cache hits reveal the retained Activity immediately, while misses show an explicit skeleton. A newly rendered Activity enters the bounded LRU only after its DOM commit, so interrupted keyboard switches cannot evict a reusable view.
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group and emits **no per-worktree subgroups** (worktrees aren't registered in VS Code). `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no worktree/close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning therefore work natively, scoped to the workspace root.

## File summaries

### Components

- `SidebarHeader.tsx`: Optional session-search field only (action toolbar removed).
- `SidebarDisplayModeMenu.tsx`: Display-mode equalizer menu; rendered on the Recent section title row.
- `SidebarActivitySections.tsx`: Global top section renderer; currently used for the `recent` section only.
- `SidebarFooter.tsx`: Static footer with icon-only settings and shortcuts actions, plus optional update button.
- `SidebarProjectsList.tsx`: Main scrollable tree renderer for projects, root sessions, worktrees/groups, and empty/search states.
- `SessionGroupSection.tsx`: Renders a single worktree/archived group, collapse/expand, folder subtree, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, and nested children.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sessionNavigationModel.ts`: Flattens the rendered project/group/folder model into the exact ordered shortcut targets, including ancestor reveal metadata.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Prefetches messages for nearby/active sessions to improve perceived load speed.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useGroupOrdering.ts`: Applies persisted/custom group order with stable fallback ordering; archived groups are reorderable.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/pinned/group order/active session) to storage + desktop settings.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Builds live and archived session lists for a given project (including worktrees + dedupe).
- `hooks/useSessionFolderCleanup.ts`: Cleans stale folder session IDs by reconciling known sessions/archived scopes.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `activitySections.ts`: Persisted top-section storage/helpers for the current `recent` session list.
- `utils.tsx`: Shared sidebar utilities (path normalization, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting, nest-indent padding helpers).
