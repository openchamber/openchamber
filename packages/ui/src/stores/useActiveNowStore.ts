import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  type ActiveNowEntry,
  addActiveNowSession,
  persistActiveNowEntries,
  pruneActiveNowEntries,
  readActiveNowEntries,
} from '@/components/session/sidebar/activitySections';
import { getSafeStorage } from './utils/safeStorage';

type ActiveNowStore = {
  entries: ActiveNowEntry[];
  setEntries: (entries: ActiveNowEntry[]) => void;
  addSession: (sessionId: string) => void;
  prune: (sessionsById: Map<string, Session>) => void;
};

const safeStorage = getSafeStorage();

export const useActiveNowStore = create<ActiveNowStore>((set, get) => ({
  entries: readActiveNowEntries(safeStorage),
  setEntries: (entries) => {
    if (entries === get().entries) return;
    set({ entries });
    persistActiveNowEntries(safeStorage, entries);
  },
  addSession: (sessionId) => {
    const next = addActiveNowSession(get().entries, sessionId);
    if (next === get().entries) return;
    set({ entries: next });
    persistActiveNowEntries(safeStorage, next);
  },
  prune: (sessionsById) => {
    const current = get().entries;
    const pruned = pruneActiveNowEntries(current, sessionsById);
    if (
      pruned.length === current.length
      && pruned.every((entry, index) => entry.sessionId === current[index]?.sessionId)
    ) {
      return;
    }
    set({ entries: pruned });
    persistActiveNowEntries(safeStorage, pruned);
  },
}));
