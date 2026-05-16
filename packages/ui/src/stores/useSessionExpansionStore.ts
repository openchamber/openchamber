import { create } from 'zustand';
import { getSafeStorage } from './utils/safeStorage';

const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v2';
const LEGACY_SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents';

const readExpanded = (storage: Storage): Set<string> => {
  try {
    const raw = storage.getItem(SESSION_EXPANDED_STORAGE_KEY);
    if (!raw) {
      try {
        storage.removeItem(LEGACY_SESSION_EXPANDED_STORAGE_KEY);
      } catch {
        // ignore
      }
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
};

const persistExpanded = (storage: Storage, keys: Set<string>): void => {
  try {
    storage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // ignore
  }
};

type SessionExpansionStore = {
  keys: Set<string>;
  toggle: (key: string) => void;
  collapseMany: (keys: string[]) => void;
};

const safeStorage = getSafeStorage();

export const useSessionExpansionStore = create<SessionExpansionStore>((set, get) => ({
  keys: readExpanded(safeStorage),
  toggle: (key) => {
    const current = get().keys;
    const next = new Set(current);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ keys: next });
    persistExpanded(safeStorage, next);
  },
  collapseMany: (collapseKeys) => {
    if (collapseKeys.length === 0) {
      return;
    }
    const collapseSet = new Set(collapseKeys);
    const current = get().keys;
    let changed = false;
    const next = new Set<string>();
    current.forEach((key) => {
      if (collapseSet.has(key)) {
        changed = true;
        return;
      }
      next.add(key);
    });
    if (!changed) {
      return;
    }
    set({ keys: next });
    persistExpanded(safeStorage, next);
  },
}));

export const useIsSessionExpanded = (key: string): boolean =>
  useSessionExpansionStore((state) => state.keys.has(key));
