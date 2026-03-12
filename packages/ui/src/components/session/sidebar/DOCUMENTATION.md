# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Sidebar behavior stays intact: global+archived session grouping, folder operations, delete/archive semantics, project/worktree rendering, and search.
- Recent migration gaps were fixed (persistence + repo-status hooks fully wired).
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer
- Baseline checks pass after refactor: `type-check`, `lint`, `build`.

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI (project selector/rename, search, add/open actions, notes/worktree entry points).
- `SidebarProjectsList.tsx`: Main scrollable list renderer for project sections/groups, empty states, and project-level interactions.
- `SessionGroupSection.tsx`: Renders a single group (root sessions + folders), collapse/expand, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with metadata, menu actions, inline rename, and nested children.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering with drag handles/overlays.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Prefetches messages for nearby/active sessions to improve perceived load speed.
- `hooks/useDirectoryStatusProbe.ts`: Probes and caches directory existence status for session/path indicators.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useGroupOrdering.ts`: Applies persisted/custom group order with stable fallback ordering.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/pinned/group order/active session) to storage + desktop settings.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Builds live and archived session lists for a given project (including worktrees + dedupe).
- `hooks/useSessionFolderCleanup.ts`: Cleans stale folder session IDs by reconciling known sessions/archived scopes.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `utils.tsx`: Shared sidebar utilities (path normalization, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels).
