import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Expand/collapse state for the mobile sessions sheet tree.
 *
 * Stores only explicit user overrides, keyed by project id (projects) and
 * `${projectId}::${bucketKey}` (worktree groups). A missing key means "use the
 * default": projects start expanded, worktree groups start collapsed. The
 * user's choice is remembered across app restarts and is intentionally
 * decoupled from the active directory/session — selecting a session no longer
 * forces a project open or closed.
 */
type MobileSessionTreeStore = {
  projectExpanded: Record<string, boolean>;
  worktreeExpanded: Record<string, boolean>;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setWorktreeExpanded: (key: string, expanded: boolean) => void;
};

export const useMobileSessionTreeStore = create<MobileSessionTreeStore>()(
  persist(
    (set) => ({
      projectExpanded: {},
      worktreeExpanded: {},
      setProjectExpanded: (projectId, expanded) =>
        set((state) => ({ projectExpanded: { ...state.projectExpanded, [projectId]: expanded } })),
      setWorktreeExpanded: (key, expanded) =>
        set((state) => ({ worktreeExpanded: { ...state.worktreeExpanded, [key]: expanded } })),
    }),
    {
      name: 'mobile-session-tree',
    },
  ),
);
