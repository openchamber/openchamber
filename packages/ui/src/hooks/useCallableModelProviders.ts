import { useEffect, useState } from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/**
 * Provider ids the Small Model and Changes Walkthrough pickers may offer, from
 * `GET /api/small-model`. `undefined` until the server has answered.
 *
 * Asked again whenever the provider catalog changes. A panel that mounts while
 * OpenCode is still starting gets an empty answer, and asking once per mount
 * left a walkthrough panel restored at launch with an empty picker for the
 * whole run. The catalog arriving, a provider login and a runtime switch all
 * replace the catalog, and each can change this answer. A failed request keeps
 * the previous answer. The model list is directory-scoped, so the request
 * names the current directory; without one the picker would answer for
 * OpenCode's own working location, which need not hold the project's models.
 */
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
