import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import type { RepositoryReferenceKind } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const SOURCE_BOARD_STORAGE_KEY = 'openchamber.source-board';

export type SourceBoardTab = 'repository' | `tracker:${string}`;

const TRACKER_TAB = /^tracker:[a-z][a-z0-9-]{0,31}$/;
const isSourceBoardTab = (value: string): value is SourceBoardTab => value === 'repository' || TRACKER_TAB.test(value);

type SourceBoardChoice = {
  projectId: string | null;
  tab: SourceBoardTab;
  trackerContainerByProvider: Record<string, string | null>;
  repositoryByProject: Record<string, string>;
  allRepositoriesByProject: Record<string, boolean>;
};

const EMPTY_CHOICE: SourceBoardChoice = { projectId: null, tab: 'repository', trackerContainerByProvider: {}, repositoryByProject: {}, allRepositoriesByProject: {} };

type SourceBoardState = {
  choices: Record<string, SourceBoardChoice>;
  trackerFocus: { provider: string; identifier: string } | null;
  update: (patch: Partial<SourceBoardChoice>) => void;
  focusTrackerItem: (provider: string, identifier: string) => void;
  clearTrackerFocus: () => void;
  repositoryFocus: { kind: RepositoryReferenceKind; query: string } | null;
  focusRepositoryItem: (projectId: string, kind: RepositoryReferenceKind, query: string) => void;
  clearRepositoryFocus: () => void;
  listWidth: number | null;
  setListWidth: (width: number) => void;
};

const LEGACY_LINEAR_TAB = 'linear';

const persistedChoice = z.object({
  projectId: z.string().nullable().catch(null),
  tab: z.string().catch('repository').transform((tab): SourceBoardTab => {
    if (tab === LEGACY_LINEAR_TAB) return 'tracker:linear';
    return isSourceBoardTab(tab) ? tab : 'repository';
  }),
  linearTeamId: z.string().nullable().catch(null).optional(),
  trackerContainerByProvider: z.record(z.string(), z.string().nullable()).catch({}),
  repositoryByProject: z.record(z.string(), z.string()).catch({}),
  allRepositoriesByProject: z.record(z.string(), z.boolean()).catch({}),
}).transform(({ linearTeamId, trackerContainerByProvider, ...choice }): SourceBoardChoice => ({
  ...choice,
  trackerContainerByProvider: linearTeamId && !Object.hasOwn(trackerContainerByProvider, 'linear')
    ? { ...trackerContainerByProvider, linear: linearTeamId }
    : trackerContainerByProvider,
}));

const persistedChoices = z.object({
  choices: z.record(z.string(), persistedChoice).catch({}),
  listWidth: z.number().positive().nullable().catch(null).optional(),
});

export const useSourceBoardStore = create<SourceBoardState>()(
  persist(
    (set, get) => ({
      choices: {},
      trackerFocus: null,
      update: (patch) => set((state) => {
        const runtimeKey = getRuntimeKey();
        const current = state.choices[runtimeKey] ?? EMPTY_CHOICE;
        const repositoryByProject = { ...current.repositoryByProject, ...patch.repositoryByProject };
        const allRepositoriesByProject = { ...current.allRepositoriesByProject, ...patch.allRepositoriesByProject };
        const trackerContainerByProvider = { ...current.trackerContainerByProvider, ...patch.trackerContainerByProvider };
        return {
          choices: {
            ...state.choices,
            [runtimeKey]: { ...current, ...patch, repositoryByProject, allRepositoriesByProject, trackerContainerByProvider },
          },
        };
      }),
      focusTrackerItem: (provider, identifier) => {
        get().update({ tab: `tracker:${provider}`, trackerContainerByProvider: { [provider]: null } });
        set({ trackerFocus: { provider, identifier } });
      },
      clearTrackerFocus: () => set({ trackerFocus: null }),
      repositoryFocus: null,
      focusRepositoryItem: (projectId, kind, query) => {
        get().update({ projectId, tab: 'repository' });
        set({ repositoryFocus: { kind, query } });
      },
      clearRepositoryFocus: () => set({ repositoryFocus: null }),
      listWidth: null,
      setListWidth: (width) => set({ listWidth: Math.round(width) }),
    }),
    {
      name: SOURCE_BOARD_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ choices: state.choices, listWidth: state.listWidth }),
      merge: (persisted, current) => {
        const parsed = persistedChoices.safeParse(persisted);
        return parsed.success
          ? { ...current, choices: parsed.data.choices, listWidth: parsed.data.listWidth ?? null }
          : { ...current, choices: {}, listWidth: null };
      },
    },
  ),
);

export const useSourceBoardChoice = (): SourceBoardChoice => {
  const runtimeKey = getRuntimeKey();
  return useSourceBoardStore((state) => state.choices[runtimeKey] ?? EMPTY_CHOICE);
};
