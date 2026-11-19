import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { toDataUrl } from '@/lib/guests/relay-document';

const CACHE_LIMIT = 200;

const RASTER_IMAGE = /^image\/(?:png|jpeg|webp|gif)\b/;

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
      const url = RASTER_IMAGE.test(blob.type) ? URL.createObjectURL(blob) : await toDataUrl(blob);
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
  failed: boolean;
};

export const useRuntimeObjectUrl = (path: string | null, query: string): RuntimeObjectUrl => {
  const key = path ? cacheKey(path, query) : null;
  const [state, setState] = React.useState<RuntimeObjectUrl>(() => ({
    url: key ? cache.get(key)?.url ?? null : null,
    failed: false,
  }));

  React.useEffect(() => {
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
