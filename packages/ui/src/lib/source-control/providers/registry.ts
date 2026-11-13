import React from 'react';
import { create } from 'zustand';
import type { SourceControlAPI } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  sourceControlProviderListSchema,
  unknownProviderDescriptor,
  type ChangeRequestTerm,
  type SourceControlProviderDescriptor,
} from './descriptor';
import { createRuntimeListSnapshot, listRetryDelayMs, sameList } from './runtimeList';

/**
 * The source-control providers of the connected server, read from
 * `SourceControlAPI.providers()`.
 *
 * - `idle`: nothing remembered and nothing asked yet.
 * - `stale`: a list remembered from an earlier visit to this runtime, or the
 *   last list after a failed refresh. It stays until the server answers.
 * - `loading`: a refresh is in flight; whatever list is held stays shown.
 * - `ready`: the server's own answer for this runtime, possibly empty.
 * - `error`: a refresh failed and there is no list to show. It is retried
 *   with a growing wait until the server answers or the runtime changes.
 *
 * A failed refresh never replaces a held list with an empty one, and until a
 * list is held (`holdsList`) which providers the server serves is unknown,
 * not "none".
 */
type SourceControlProviderRegistryStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

interface SourceControlProviderRegistryState {
  runtimeKey: string;
  byId: ReadonlyMap<string, SourceControlProviderDescriptor>;
  ordered: readonly SourceControlProviderDescriptor[];
  status: SourceControlProviderRegistryStatus;
  /** A list is held: remembered for this runtime or answered by its server (an empty answer too). */
  holdsList: boolean;
  /**
   * Asks the server of the current runtime again. A call made while a read is
   * out is answered by one more read after it settles, shared by every such
   * call. A runtime other than the held one first shows that runtime's
   * remembered list.
   */
  refresh: (sourceControl: Pick<SourceControlAPI, 'providers'>) => Promise<void>;
  /** Forgets the previous runtime's list and shows what is remembered for the next one. */
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

const snapshot = createRuntimeListSnapshot('openchamber.sourceControlProviders.v1', sourceControlProviderListSchema);

const listState = (descriptors: readonly SourceControlProviderDescriptor[]) => ({
  ordered: descriptors,
  byId: new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])),
});

const EMPTY_LIST = listState([]);

const rememberedState = (runtimeKey: string) => {
  const remembered = snapshot.read(runtimeKey);
  return remembered
    ? { runtimeKey, ...listState(remembered), status: 'stale' as const, holdsList: true }
    : { runtimeKey, ...EMPTY_LIST, status: 'idle' as const, holdsList: false };
};

let generation = 0;
let inFlight: Promise<void> | null = null;
// One more read, after the one on the wire settles, for every refresh asked
// while it was out: the server may have answered that read before the change
// the later caller is refreshing for.
let followUp: Promise<void> | null = null;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const cancelRetry = (): void => {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
};

export const useSourceControlProviderRegistry = create<SourceControlProviderRegistryState>((set, get) => {
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
    refresh: (sourceControl) => {
      // Read now, not at import: the store is created before the runtime
      // endpoint is initialized, when the key is still a transient one.
      const runtimeKey = getRuntimeKey();
      if (runtimeKey !== get().runtimeKey) showRuntime(runtimeKey);
      if (inFlight) {
        if (!followUp) {
          const followUpGeneration = generation;
          const next: Promise<void> = inFlight.then(() => {
            if (followUp === next) followUp = null;
            if (followUpGeneration !== generation) return undefined;
            return get().refresh(sourceControl);
          });
          followUp = next;
        }
        return followUp;
      }
      cancelRetry();
      const requestGeneration = generation;
      // A remembered or answered list (even an empty answer) survives a failed refresh.
      const { holdsList, ordered: held } = get();
      set({ status: 'loading' });
      const read = async () => {
        try {
          const descriptors = await sourceControl.providers();
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
            if (requestGeneration === generation) void get().refresh(sourceControl);
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

// The store is created during import, before the runtime endpoint is
// initialized. Once the importing module graph has run, show the list
// remembered for the runtime it initialized, so first paint is not generic.
// `refresh` reads the key again in any case.
queueMicrotask(() => {
  const state = useSourceControlProviderRegistry.getState();
  const runtimeKey = getRuntimeKey();
  if (state.status === 'idle' && runtimeKey !== state.runtimeKey) state.resetForRuntimeSwitch(runtimeKey);
});

/** Every provider the server serves, ordered. */
export const useSourceControlProviders = (): readonly SourceControlProviderDescriptor[] => (
  useSourceControlProviderRegistry((state) => state.ordered)
);

/**
 * The descriptor for a provider id; one the registry does not hold (or no id)
 * reads as the generic fallback, so a surface never has to handle a missing
 * descriptor.
 */
export const useSourceControlProvider = (id: string | null | undefined): SourceControlProviderDescriptor => {
  const descriptor = useSourceControlProviderRegistry((state) => (id ? state.byId.get(id) : undefined));
  return descriptor ?? unknownProviderDescriptor(id ?? '');
};

export const useChangeRequestTerm = (id: string | null | undefined): ChangeRequestTerm => (
  useSourceControlProvider(id).terminology.changeRequest
);

/**
 * Whether the connected server serves a provider: `unknown` while no list is
 * held (the first request is out, or failed and is being retried). Surfaces
 * that only a served provider has (change-request diffs, walkthroughs) wait
 * on `unknown` as they do on loading, and never read it as `not-served`.
 */
type SourceControlProviderServing = 'served' | 'not-served' | 'unknown';

export const useSourceControlProviderServing = (id: string | null | undefined): SourceControlProviderServing => (
  useSourceControlProviderRegistry((state) => {
    if (id && state.byId.has(id)) return 'served';
    return state.holdsList ? 'not-served' : 'unknown';
  })
);

/**
 * Whether the server reads a provider's change-request diffs, which the
 * comparison view and walkthroughs show. A served provider can list and open
 * its change requests and still not serve their diff
 * (`features.changeRequestPatch` off); `unknown` while no list is held.
 */
export const useChangeRequestDiffServing = (id: string | null | undefined): SourceControlProviderServing => (
  useSourceControlProviderRegistry((state) => {
    const descriptor = id ? state.byId.get(id) : undefined;
    if (descriptor) return descriptor.features.changeRequestPatch ? 'served' : 'not-served';
    return state.holdsList ? 'not-served' : 'unknown';
  })
);

/**
 * A lookup from provider id to descriptor, for surfaces that name several
 * providers in one render (rows of different hosts). An id the registry does
 * not hold reads as the generic fallback. One function while the list stays.
 */
export type SourceControlDescriptorOf = (id: string | null | undefined) => SourceControlProviderDescriptor;

export const useSourceControlDescriptorOf = (): SourceControlDescriptorOf => {
  const byId = useSourceControlProviderRegistry((state) => state.byId);
  return React.useCallback((id) => (id ? byId.get(id) : undefined) ?? unknownProviderDescriptor(id ?? ''), [byId]);
};

/**
 * The descriptor for a provider id as the registry holds it now, for text built
 * outside React: message previews and display parts, toasts. It does not
 * re-render anything when the list changes; React code uses the hooks above.
 */
export const readSourceControlProvider = (id: string | null | undefined): SourceControlProviderDescriptor => (
  (id ? useSourceControlProviderRegistry.getState().byId.get(id) : undefined) ?? unknownProviderDescriptor(id ?? '')
);
