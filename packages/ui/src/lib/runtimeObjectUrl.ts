import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

/**
 * Object URLs for small images an OpenChamber route serves (project icons,
 * uploaded provider logos). Fetched through `runtimeFetch`, so they carry the
 * runtime's auth and work over the relay; keyed by runtime, path and query, so
 * a versioned query (`v=<updatedAt>`) is fetched once per runtime.
 */
const CACHE_LIMIT = 200;

type CacheEntry = {
  url?: string;
  promise?: Promise<string | null>;
};

const cache = new Map<string, CacheEntry>();

const cacheKey = (path: string, query: string): string => [getRuntimeApiBaseUrl() || 'same-origin', path, query].join('|');

const trimCache = (): void => {
  while (cache.size > CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (typeof firstKey !== 'string') return;
    const entry = cache.get(firstKey);
    if (entry?.url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(entry.url);
    }
    cache.delete(firstKey);
  }
};

const loadObjectUrl = (key: string, path: string, query: string): Promise<string | null> => {
  const cached = cache.get(key);
  if (cached?.url) return Promise.resolve(cached.url);
  if (cached?.promise) return cached.promise;

  const promise = runtimeFetch(path, {
    method: 'GET',
    headers: { Accept: 'image/*' },
    query: new URLSearchParams(query),
  })
    .then(async (response) => {
      if (!response.ok) return null;
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      cache.set(key, { url });
      trimCache();
      return url;
    })
    .catch(() => null)
    .finally(() => {
      const entry = cache.get(key);
      if (entry?.promise === promise && !entry.url) {
        cache.delete(key);
      }
    });

  cache.set(key, { promise });
  return promise;
};

export type RuntimeObjectUrl = {
  url: string | null;
  /** The last fetch for this path and query failed; `url` stays null until they change. */
  failed: boolean;
};

/** The object URL for `path?query`, or nothing while `path` is null. */
export const useRuntimeObjectUrl = (path: string | null, query: string): RuntimeObjectUrl => {
  const key = path ? cacheKey(path, query) : null;
  const [state, setState] = React.useState<RuntimeObjectUrl>(() => ({
    url: key ? cache.get(key)?.url ?? null : null,
    failed: false,
  }));

  React.useEffect(() => {
    // Keeps the same state object when nothing changes, so a mount renders once.
    const settle = (url: string | null, failed: boolean) => setState((previous) => (
      previous.url === url && previous.failed === failed ? previous : { url, failed }
    ));
    if (!key || !path) {
      settle(null, false);
      return;
    }

    const cached = cache.get(key)?.url;
    if (cached) {
      settle(cached, false);
      return;
    }

    let cancelled = false;
    settle(null, false);
    void loadObjectUrl(key, path, query).then((url) => {
      if (!cancelled) settle(url, url === null);
    });

    return () => {
      cancelled = true;
    };
  }, [key, path, query]);

  return state;
};
