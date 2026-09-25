import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getSettingsSurface } from '@/lib/settings/surface';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';
// Worktree groups inside a project. 'recent' floats worktrees with the latest
// session activity to the top, so the list moves as sessions run; 'manual'
// and 'a-z' keep positions stable.
type WorktreeSortOrder = 'recent' | 'manual' | 'a-z';

// 'projects' is the grouped sidebar: project zones with worktree sub-headers,
// optional Recent. 'timeline' is one recency-ordered list of root sessions
// across every project, with three-line rows carrying project and branch.
type SidebarViewMode = 'projects' | 'timeline';
type ProjectDisplayMode = 'all' | 'single';

// The phone starts on the timeline: its sheet has no room for nested project
// trees. Every other surface keeps the grouped sidebar people know.
export const defaultSidebarViewMode = (): SidebarViewMode => (
  getSettingsSurface() === 'mobile' ? 'timeline' : 'projects'
);

type SessionDisplayStore = {
  projectDisplayMode: ProjectDisplayMode;
  singleProjectId: string | null;
  setProjectDisplayMode: (mode: ProjectDisplayMode) => void;
  setSingleProjectId: (projectId: string) => void;
  sidebarViewMode: SidebarViewMode;
  setSidebarViewMode: (mode: SidebarViewMode) => void;
  /** Local display preference; motion remains opt-in. */
  animatedActivityIndicators: boolean;
  setAnimatedActivityIndicators: (enabled: boolean) => void;
  showRecentSection: boolean;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive page. Web/desktop ignore this flag and
  // always route archived sessions to the Archive page instead.
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  worktreeSortOrder: WorktreeSortOrder;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
  setWorktreeSortOrder: (order: WorktreeSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    stickyZoneHeaders?: boolean;
  };
  if (version < 2) {
    state.projectSortOrder = 'manual';
  }
  if (version < 3 && state.projectSortOrder === 'recent') {
    state.projectSortOrder = 'manual';
  }
  if (version < 4) {
    // v4 removes the default/minimal display mode: the sidebar now has a
    // single row layout. Drop the stale key from persisted state.
    delete state.displayMode;
  }
  if (version < 6) {
    // v6 removes the by-worktree/flat grouping choice: the projects view always
    // groups by worktree, and the flat recency list became the timeline view.
    delete state.sessionGroupingMode;
  }
  if (version < 7) {
    // v7 removes the sticky-headers toggle: the projects view always pins its
    // zone headers and the timeline never does.
    delete state.stickyZoneHeaders;
  }
  if (version < 8) {
    // v8 turns Recent off: it duplicated the project groups, and the timeline
    // view now answers "what was I doing" across projects. An explicit server
    // preference (sidebarShowRecentSection) still re-enables it on sync.
    state.showRecentSection = false;
  }
  if (version < 9 && !state.worktreeSortOrder) {
    // v9 adds the worktree sort. Everyone starts on a stable manual order:
    // an activity-sorted list moved rows under the pointer, next to
    // destructive actions like deleting a worktree.
    state.worktreeSortOrder = 'manual';
  }
  return state;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      animatedActivityIndicators: false,
      setAnimatedActivityIndicators: (enabled) => set({ animatedActivityIndicators: enabled }),
      projectDisplayMode: 'all',
      singleProjectId: null,
      setProjectDisplayMode: (mode) => set({ projectDisplayMode: mode }),
      setSingleProjectId: (projectId) => set({ singleProjectId: projectId }),
      sidebarViewMode: defaultSidebarViewMode(),
      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),
      // Off by default since the timeline view took over cross-project recency;
      // the toggle stays for people who want it inside the grouped view.
      showRecentSection: false,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      worktreeSortOrder: 'manual',
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
      setWorktreeSortOrder: (order) => set({ worktreeSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 9,
      // v1→v2 adds projectSortOrder using the canonical manual ordering.
      // v2→v3 replaces the previously shipped recent default with manual.
      // v3→v4 removes displayMode (single sidebar row layout).
      // v4→v5 adds the independent all-projects/single-project view mode.
      // v5→v6 drops sessionGroupingMode in favour of sidebarViewMode.
      // v6→v7 drops stickyZoneHeaders (derived from the view mode now).
      // v7→v8 defaults showRecentSection to false.
      // v8→v9 adds worktreeSortOrder (manual by default).
      migrate: migrateSessionDisplayState,
    },
  ),
);

export type { ProjectDisplayMode, ProjectSortOrder, SidebarViewMode, WorktreeSortOrder };
