/**
 * Agent memory, as the panel and the send path see it.
 *
 * The server owns the store; this holds the last snapshot read from it and
 * serializes writes so two quick edits cannot land out of order.
 *
 * A failed load never blanks what is already held. An empty list would read as
 * "the agent has forgotten everything", which is the one wrong answer here: the
 * user would go looking for lost memory that is sitting safely on disk.
 */

import { create } from 'zustand';

import {
  AgentMemoryDisabledError,
  deleteAgentMemory,
  fetchAgentMemory,
  updateAgentMemory,
  type AgentMemoryEntry,
  type AgentMemoryScope,
} from '@/lib/agentMemoryApi';

interface AgentMemoryState {
  global: AgentMemoryEntry[];
  project: AgentMemoryEntry[];
  /** The project path the held `project` entries belong to. */
  projectPath: string | null;
  loading: boolean;
  loaded: boolean;
  /** When the held entries were last read successfully. */
  loadedAt: number | null;
  /** True once the server has reported the feature switched off. */
  disabled: boolean;
  globalFailed: boolean;
  projectFailed: boolean;
  error: string | null;

  /**
   * `maxAgeMs` skips the read when the same project's entries were loaded
   * more recently than that; omit it for an unconditional re-read.
   */
  load: (projectPath: string | null, options?: { maxAgeMs?: number }) => Promise<void>;
  /** Re-read the store the last load used. */
  refresh: () => Promise<void>;
  saveEntry: (
    scope: AgentMemoryScope,
    memoryId: string,
    patch: { title?: string; body?: string },
  ) => Promise<boolean>;
  deleteEntry: (scope: AgentMemoryScope, memoryId: string) => Promise<boolean>;
  reset: () => void;
}

const EMPTY_STATE = {
  global: [] as AgentMemoryEntry[],
  project: [] as AgentMemoryEntry[],
  projectPath: null as string | null,
  loading: false,
  loaded: false,
  disabled: false,
  globalFailed: false,
  projectFailed: false,
  error: null as string | null,
  loadedAt: null as number | null,
};

const EMPTY_MEMORY: AgentMemoryEntry[] = [];

/** Never expose one owner's project entries under another owner's heading. */
export const selectProjectMemoryForPath = (
  state: AgentMemoryState,
  projectPath: string | null,
): AgentMemoryEntry[] => state.projectPath === projectPath ? state.project : EMPTY_MEMORY;

/**
 * Only the newest load may write to the store. Turning the feature back on
 * fires a load before the setting has finished being written, so an older
 * "disabled" answer can arrive after a newer successful one and latch the
 * feature off again.
 */
let loadSequence = 0;

/** Serializes writes so a slow first request cannot overwrite a later one. */
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
      set({ loading: true, projectPath, project: [], projectFailed: false });
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
        loading: false,
        loaded: true,
        loadedAt: Date.now(),
        disabled: false,
        error: null,
      });
    } catch (error) {
      if (requestId !== loadSequence) return;
      if (error instanceof AgentMemoryDisabledError) {
        // Switched off is not a failure. Clearing the lists is right here and
        // only here: with the feature off there is nothing for the user to act
        // on, and the tab that would show them is gone too. The path is kept so
        // a later refresh knows which store to re-read.
        set({ ...EMPTY_STATE, projectPath, disabled: true, loaded: true });
        return;
      }
      // Whatever was loaded before stays. Only the error is new.
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

  deleteEntry: async (scope, memoryId) => enqueueWrite(async () => {
    const previous = listFor(get(), scope);
    set(withList(scope, previous.filter((entry) => entry.id !== memoryId)));

    try {
      await deleteAgentMemory(scope, get().projectPath, memoryId);
      return true;
    } catch (error) {
      set({ ...withList(scope, previous), error: errorMessage(error, 'Failed to delete memory') });
      return false;
    }
  }),

  reset: () => {
    set({ ...EMPTY_STATE });
  },
}));
