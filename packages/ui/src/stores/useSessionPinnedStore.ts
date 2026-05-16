import { create } from 'zustand';
import { getSafeStorage } from './utils/safeStorage';

const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

const readPinned = (storage: Storage): Set<string> => {
  try {
    const raw = storage.getItem(SESSION_PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
};

const persistPinned = (storage: Storage, ids: Set<string>): void => {
  try {
    storage.setItem(SESSION_PINNED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
};

type SessionPinnedStore = {
  ids: Set<string>;
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (sessionId: string) => void;
};

const safeStorage = getSafeStorage();

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => ({
  ids: readPinned(safeStorage),
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved === current) return;
    set({ ids: resolved });
    persistPinned(safeStorage, resolved);
  },
  toggle: (sessionId) => {
    const current = get().ids;
    const next = new Set(current);
    if (next.has(sessionId)) {
      next.delete(sessionId);
    } else {
      next.add(sessionId);
    }
    set({ ids: next });
    persistPinned(safeStorage, next);
  },
}));
