import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeToConfigChanges } from '@/lib/configSync';

/**
 * Whether OpenChamber's background model ("small model") can run right now.
 *
 * `GET /api/small-model` answers `available: false` when OpenCode has no model
 * a stateless generation may use — a fresh install on OpenCode's free tier,
 * for instance, has models for chat but none for this. Session renaming, the
 * session goal and the changes walkthrough all depend on it, so the surfaces
 * that start them read this store to show a disabled state with a reason
 * instead of failing after the click.
 *
 * Cached per runtime + directory and refreshed at most once a minute unless
 * something that changes the answer happens: a provider login or a settings
 * save emits a config change, a runtime switch drops everything.
 */

export type SmallModelAvailability = 'unknown' | 'available' | 'unavailable';

const MAX_AGE_MS = 60_000;

const toKey = (directory: string | null | undefined): string =>
  `${getRuntimeKey()}::${directory?.trim() || '__global__'}`;

const inFlight = new Map<string, Promise<void>>();

interface SmallModelStore {
  byKey: Record<string, { availability: SmallModelAvailability; fetchedAt: number }>;
  /** Fetch when unknown or stale; concurrent callers share one request. */
  ensureFresh: (directory?: string | null) => Promise<void>;
  /** Forget every answer; the next reader fetches again. */
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
        // A failed or malformed answer keeps the previous one: an unreachable
        // server is not evidence that the model went away.
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: { availability: available ? 'available' : 'unavailable', fetchedAt: Date.now() },
          },
        }));
      } catch {
        // Transport failure: keep whatever we knew.
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, request);
    return request;
  },

  invalidate: () => {
    inFlight.clear();
    set({ byKey: {} });
  },
}));

export const selectSmallModelAvailability = (
  state: SmallModelStore,
  directory: string | null | undefined,
): SmallModelAvailability => state.byKey[toKey(directory)]?.availability ?? 'unknown';

// Logging into a provider, or changing the Small Model setting, changes the
// answer; a runtime switch points at a different OpenCode entirely.
subscribeToConfigChanges(() => useSmallModelStore.getState().invalidate());
subscribeRuntimeEndpointChanged(() => useSmallModelStore.getState().invalidate());
