import { useEffect, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export function useCallableModelProviders(enabled = true): string[] | undefined {
  const catalog = useConfigStore((state) => state.providers);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const [providerIds, setProviderIds] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = currentDirectory
          ? `/api/small-model?directory=${encodeURIComponent(currentDirectory)}`
          : '/api/small-model';
        const response = await runtimeFetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        // SAFETY: `GET /api/small-model` (server `small-model/routes.js`)
        // answers `{ authenticatedProviders: string[], ... }`; the array check
        // and the string filter below reject anything else.
        const payload = (await response.json().catch(() => null)) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setProviderIds(payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // Transport failure: keep whatever we knew.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog, currentDirectory, enabled]);

  return providerIds;
}
