import { create } from 'zustand';
import type { TrackerAPI, TrackerAuthStatus, TrackerProviderId } from '@/lib/api/types';
import { useTrackerRegistry } from '@/lib/trackers/registry';

type TrackerAuthStatusWithError = TrackerAuthStatus & { error?: string };

type TrackerAuthEntry = {
  status: TrackerAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
};

type TrackerAuthStore = {
  entries: Readonly<Record<TrackerProviderId, TrackerAuthEntry>>;
  setStatus: (provider: TrackerProviderId, status: TrackerAuthStatusWithError | null) => void;
  refreshStatus: (
    trackers: TrackerAPI | undefined,
    provider: TrackerProviderId,
    options?: { force?: boolean },
  ) => Promise<TrackerAuthStatusWithError | null>;
  refreshAll: (
    trackers: TrackerAPI | undefined,
    providers: readonly TrackerProviderId[],
    options?: { force?: boolean },
  ) => Promise<void>;
  resetForRuntimeSwitch: () => void;
};

const EMPTY_ENTRY: TrackerAuthEntry = { status: null, isLoading: false, hasChecked: false };

const inFlight = new Map<TrackerProviderId, Promise<TrackerAuthStatusWithError | null>>();
let authGeneration = 0;

export const useTrackerAuthStore = create<TrackerAuthStore>((set, get) => {
  const patch = (provider: TrackerProviderId, next: Partial<TrackerAuthEntry>) => set((state) => ({
    entries: { ...state.entries, [provider]: { ...(state.entries[provider] ?? EMPTY_ENTRY), ...next } },
  }));

  return {
    entries: {},
    setStatus: (provider, status) => patch(provider, { status, hasChecked: true }),
    refreshStatus: async (trackers, provider, options) => {
      const current = get().entries[provider] ?? EMPTY_ENTRY;
      if (!trackers) return current.status;
      if (current.hasChecked && !options?.force) return current.status;
      const pending = inFlight.get(provider);
      if (pending) return pending;

      const generation = authGeneration;
      patch(provider, { isLoading: true });
      const request = (async () => {
        try {
          const status = await trackers.authStatus(provider);
          if (generation !== authGeneration) return null;
          patch(provider, { status, isLoading: false, hasChecked: true });
          return status;
        } catch (error) {
          if (generation !== authGeneration) return null;
          const message = error instanceof Error ? error.message : String(error);
          const previous = get().entries[provider]?.status ?? null;
          patch(provider, {
            status: previous ? { ...previous, error: message } : { connected: false, error: message },
            isLoading: false,
          });
          return null;
        }
      })().finally(() => {
        if (inFlight.get(provider) === request) inFlight.delete(provider);
      });
      inFlight.set(provider, request);
      return request;
    },
    refreshAll: async (trackers, providers, options) => {
      const { refreshStatus } = get();
      await Promise.all(providers.map((provider) => refreshStatus(trackers, provider, options)));
    },
    resetForRuntimeSwitch: () => {
      authGeneration += 1;
      inFlight.clear();
      set({ entries: {} });
    },
  };
});

export const useTrackerAuthEntry = (provider: TrackerProviderId | null | undefined): TrackerAuthEntry => (
  useTrackerAuthStore((state) => (provider ? state.entries[provider] : undefined) ?? EMPTY_ENTRY)
);

export const isTrackerConnected = (entry: TrackerAuthEntry | undefined): boolean => entry?.status?.connected === true;

export const currentTrackerAccountId = (entry: TrackerAuthEntry | undefined): string => {
  const status = entry?.status;
  return status?.connected ? status.account?.id ?? '' : '';
};

export async function refreshTrackers(trackers: TrackerAPI | undefined): Promise<void> {
  const registry = useTrackerRegistry.getState();
  await registry.refresh(trackers);
  const providers = useTrackerRegistry.getState().ordered.map((descriptor) => descriptor.id);
  await useTrackerAuthStore.getState().refreshAll(trackers, providers, { force: true });
}
