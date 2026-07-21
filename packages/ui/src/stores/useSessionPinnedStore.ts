import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from './utils/safeStorage';

const STORAGE_KEY = 'oc.sessions.pinned.v2';
const LEGACY_STORAGE_KEY = 'oc.sessions.pinned';

export type SessionPinnedTarget = { directory: string; sessionId: string };

type PersistedPins = { version: 2; sessions: Record<string, number> };

type PinnedSessionState = {
  ids: Set<string>;
  touchedAt: Record<string, number>;
};

type SessionPinnedStore = PinnedSessionState & {
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (target: SessionPinnedTarget) => void;
  clearPinnedSession: (runtimeKey: string, directory: string, sessionId: string) => void;
};

const storage = getDeferredSafeStorage();

export const getPinnedSessionKey = (runtimeKey: string, directory: string, sessionId: string): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
  return JSON.stringify([runtimeKey, normalizedDirectory, sessionId]);
};

const parsePinnedSessionKey = (key: string): [string, string, string] | null => {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [runtimeKey, directory, sessionId] = parsed;
    if (typeof runtimeKey !== 'string' || typeof directory !== 'string' || typeof sessionId !== 'string') return null;
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || normalizedDirectory !== directory || !sessionId) return null;
    return [runtimeKey, normalizedDirectory, sessionId];
  } catch {
    return null;
  }
};

export const isSessionPinned = (ids: Set<string>, directory: string | null | undefined, sessionId: string): boolean => {
  if (!directory) return false;
  const key = getPinnedSessionKey(getRuntimeKey(), directory, sessionId);
  return key ? ids.has(key) : false;
};

const readPinned = (): PinnedSessionState => {
  storage.removeItem(LEGACY_STORAGE_KEY);
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return { ids: new Set(), touchedAt: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPins>;
    if (parsed.version !== 2 || !parsed.sessions || typeof parsed.sessions !== 'object') return { ids: new Set(), touchedAt: {} };
    const entries = Object.entries(parsed.sessions)
      .filter(([key, touchedAt]) => parsePinnedSessionKey(key) && typeof touchedAt === 'number' && Number.isFinite(touchedAt))
      .sort((left, right) => right[1] - left[1]);
    return { ids: new Set(entries.map(([key]) => key)), touchedAt: Object.fromEntries(entries) };
  } catch {
    storage.removeItem(STORAGE_KEY);
    return { ids: new Set(), touchedAt: {} };
  }
};

const boundPinnedState = (ids: Set<string>, touchedAt: Record<string, number>): PinnedSessionState => {
  const entries = [...ids]
    .filter((key) => parsePinnedSessionKey(key) !== null)
    .map((key) => [key, touchedAt[key] ?? Date.now()] as const)
    .sort((left, right) => right[1] - left[1]);
  return {
    ids: new Set(entries.map(([key]) => key)),
    touchedAt: Object.fromEntries(entries),
  };
};

const persistPinned = ({ ids, touchedAt }: PinnedSessionState): void => {
  const sessions = Object.fromEntries([...ids].map((key) => [key, touchedAt[key] ?? Date.now()]));
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, sessions }));
};

const initial = readPinned();

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => ({
  ids: initial.ids,
  touchedAt: initial.touchedAt,
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved === current) return;
    const pinnedState = boundPinnedState(resolved, get().touchedAt);
    set(pinnedState);
    persistPinned(pinnedState);
  },
  toggle: (target) => {
    const key = getPinnedSessionKey(getRuntimeKey(), target.directory, target.sessionId);
    if (!key) return;
    const ids = new Set(get().ids);
    const touchedAt = { ...get().touchedAt };
    if (ids.has(key)) {
      ids.delete(key);
      delete touchedAt[key];
    } else {
      ids.add(key);
      touchedAt[key] = Date.now();
    }
    const pinnedState = boundPinnedState(ids, touchedAt);
    set(pinnedState);
    persistPinned(pinnedState);
  },
  clearPinnedSession: (runtimeKey, directory, sessionId) => {
    const key = getPinnedSessionKey(runtimeKey, directory, sessionId);
    if (!key || !get().ids.has(key)) return;
    const ids = new Set(get().ids);
    ids.delete(key);
    get().setIds(ids);
  },
}));
