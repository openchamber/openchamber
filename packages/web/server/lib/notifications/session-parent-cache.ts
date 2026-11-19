export interface SessionParentCache {
  get: (sessionId: string, directory: string | undefined, spaceId: string | null) => string | null | undefined;
  set: (sessionId: string, directory: string | undefined, spaceId: string | null, parentID: string | null) => void;
  getForHost: (sessionId: string) => string | null | undefined;
}

interface CacheEntry {
  parentID: string | null;
  at: number;
}

const keyOf = (sessionId: string, directory: string | undefined, spaceId: string | null) => `${spaceId || ''}\0${directory || ''}\0${sessionId}`;

export const createSessionParentCache = (ttlMs = 60_000): SessionParentCache => {
  const entries = new Map<string, CacheEntry>();
  const live = (key: string): CacheEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    get: (sessionId, directory, spaceId) => live(keyOf(sessionId, directory, spaceId))?.parentID,
    set: (sessionId, directory, spaceId, parentID) => {
      entries.set(keyOf(sessionId, directory, spaceId), { parentID: parentID ?? null, at: Date.now() });
    },
    getForHost: (sessionId) => {
      const suffix = `\0${sessionId}`;
      for (const key of [...entries.keys()]) {
        if (!key.startsWith('\0') || !key.endsWith(suffix)) continue;
        const entry = live(key);
        if (entry) return entry.parentID;
      }
      return undefined;
    },
  };
};
