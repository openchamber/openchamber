import { create } from 'zustand';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { readRuntimeScopedStorage, writeRuntimeScopedStorage } from './utils/runtimeScopedStorage';

export const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

const readPinned = (storage: Storage, runtimeKey = getRuntimeKey()): Set<string> => {
  try {
    const raw = readRuntimeScopedStorage(storage, SESSION_PINNED_STORAGE_KEY, runtimeKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
};

const persistPinned = (storage: Storage, ids: Set<string>, runtimeKey = getRuntimeKey()): void => {
  try {
    writeRuntimeScopedStorage(storage, SESSION_PINNED_STORAGE_KEY, JSON.stringify([...ids]), runtimeKey);
  } catch {
    // ignore
  }
};

type SessionPinnedStore = {
  ids: Set<string>;
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (sessionId: string) => void;
};

const safeStorage = getDeferredSafeStorage();

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

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) {
      return;
    }
    useSessionPinnedStore.setState({ ids: readPinned(safeStorage, detail.runtimeKey) });
  });
}
