import React from 'react';

type GitmojiEntry = {
  emoji: string;
  code: string;
  description: string;
};

type GitmojiCachePayload = {
  gitmojis: GitmojiEntry[];
  fetchedAt: number;
  version: string;
};

const GITMOJI_CACHE_KEY = 'gitmojiCache';
const GITMOJI_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const GITMOJI_CACHE_VERSION = '1';
const GITMOJI_SOURCE_URL =
  'https://raw.githubusercontent.com/carloscuesta/gitmoji/master/packages/gitmojis/src/gitmojis.json';

const isGitmojiEntry = (value: unknown): value is GitmojiEntry => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.emoji === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.description === 'string'
  );
};

const readGitmojiCache = (): GitmojiCachePayload | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(GITMOJI_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GitmojiCachePayload>;
    if (!parsed || parsed.version !== GITMOJI_CACHE_VERSION || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    if (!Array.isArray(parsed.gitmojis)) return null;
    const gitmojis = parsed.gitmojis.filter(isGitmojiEntry);
    return { gitmojis, fetchedAt: parsed.fetchedAt, version: parsed.version };
  } catch {
    return null;
  }
};

const writeGitmojiCache = (gitmojis: GitmojiEntry[]) => {
  if (typeof window === 'undefined') return;
  try {
    const payload: GitmojiCachePayload = {
      gitmojis,
      fetchedAt: Date.now(),
      version: GITMOJI_CACHE_VERSION,
    };
    window.localStorage.setItem(GITMOJI_CACHE_KEY, JSON.stringify(payload));
  } catch {
    return;
  }
};

const isGitmojiCacheFresh = (payload: GitmojiCachePayload): boolean =>
  Date.now() - payload.fetchedAt < GITMOJI_CACHE_TTL_MS;

// Module-level inflight + subscribers so concurrent hook instances dedupe the
// same fetch. Subscribers receive the resolved list via setState on each hook
// instance, so every consumer converges on the same data.
let inflightFetch: Promise<GitmojiEntry[]> | null = null;
const subscribers = new Set<(entries: GitmojiEntry[]) => void>();

const fetchGitmojiList = async (): Promise<GitmojiEntry[]> => {
  if (inflightFetch) return inflightFetch;

  const promise = (async () => {
    try {
      const response = await fetch(GITMOJI_SOURCE_URL);
      if (!response.ok) {
        throw new Error(`Failed to load gitmojis: ${response.statusText}`);
      }
      const payload = (await response.json()) as { gitmojis?: GitmojiEntry[] };
      const gitmojis = Array.isArray(payload.gitmojis)
        ? payload.gitmojis.filter(isGitmojiEntry)
        : [];
      writeGitmojiCache(gitmojis);
      subscribers.forEach((callback) => callback(gitmojis));
      return gitmojis;
    } catch (error) {
      console.warn('Failed to load gitmoji list:', error);
      const empty: GitmojiEntry[] = [];
      subscribers.forEach((callback) => callback(empty));
      return empty;
    } finally {
      inflightFetch = null;
    }
  })();

  inflightFetch = promise;
  return promise;
};

export type UseGitmojiListResult = {
  gitmojis: GitmojiEntry[];
  isLoading: boolean;
  ensureLoaded: () => Promise<GitmojiEntry[]>;
};

/**
 * Returns the gitmoji emoji catalog, hydrated from a local cache and
 * stale-while-revalidated from the upstream JSON.
 *
 * - When `enabled` is false, the hook returns an empty list and skips all IO.
 * - The first call hydrates synchronously from localStorage (no network
 *   round-trip on warm starts).
 * - If the cache is missing or stale, a single background fetch is fired and
 *   deduped across concurrent hook instances.
 * - Callers can invoke `ensureLoaded()` to await the next settled value when
 *   they need the list synchronously (e.g. auto-suggest on commit subject).
 */
export const useGitmojiList = (enabled: boolean): UseGitmojiListResult => {
  const [gitmojis, setGitmojis] = React.useState<GitmojiEntry[]>(() => {
    if (!enabled) return [];
    return readGitmojiCache()?.gitmojis ?? [];
  });
  const [isLoading, setIsLoading] = React.useState(false);
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  React.useEffect(() => {
    if (!enabled) {
      subscribers.delete(setGitmojis);
      setGitmojis([]);
      setIsLoading(false);
      return;
    }

    const cached = readGitmojiCache();
    if (cached) {
      setGitmojis(cached.gitmojis);
      if (isGitmojiCacheFresh(cached)) {
        return;
      }
    }

    subscribers.add(setGitmojis);
    setIsLoading(true);
    let cancelled = false;
    void fetchGitmojiList().finally(() => {
      if (!cancelled && enabledRef.current) {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
      subscribers.delete(setGitmojis);
    };
  }, [enabled]);

  const ensureLoaded = React.useCallback(async (): Promise<GitmojiEntry[]> => {
    if (!enabledRef.current) return [];
    if (gitmojis.length > 0) return gitmojis;
    const cached = readGitmojiCache();
    if (cached && isGitmojiCacheFresh(cached)) {
      return cached.gitmojis;
    }
    return fetchGitmojiList();
  }, [gitmojis]);

  return { gitmojis, isLoading, ensureLoaded };
};
