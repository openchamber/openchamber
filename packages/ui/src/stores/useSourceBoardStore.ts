import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import type { GitHubReferenceKind } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const SOURCE_BOARD_STORAGE_KEY = 'openchamber.source-board';

/** The repository's own host (GitHub or GitLab), or Linear. */
export type SourceBoardTab = 'repository' | 'linear';

type SourceBoardChoice = {
  /** The project whose repository the board lists; independent of the app's selected project. */
  projectId: string | null;
  tab: SourceBoardTab;
  /** Null lists every team. */
  linearTeamId: string | null;
};

const EMPTY_CHOICE: SourceBoardChoice = { projectId: null, tab: 'repository', linearTeamId: null };

type SourceBoardState = {
  /** Keyed by runtime: project and team ids belong to one server. */
  choices: Record<string, SourceBoardChoice>;
  /** A Linear issue another surface asked the board to show; taken once. */
  linearFocus: string | null;
  update: (patch: Partial<SourceBoardChoice>) => void;
  /** Switches to Linear and previews the issue `identifier` names; the caller opens the board. */
  focusLinearIssue: (identifier: string) => void;
  clearLinearFocus: () => void;
  /** An issue or PR another surface asked the board to show: its tab and its link; taken once. */
  repositoryFocus: { kind: GitHubReferenceKind; query: string } | null;
  /** Switches to `projectId`'s repository tab and previews the item the link `query` names; the caller opens the board. */
  focusRepositoryItem: (projectId: string, kind: GitHubReferenceKind, query: string) => void;
  clearRepositoryFocus: () => void;
  /** The list column's width in pixels; null until the user drags it. Not per runtime: it is about the screen. */
  listWidth: number | null;
  setListWidth: (width: number) => void;
};

const persistedChoices = z.object({
  choices: z.record(z.string(), z.object({
    projectId: z.string().nullable().catch(null),
    tab: z.enum(['repository', 'linear']).catch('repository'),
    linearTeamId: z.string().nullable().catch(null),
  })).catch({}),
  listWidth: z.number().positive().nullable().catch(null).optional(),
});

/**
 * What the board was last left on, so it reopens there. Changing it never
 * touches the project the rest of the app has selected.
 */
export const useSourceBoardStore = create<SourceBoardState>()(
  persist(
    (set, get) => ({
      choices: {},
      linearFocus: null,
      update: (patch) => set((state) => {
        const runtimeKey = getRuntimeKey();
        return { choices: { ...state.choices, [runtimeKey]: { ...(state.choices[runtimeKey] ?? EMPTY_CHOICE), ...patch } } };
      }),
      focusLinearIssue: (identifier) => {
        get().update({ tab: 'linear', linearTeamId: null });
        set({ linearFocus: identifier });
      },
      clearLinearFocus: () => set({ linearFocus: null }),
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
