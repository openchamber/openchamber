import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { createRuntimeListSnapshot, listRetryDelayMs, sameList } from '@/lib/source-control/providers/runtimeList';
import { trackerDescriptorListSchema, unknownTrackerDescriptor } from './descriptor';
import type { TrackerAPI, TrackerDescriptor } from './types';

type TrackerRegistryStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

interface TrackerRegistryState {
  runtimeKey: string;
  served: readonly TrackerDescriptor[];
  byId: ReadonlyMap<string, TrackerDescriptor>;
  ordered: readonly TrackerDescriptor[];
  status: TrackerRegistryStatus;
  holdsList: boolean;
  refresh: (trackers: Pick<TrackerAPI, 'providers'> | undefined) => Promise<void>;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

const snapshot = createRuntimeListSnapshot('openchamber.trackerProviders.v1', trackerDescriptorListSchema);

const listState = (served: readonly TrackerDescriptor[]) => {
  const sourceControl = useSourceControlProviderRegistry.getState().byId;
  const ordered = served.some((descriptor) => sourceControl.has(descriptor.id))
    ? served.filter((descriptor) => !sourceControl.has(descriptor.id))
    : served;
  return { served, ordered, byId: new Map(ordered.map((descriptor) => [descriptor.id, descriptor])) };
};

const EMPTY_LIST = listState([]);

const rememberedState = (runtimeKey: string) => {
  const remembered = snapshot.read(runtimeKey);
  return remembered
    ? { runtimeKey, ...listState(remembered), status: 'stale' as const, holdsList: true }
    : { runtimeKey, ...EMPTY_LIST, status: 'idle' as const, holdsList: false };
};

let generation = 0;
let inFlight: Promise<void> | null = null;
let followUp: Promise<void> | null = null;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const cancelRetry = (): void => {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
};

export const useTrackerRegistry = create<TrackerRegistryState>((set, get) => {
  const showRuntime = (runtimeKey: string): void => {
    generation += 1;
    inFlight = null;
    followUp = null;
    failures = 0;
    cancelRetry();
    set(rememberedState(runtimeKey));
  };

  return {
    ...rememberedState(getRuntimeKey()),
    refresh: (trackers) => {
      const runtimeKey = getRuntimeKey();
      if (runtimeKey !== get().runtimeKey) showRuntime(runtimeKey);
      if (!trackers) {
        generation += 1;
        inFlight = null;
        followUp = null;
        cancelRetry();
        set({ ...EMPTY_LIST, status: 'ready', holdsList: true });
        return Promise.resolve();
      }
      if (inFlight) {
        if (!followUp) {
          const followUpGeneration = generation;
          const next: Promise<void> = inFlight.then(() => {
            if (followUp === next) followUp = null;
            if (followUpGeneration !== generation) return undefined;
            return get().refresh(trackers);
          });
          followUp = next;
        }
        return followUp;
      }
      cancelRetry();
      const requestGeneration = generation;
      const { holdsList, served: held } = get();
      set({ status: 'loading' });
      const read = async () => {
        try {
          const descriptors = await trackers.providers();
          if (requestGeneration !== generation) return;
          failures = 0;
          snapshot.remember(runtimeKey, descriptors);
          set(holdsList && sameList(held, descriptors)
            ? { status: 'ready' }
            : { ...listState(descriptors), status: 'ready', holdsList: true });
        } catch {
          if (requestGeneration !== generation) return;
          if (holdsList) {
            set({ status: 'stale' });
            return;
          }
          set({ status: 'error' });
          failures += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (requestGeneration === generation) void get().refresh(trackers);
          }, listRetryDelayMs(failures));
        }
      };
      const request = read().finally(() => {
        if (inFlight === request) inFlight = null;
      });
      inFlight = request;
      return request;
    },
    resetForRuntimeSwitch: showRuntime,
  };
});

useSourceControlProviderRegistry.subscribe((next, previous) => {
  if (next.byId === previous.byId) return;
  useTrackerRegistry.setState((state) => {
    const rebuilt = listState(state.served);
    return sameList(rebuilt.ordered, state.ordered) ? state : rebuilt;
  });
});

export const whenTrackerListHeld = (timeoutMs: number): Promise<boolean> => {
  if (useTrackerRegistry.getState().holdsList) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    unsubscribe = useTrackerRegistry.subscribe((state) => {
      if (!state.holdsList) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
};

export const useTrackerDescriptors = (): readonly TrackerDescriptor[] => useTrackerRegistry((state) => state.ordered);

export const useTrackerDescriptor = (id: string | null | undefined): TrackerDescriptor => {
  const descriptor = useTrackerRegistry((state) => (id ? state.byId.get(id) : undefined));
  return descriptor ?? unknownTrackerDescriptor(id ?? '');
};

export const readTrackerDescriptor = (id: string | null | undefined): TrackerDescriptor => (
  (id ? useTrackerRegistry.getState().byId.get(id) : undefined) ?? unknownTrackerDescriptor(id ?? '')
);
