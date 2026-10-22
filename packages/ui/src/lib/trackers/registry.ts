import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { createRuntimeListSnapshot, listRetryDelayMs, sameList } from '@/lib/source-control/providers/runtimeList';
import { trackerDescriptorListSchema, unknownTrackerDescriptor } from './descriptor';
import type { TrackerAPI, TrackerDescriptor } from './types';

/**
 * The work-item trackers of the connected server, read from
 * `TrackerAPI.providers()`. Mirrors the source-control provider registry
 * (`lib/source-control/providers/registry.ts`):
 *
 * - `idle`: nothing remembered and nothing asked yet.
 * - `stale`: a list remembered from an earlier visit to this runtime, or the
 *   last list after a failed refresh. It stays until the server answers.
 * - `loading`: a refresh is in flight; whatever list is held stays shown.
 * - `ready`: the server's own answer for this runtime, possibly empty. A
 *   runtime without trackers (VS Code) is ready and empty.
 * - `error`: a refresh failed and there is no list to show. It is retried
 *   with a growing wait until the server answers or the runtime changes.
 *
 * A failed refresh never replaces a held list with an empty one.
 */
type TrackerRegistryStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

interface TrackerRegistryState {
  runtimeKey: string;
  /** The list as served or remembered, before ids owned by source control are left out. */
  served: readonly TrackerDescriptor[];
  byId: ReadonlyMap<string, TrackerDescriptor>;
  ordered: readonly TrackerDescriptor[];
  status: TrackerRegistryStatus;
  /** A list is held: remembered for this runtime or answered by its server (an empty answer too). */
  holdsList: boolean;
  /**
   * Asks the server of the current runtime again; concurrent calls share one
   * request. A runtime other than the held one first shows that runtime's
   * remembered list. No API means no trackers.
   */
  refresh: (trackers: Pick<TrackerAPI, 'providers'> | undefined) => Promise<void>;
  /** Forgets the previous runtime's list and shows what is remembered for the next one. */
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

const snapshot = createRuntimeListSnapshot('openchamber.trackerProviders.v1', trackerDescriptorListSchema);

/**
 * The trackers to show: the served list without any id the source-control
 * registry holds. Both families key by `provider` in one namespace and the id
 * belongs to source control, which the server enforces too.
 */
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
    failures = 0;
    cancelRetry();
    set(rememberedState(runtimeKey));
  };

  return {
    ...rememberedState(getRuntimeKey()),
    refresh: (trackers) => {
      // Read now, not at import: the store may be created before the runtime
      // endpoint is initialized, when the key is still a transient one.
      const runtimeKey = getRuntimeKey();
      if (runtimeKey !== get().runtimeKey) showRuntime(runtimeKey);
      if (!trackers) {
        // Authoritative: this runtime has no trackers. A request still out loses.
        generation += 1;
        inFlight = null;
        cancelRetry();
        set({ ...EMPTY_LIST, status: 'ready', holdsList: true });
        return Promise.resolve();
      }
      if (inFlight) return inFlight;
      cancelRetry();
      const requestGeneration = generation;
      // A remembered or answered list (even an empty answer) survives a failed refresh.
      const { holdsList, served: held } = get();
      set({ status: 'loading' });
      const read = async () => {
        try {
          const descriptors = await trackers.providers();
          if (requestGeneration !== generation) return;
          failures = 0;
          snapshot.remember(runtimeKey, descriptors);
          // An unchanged answer keeps the held objects, so nothing reading them re-renders.
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

// A source-control list that lands after the tracker list can claim one of its
// ids. The tracker list is rebuilt only when that changes what it shows.
useSourceControlProviderRegistry.subscribe((next, previous) => {
  if (next.byId === previous.byId) return;
  useTrackerRegistry.setState((state) => {
    const rebuilt = listState(state.served);
    return sameList(rebuilt.ordered, state.ordered) ? state : rebuilt;
  });
});

/**
 * Resolves true once the registry holds a list (remembered or answered), or
 * false when none is held within `timeoutMs`.
 */
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

/** Every tracker the server serves, in its order. */
export const useTrackerDescriptors = (): readonly TrackerDescriptor[] => useTrackerRegistry((state) => state.ordered);

/**
 * The descriptor for a tracker id; one the registry does not hold (or no id)
 * reads as the generic fallback, so a surface never handles a missing one.
 */
export const useTrackerDescriptor = (id: string | null | undefined): TrackerDescriptor => {
  const descriptor = useTrackerRegistry((state) => (id ? state.byId.get(id) : undefined));
  return descriptor ?? unknownTrackerDescriptor(id ?? '');
};

/**
 * The descriptor as the registry holds it now, for code outside React (link
 * routing, message previews). It does not re-render anything when the list
 * changes; React code uses the hooks above.
 */
export const readTrackerDescriptor = (id: string | null | undefined): TrackerDescriptor => (
  (id ? useTrackerRegistry.getState().byId.get(id) : undefined) ?? unknownTrackerDescriptor(id ?? '')
);
