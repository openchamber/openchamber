# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar is now a single multi-project tree: `recent` top section, then projects, then worktrees/archived groups, then sessions.
- `NavRail` is no longer part of sidebar/navigation flow.
- Project headers now own root sessions directly; there is no separate rendered `project root` subgroup.
- Active/hover row styling is text-first; selected sessions use primary text instead of background fills.
- Archived groups are collapsed by default and support bulk deletion at group/folder level.
- Session rows support compact inline dates in minimal mode and simplified metadata in default mode.
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI for add-project, session search, and display mode.
- `SidebarActivitySections.tsx`: Global top section renderer; currently used for the `recent` section only.
- `SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, and about actions.
- `SidebarProjectsList.tsx`: Main scrollable tree renderer for projects, root sessions, worktrees/groups, and empty/search states.
- `SessionGroupSection.tsx`: Renders a single worktree/archived group, collapse/expand, folder subtree, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, and nested children.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Prefetches messages for nearby/active sessions to improve perceived load speed.
- `hooks/useDirectoryStatusProbe.ts`: Probes and caches directory existence status for session/path indicators.
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
- `utils.tsx`: Shared sidebar utilities (path normalization, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting).
