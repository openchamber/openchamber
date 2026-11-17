
import { create } from 'zustand';

import {
  AgentMemoryDisabledError,
  deleteAgentMemory,
  fetchAgentMemory,
  undoAgentMemoryDream,
  updateAgentMemory,
  type AgentMemoryDream,
  type AgentMemoryEntry,
  type AgentMemoryScope,
} from '@/lib/agentMemoryApi';

interface AgentMemoryState {
  global: AgentMemoryEntry[];
  project: AgentMemoryEntry[];
  projectPath: string | null;
  loading: boolean;
  loaded: boolean;
  loadedAt: number | null;
  disabled: boolean;
  globalFailed: boolean;
  projectFailed: boolean;
  dream: AgentMemoryDreams;
  error: string | null;

  load: (projectPath: string | null, options?: { maxAgeMs?: number }) => Promise<void>;
  refresh: () => Promise<void>;
  saveEntry: (
    scope: AgentMemoryScope,
    memoryId: string,
    patch: { title?: string; body?: string },
  ) => Promise<boolean>;
  deleteEntry: (scope: AgentMemoryScope, memoryId: string, projectPath?: string | null) => Promise<boolean>;
  undoDream: (scope: AgentMemoryScope, projectPath: string | null) => Promise<boolean>;
  reset: () => void;
}

type AgentMemoryDreams = { global: AgentMemoryDream | null; project: AgentMemoryDream | null };

const NO_DREAMS: AgentMemoryDreams = { global: null, project: null };

const EMPTY_STATE = {
  global: [] as AgentMemoryEntry[],
  project: [] as AgentMemoryEntry[],
  projectPath: null as string | null,
  loading: false,
  loaded: false,
  disabled: false,
  globalFailed: false,
  projectFailed: false,
  dream: NO_DREAMS,
  error: null as string | null,
  loadedAt: null as number | null,
};

const EMPTY_MEMORY: AgentMemoryEntry[] = [];

export const selectProjectMemoryForPath = (
  state: AgentMemoryState,
  projectPath: string | null,
): AgentMemoryEntry[] => state.projectPath === projectPath ? state.project : EMPTY_MEMORY;

let loadSequence = 0;

let writeChain: Promise<unknown> = Promise.resolve();
const enqueueWrite = <T>(work: () => Promise<T>): Promise<T> => {
  const next = writeChain.then(work, work);
  writeChain = next.catch(() => undefined);
  return next;
};

const listFor = (state: AgentMemoryState, scope: AgentMemoryScope): AgentMemoryEntry[] => (
  scope === 'global' ? state.global : state.project
);

const withList = (
  scope: AgentMemoryScope,
  entries: AgentMemoryEntry[],
): Partial<AgentMemoryState> => (
  scope === 'global' ? { global: entries } : { project: entries }
);

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  ...EMPTY_STATE,

  load: async (projectPath, options) => {
    const previous = get();
    const ownerChanged = previous.projectPath !== projectPath;
    if (
      options?.maxAgeMs !== undefined
      && !ownerChanged
      && previous.loaded
      && previous.loadedAt !== null
      && Date.now() - previous.loadedAt < options.maxAgeMs
    ) {
      return;
    }
    const requestId = ++loadSequence;
    if (ownerChanged) {
      set({ loading: true, projectPath, project: [], projectFailed: false, dream: { ...previous.dream, project: null } });
    } else {
      set({ loading: true, projectPath });
    }
    try {
      const snapshot = await fetchAgentMemory(projectPath);
      if (requestId !== loadSequence) return;
      const current = get();
      set({
        global: snapshot.globalFailed ? current.global : snapshot.global,
        project: snapshot.projectFailed ? current.project : snapshot.project,
        projectPath,
        globalFailed: snapshot.globalFailed,
        projectFailed: snapshot.projectFailed,
        dream: snapshot.dream,
        loading: false,
        loaded: true,
        loadedAt: Date.now(),
        disabled: false,
        error: null,
      });
    } catch (error) {
      if (requestId !== loadSequence) return;
      if (error instanceof AgentMemoryDisabledError) {
        set({ ...EMPTY_STATE, projectPath, disabled: true, loaded: true });
        return;
      }
      set({
        loading: false,
        globalFailed: true,
        projectFailed: true,
        error: errorMessage(error, 'Failed to load agent memory'),
      });
    }
  },

  refresh: async () => {
    await get().load(get().projectPath);
  },

  saveEntry: async (scope, memoryId, patch) => enqueueWrite(async () => {
    const previous = listFor(get(), scope);
    try {
      const saved = await updateAgentMemory(scope, get().projectPath, memoryId, patch);
      set(withList(scope, listFor(get(), scope).map((entry) => (entry.id === memoryId ? saved : entry))));
      return true;
    } catch (error) {
      set({ ...withList(scope, previous), error: errorMessage(error, 'Failed to save memory') });
      return false;
    }
  }),

  deleteEntry: async (scope, memoryId, projectPath = get().projectPath) => enqueueWrite(async () => {
    const ownsList = () => scope === 'global' || get().projectPath === projectPath;
    const previous = listFor(get(), scope);
    if (ownsList()) set(withList(scope, previous.filter((entry) => entry.id !== memoryId)));

    try {
      await deleteAgentMemory(scope, projectPath, memoryId);
      return true;
    } catch (error) {
      if (ownsList()) set(withList(scope, previous));
      set({ error: errorMessage(error, 'Failed to delete memory') });
      return false;
    }
  }),

  undoDream: async (scope, projectPath) => enqueueWrite(async () => {
    try {
      await undoAgentMemoryDream(scope, projectPath);
    } catch (error) {
      set({ error: errorMessage(error, 'Failed to undo the memory tidy-up') });
      return false;
    }
    await get().refresh();
    return true;
  }),

  reset: () => {
    set({ ...EMPTY_STATE });
  },
}));
