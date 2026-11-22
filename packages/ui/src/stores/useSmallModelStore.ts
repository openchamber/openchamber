import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeToConfigChanges } from '@/lib/configSync';


export type SmallModelAvailability = 'unknown' | 'available' | 'unavailable';

const MAX_AGE_MS = 60_000;

const toKey = (directory: string | null | undefined): string =>
  `${getRuntimeKey()}::${directory?.trim() || '__global__'}`;

// Bumped by invalidate(): a request that started before an invalidation
// must not write its (by then stale) answer into the cleared cache, and
// its cleanup must not evict a newer request from inFlight (#2163).
let generation = 0;

const inFlight = new Map<string, Promise<void>>();

interface SmallModelStore {
  byKey: Record<string, { availability: SmallModelAvailability; fetchedAt: number }>;
  ensureFresh: (directory?: string | null) => Promise<void>;
  invalidate: () => void;
}

export const useSmallModelStore = create<SmallModelStore>()((set, get) => ({
  byKey: {},

  ensureFresh: async (directory) => {
    const key = toKey(directory);
    const entry = get().byKey[key];
    if (entry && Date.now() - entry.fetchedAt < MAX_AGE_MS) return;
    const pending = inFlight.get(key);
    if (pending) return pending;

    const requestGeneration = generation;
    const request = (async () => {
      try {
        const trimmed = directory?.trim() ?? '';
        const query = trimmed ? `?directory=${encodeURIComponent(trimmed)}` : '';
        const response = await runtimeFetch(`/api/small-model${query}`);
        if (!response.ok) return;
        // SAFETY: `GET /api/small-model` (server `small-model/routes.js`)
        // answers `{ available: boolean, ... }`; only that field is read and
        // anything but a real boolean is treated as "no answer" below.
        const payload = (await response.json().catch(() => null)) as { available?: boolean } | null;
        const available = payload?.available;
        if (available !== true && available !== false) return;
        // Invalidation landed while this request was in flight: the answer
        // describes the pre-invalidation configuration, so it must not
        // repopulate the cache or overwrite a fresher answer.
        if (requestGeneration !== generation) return;
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: { availability: available ? 'available' : 'unavailable', fetchedAt: Date.now() },
          },
        }));
      } catch {
        // Transport failure: keep whatever we knew.
      }
    })();
    inFlight.set(key, request);
    // The request never rejects (its body catches); drop it once settled,
    // unless an invalidation already replaced it.
    void request.finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
    return request;
  },

  invalidate: () => {
    generation += 1;
    inFlight.clear();
    set({ byKey: {} });
  },
}));

export const selectSmallModelAvailability = (
  state: SmallModelStore,
  directory: string | null | undefined,
): SmallModelAvailability => state.byKey[toKey(directory)]?.availability ?? 'unknown';

subscribeToConfigChanges(() => useSmallModelStore.getState().invalidate());
subscribeRuntimeEndpointChanged(() => useSmallModelStore.getState().invalidate());
