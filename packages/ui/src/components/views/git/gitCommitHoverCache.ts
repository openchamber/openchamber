import type {
  GitCommitHoverDetailsCache,
  GitCommitHoverDetailsKey,
  GitCommitHoverDetailsSnapshot,
  GitHubCommitDetails,
} from '@/lib/api/types';

type CacheEntry = {
  key: GitCommitHoverDetailsKey;
  snapshot: GitCommitHoverDetailsSnapshot;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  negativeExpiresAt: number | null;
};

const DEFAULT_MAX_POSITIVE_ENTRIES = 200;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;
const IDLE_DETAILS_SNAPSHOT: GitCommitHoverDetailsSnapshot = Object.freeze({ status: 'idle' });

export type RuntimeImageConstructor = new () => {
  onload: null | ((event: Event) => void) | (() => void);
  onerror: null | ((event: Event) => void) | (() => void);
  src: string;
};

export const preloadGitCommitHoverImage = (
  url: string,
  ImageConstructor: RuntimeImageConstructor | undefined = globalThis.Image,
): Promise<boolean> => new Promise<boolean>((resolve) => {
  if (!ImageConstructor) {
    resolve(false);
    return;
  }
  const image = new ImageConstructor();
  image.onload = () => resolve(true);
  image.onerror = () => resolve(false);
  image.src = url;
});

const toCacheKey = (key: GitCommitHoverDetailsKey): string => JSON.stringify([key.directory, key.remoteName, key.hash]);

const cloneDetailsWithoutAvatar = (details: GitHubCommitDetails): GitHubCommitDetails => {
  if (!details.author?.avatarUrl) {
    return details;
  }

  return {
    ...details,
    author: {
      ...details.author,
      avatarUrl: undefined,
    },
  };
};

export function createGitCommitHoverDetailsCache(options: {
  load: (key: GitCommitHoverDetailsKey) => Promise<GitHubCommitDetails>;
  preloadImage: (url: string) => Promise<boolean>;
  now?: () => number;
  maxPositiveEntries?: number;
  negativeTtlMs?: number;
}): GitCommitHoverDetailsCache {
  const entries = new Map<string, CacheEntry>();
  const now = options.now ?? Date.now;
  const maxPositiveEntries = options.maxPositiveEntries ?? DEFAULT_MAX_POSITIVE_ENTRIES;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  let disposed = false;

  const notify = (entry: CacheEntry) => {
    for (const listener of entry.listeners) {
      listener();
    }
  };

  const getOrCreateEntry = (key: GitCommitHoverDetailsKey): CacheEntry => {
    const cacheKey = toCacheKey(key);
    const existing = entries.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created: CacheEntry = {
      key,
      snapshot: IDLE_DETAILS_SNAPSHOT,
      listeners: new Set(),
      inFlight: null,
      negativeExpiresAt: null,
    };
    entries.set(cacheKey, created);
    return created;
  };

  const trimPositiveEntries = () => {
    let readyCount = 0;
    for (const entry of entries.values()) {
      if (entry.snapshot.status === 'ready') {
        readyCount += 1;
      }
    }

    if (readyCount <= maxPositiveEntries) {
      return;
    }

    for (const [cacheKey, entry] of entries) {
      if (readyCount <= maxPositiveEntries) {
        break;
      }
      if (entry.snapshot.status !== 'ready') {
        continue;
      }
      if (entry.listeners.size > 0 || entry.inFlight) {
        continue;
      }
      entries.delete(cacheKey);
      readyCount -= 1;
    }
  };

  const publishReady = (entry: CacheEntry, details: GitHubCommitDetails) => {
    if (disposed) {
      return;
    }

    entry.snapshot = { status: 'ready', details };
    entry.negativeExpiresAt = null;
    const cacheKey = toCacheKey(entry.key);
    entries.delete(cacheKey);
    entries.set(cacheKey, entry);
    notify(entry);
    trimPositiveEntries();
  };

  const publishUnavailable = (entry: CacheEntry) => {
    if (disposed) {
      return;
    }

    entry.snapshot = { status: 'unavailable' };
    entry.negativeExpiresAt = now() + negativeTtlMs;
    notify(entry);
  };

  const isUnavailableExpired = (entry: CacheEntry): boolean => (
    entry.snapshot.status === 'unavailable'
    && entry.negativeExpiresAt !== null
    && entry.negativeExpiresAt <= now()
  );

  return {
    preload(key) {
      if (disposed) {
        return Promise.resolve();
      }

      const entry = getOrCreateEntry(key);
      if (entry.snapshot.status === 'ready') {
        return Promise.resolve();
      }
      if (entry.snapshot.status === 'unavailable' && !isUnavailableExpired(entry)) {
        return Promise.resolve();
      }
      if (entry.inFlight) {
        return entry.inFlight;
      }

      entry.snapshot = { status: 'loading' };
      entry.negativeExpiresAt = null;
      notify(entry);

      const task = (async () => {
        try {
          const loaded = await options.load(key);
          let details = loaded;
          const avatarUrl = loaded.author?.avatarUrl?.trim();
          if (avatarUrl) {
            const imageReady = await options.preloadImage(avatarUrl);
            if (!imageReady) {
              details = cloneDetailsWithoutAvatar(loaded);
            }
          }
          publishReady(entry, details);
        } catch {
          publishUnavailable(entry);
        } finally {
          entry.inFlight = null;
        }
      })();

      entry.inFlight = task;
      return task;
    },

    getSnapshot(key) {
      if (disposed) {
        return IDLE_DETAILS_SNAPSHOT;
      }

      const entry = entries.get(toCacheKey(key));
      if (!entry) {
        return IDLE_DETAILS_SNAPSHOT;
      }
      if (isUnavailableExpired(entry)) {
        entry.snapshot = IDLE_DETAILS_SNAPSHOT;
        entry.negativeExpiresAt = null;
      }
      return entry.snapshot;
    },

    subscribe(key, listener) {
      if (disposed) {
        return () => {};
      }

      const entry = getOrCreateEntry(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}
