import { create } from 'zustand';
import { z } from 'zod';
import { getDeferredSafeStorage } from './utils/safeStorage';

export const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';

const EMPTY_COLLAPSED_PROJECT_IDS: ReadonlySet<string> = new Set();

const parseCollapsedProjectIds = (raw: string | null): ReadonlySet<string> => {
  if (!raw) return EMPTY_COLLAPSED_PROJECT_IDS;
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? new Set(parsed.data) : EMPTY_COLLAPSED_PROJECT_IDS;
  } catch {
    return EMPTY_COLLAPSED_PROJECT_IDS;
  }
};

const setsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

type ProjectCollapseStore = {
  collapsedProjectIds: ReadonlySet<string>;
  setCollapsedProjectIds: (ids: ReadonlySet<string>) => void;
};

// The one owner of "which project IDs are collapsed in the sidebar", backed by
// the `oc.sessions.projectCollapse` localStorage key. This is intentionally
// separate from the settings-synced `project.sidebarCollapsed` field: that
// field is skipped for VS Code (`useSessionProjectViewState`'s desktop-settings
// persist returns early there), so it never reflects VS Code's real collapse
// state. This store is written directly by `useSessionProjectViewState` on
// every toggle regardless of runtime, so background-discovery eligibility
// (`worktreeDiscoveryProjects.ts` and its callers) can read one source that is
// accurate on every runtime.
export const useProjectCollapseStore = create<ProjectCollapseStore>((set) => ({
  collapsedProjectIds: parseCollapsedProjectIds(getDeferredSafeStorage().getItem(PROJECT_COLLAPSE_STORAGE_KEY)),
  setCollapsedProjectIds: (collapsedProjectIds) => set((state) => (
    setsEqual(state.collapsedProjectIds, collapsedProjectIds) ? state : { collapsedProjectIds }
  )),
}));
