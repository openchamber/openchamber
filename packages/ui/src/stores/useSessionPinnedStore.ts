import { create } from 'zustand';
import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { getPinnedSessionKey, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';
import { getDeferredSafeStorage } from './utils/safeStorage';

/**
 * The pinned sessions of the current runtime, as keys (`getPinnedSessionKey`).
 * The authority is each session's metadata, which the server shares with every
 * client; this store derives the set from the global session list and overlays
 * two things on it: a pin or unpin the user just clicked, until the server
 * answers, and pins an older version kept on this device only, until they are
 * written to the server (`sync/session-pins.ts`).
 */
type SessionPinnedStore = { ids: Set<string> };

const STORAGE_KEY = 'oc.sessions.pinned.v2';
const LEGACY_STORAGE_KEY = 'oc.sessions.pinned';

type LegacyPin = { key: string; runtimeKey: string; directory: string; sessionId: string };

const storage = getDeferredSafeStorage();

const pinKeySchema = z.tuple([z.string(), z.string(), z.string()]);

const parsePinnedSessionKey = (key: string): LegacyPin | null => {
  try {
    const parsed = pinKeySchema.safeParse(JSON.parse(key));
    if (!parsed.success) return null;
    const [runtimeKey, directory, sessionId] = parsed.data;
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || normalizedDirectory !== directory || !sessionId) return null;
    return { key, runtimeKey, directory: normalizedDirectory, sessionId };
  } catch {
    return null;
  }
};

const legacyStorageSchema = z.object({ version: z.literal(2), sessions: z.record(z.string(), z.number()) });

// Device-local pins of every runtime this client has used, waiting to move
// into session metadata. Malformed storage holds nothing to move.
const readLegacyPins = (): Map<string, LegacyPin> => {
  storage.removeItem(LEGACY_STORAGE_KEY);
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return new Map();
  try {
    const parsed = legacyStorageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return new Map();
    const pins = Object.keys(parsed.data.sessions).flatMap((key) => {
      const pin = parsePinnedSessionKey(key);
      return pin ? [[key, pin] as const] : [];
    });
    return new Map(pins);
  } catch {
    storage.removeItem(STORAGE_KEY);
    return new Map();
  }
};

const legacyPins = readLegacyPins();
const pendingPins = new Map<string, boolean>();
const pinnedBySession = new WeakMap<Session, boolean>();

const isPinnedInMetadata = (session: Session): boolean => {
  const cached = pinnedBySession.get(session);
  if (cached !== undefined) return cached;
  const pinned = isSessionPinnedInMetadata(session);
  pinnedBySession.set(session, pinned);
  return pinned;
};

const derivePinnedIds = (): Set<string> => {
  const runtimeKey = getRuntimeKey();
  const ids = new Set<string>();
  for (const session of useGlobalSessionsStore.getState().activeSessions) {
    if (!session.directory || !isPinnedInMetadata(session)) continue;
    const key = getPinnedSessionKey(runtimeKey, session.directory, session.id);
    if (key) ids.add(key);
  }
  for (const pin of legacyPins.values()) {
    if (pin.runtimeKey === runtimeKey) ids.add(pin.key);
  }
  for (const [key, pinned] of pendingPins) {
    if (pinned) ids.add(key);
    else ids.delete(key);
  }
  return ids;
};

const sameIds = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => (
  left.size === right.size && [...left].every((key) => right.has(key))
);

export const useSessionPinnedStore = create<SessionPinnedStore>(() => ({ ids: derivePinnedIds() }));

const publishPinnedIds = (): void => {
  const next = derivePinnedIds();
  if (!sameIds(next, useSessionPinnedStore.getState().ids)) useSessionPinnedStore.setState({ ids: next });
};

useGlobalSessionsStore.subscribe((state, previous) => {
  if (state.activeSessions !== previous.activeSessions) publishPinnedIds();
});

/** Show a pin or unpin before the server confirms it; `null` drops the overlay. */
export const setPendingPin = (key: string, pinned: boolean | null): void => {
  if (pinned === null) pendingPins.delete(key);
  else pendingPins.set(key, pinned);
  publishPinnedIds();
};

/** This device's old local pins on a runtime, still to be written to the server. */
export const getLegacyPins = (runtimeKey: string): LegacyPin[] => (
  [...legacyPins.values()].filter((pin) => pin.runtimeKey === runtimeKey)
);

/** Drop local pins that reached the server, or whose session is gone. */
export const forgetLegacyPins = (keys: readonly string[]): void => {
  let changed = false;
  for (const key of keys) changed = legacyPins.delete(key) || changed;
  if (!changed) return;
  if (legacyPins.size === 0) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, sessions: Object.fromEntries([...legacyPins.keys()].map((key) => [key, 0])) }));
  publishPinnedIds();
};
