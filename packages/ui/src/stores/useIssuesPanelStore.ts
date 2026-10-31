import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { DEFAULT_ISSUE_FILTER, type IssueFilter } from '@/components/references/referencePickerItems';

const ISSUES_PANEL_STORAGE_KEY = 'openchamber.issues-panel';

/** What the Issues tab was last left on for one project: its filter and its open issue. */
type IssuesPanelEntry = {
  filter: IssueFilter;
  openIssueNumber: number | null;
};

export const EMPTY_ISSUES_ENTRY: IssuesPanelEntry = { filter: DEFAULT_ISSUE_FILTER, openIssueNumber: null };

// A persisted filter is validated, not cast: a stale or hand-edited value falls
// back to the default instead of reaching the list read as an unknown state.
// The issues list only distinguishes open, closed and all, so the fallback is
// the default narrowed to those.
const persistedEntry = z.object({
  filter: z.object({
    state: z.enum(['open', 'closed', 'all']).catch('open'),
    people: z.enum(['any', 'assigned', 'created']).catch('any'),
    labelNames: z.array(z.string()).catch([]),
    milestoneNames: z.array(z.string()).catch([]),
  }).catch({ state: 'open', people: 'any', labelNames: [], milestoneNames: [] }),
  openIssueNumber: z.number().int().nullable().catch(null),
}).transform((entry): IssuesPanelEntry => entry);

type IssuesPanelState = {
  /** Keyed by runtime, then by project context id. */
  byProject: Record<string, Record<string, IssuesPanelEntry>>;
  getEntry: (projectContextId: string) => IssuesPanelEntry;
  setFilter: (projectContextId: string, filter: IssueFilter) => void;
  setOpenIssue: (projectContextId: string, number: number | null) => void;
};

/**
 * The Issues tab's own state, per project: its filter and the issue it had
 * open, so the tab reopens the way it was left. Filter changes and opening an
 * issue write here; the panel's open-entry state stays local.
 */
export const useIssuesPanelStore = create<IssuesPanelState>()(
  persist(
    (set, get) => ({
      byProject: {},
      getEntry: (projectContextId) => {
        const runtimeKey = getRuntimeKey();
        return get().byProject[runtimeKey]?.[projectContextId] ?? EMPTY_ISSUES_ENTRY;
      },
      // The first write to a project seeds the entry from the defaults; a
      // bare spread of the missing entry would leave the other field out.
      setFilter: (projectContextId, filter) => set((state) => {
        const runtimeKey = getRuntimeKey();
        const byRuntime = state.byProject[runtimeKey] ?? {};
        return { byProject: { ...state.byProject, [runtimeKey]: { ...byRuntime, [projectContextId]: { ...EMPTY_ISSUES_ENTRY, ...byRuntime[projectContextId], filter } } } };
      }),
      setOpenIssue: (projectContextId, number) => set((state) => {
        const runtimeKey = getRuntimeKey();
        const byRuntime = state.byProject[runtimeKey] ?? {};
        return { byProject: { ...state.byProject, [runtimeKey]: { ...byRuntime, [projectContextId]: { ...EMPTY_ISSUES_ENTRY, ...byRuntime[projectContextId], openIssueNumber: number } } } };
      }),
    }),
    {
      name: ISSUES_PANEL_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ byProject: state.byProject }),
      merge: (persisted, current) => {
        const parsed = z.object({ byProject: z.record(z.string(), z.record(z.string(), persistedEntry)).catch({}) }).safeParse(persisted);
        return parsed.success ? { ...current, byProject: parsed.data.byProject } : { ...current, byProject: {} };
      },
    },
  ),
);
