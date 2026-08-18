import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

// 'by-worktree' keeps per-worktree sub-headers inside each project zone
// (parallel-work overview); 'flat' merges everything into one recency list.
type SessionGroupingMode = 'by-worktree' | 'flat';

type SessionDisplayStore = {
  sessionGroupingMode: SessionGroupingMode;
  setSessionGroupingMode: (mode: SessionGroupingMode) => void;
  /** Project/recent zone headers stick to the top while their zone scrolls. */
  stickyZoneHeaders: boolean;
  toggleStickyZoneHeaders: () => void;
  showRecentSection: boolean;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive page. Web/desktop ignore this flag and
  // always route archived sessions to the Archive page instead.
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
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
  return state;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      sessionGroupingMode: 'by-worktree',
      setSessionGroupingMode: (mode) => set({ sessionGroupingMode: mode }),
      stickyZoneHeaders: true,
      toggleStickyZoneHeaders: () => set((state) => ({ stickyZoneHeaders: !state.stickyZoneHeaders })),
      showRecentSection: true,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 4,
      // v1→v2 adds projectSortOrder using the canonical manual ordering.
      // v2→v3 replaces the previously shipped recent default with manual.
      // v3→v4 removes displayMode (single sidebar row layout).
      migrate: migrateSessionDisplayState,
    },
  ),
);

export type { ProjectSortOrder };
