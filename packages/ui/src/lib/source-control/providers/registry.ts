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

type SourceControlProviderRegistryStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

interface SourceControlProviderRegistryState {
  runtimeKey: string;
  byId: ReadonlyMap<string, SourceControlProviderDescriptor>;
  ordered: readonly SourceControlProviderDescriptor[];
  status: SourceControlProviderRegistryStatus;
  holdsList: boolean;
  refresh: (sourceControl: Pick<SourceControlAPI, 'providers'>) => Promise<void>;
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
      const { holdsList, ordered: held } = get();
      set({ status: 'loading' });
      const read = async () => {
        try {
          const descriptors = await sourceControl.providers();
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

queueMicrotask(() => {
  const state = useSourceControlProviderRegistry.getState();
  const runtimeKey = getRuntimeKey();
  if (state.status === 'idle' && runtimeKey !== state.runtimeKey) state.resetForRuntimeSwitch(runtimeKey);
});

export const useSourceControlProviders = (): readonly SourceControlProviderDescriptor[] => (
  useSourceControlProviderRegistry((state) => state.ordered)
);

export const useSourceControlProvider = (id: string | null | undefined): SourceControlProviderDescriptor => {
  const descriptor = useSourceControlProviderRegistry((state) => (id ? state.byId.get(id) : undefined));
  return descriptor ?? unknownProviderDescriptor(id ?? '');
};

export const useChangeRequestTerm = (id: string | null | undefined): ChangeRequestTerm => (
  useSourceControlProvider(id).terminology.changeRequest
);

type SourceControlProviderServing = 'served' | 'not-served' | 'unknown';

export const useSourceControlProviderServing = (id: string | null | undefined): SourceControlProviderServing => (
  useSourceControlProviderRegistry((state) => {
    if (id && state.byId.has(id)) return 'served';
    return state.holdsList ? 'not-served' : 'unknown';
  })
);

export const useChangeRequestDiffServing = (id: string | null | undefined): SourceControlProviderServing => (
  useSourceControlProviderRegistry((state) => {
    const descriptor = id ? state.byId.get(id) : undefined;
    if (descriptor) return descriptor.features.changeRequestPatch ? 'served' : 'not-served';
    return state.holdsList ? 'not-served' : 'unknown';
  })
);

export type SourceControlDescriptorOf = (id: string | null | undefined) => SourceControlProviderDescriptor;

export const useSourceControlDescriptorOf = (): SourceControlDescriptorOf => {
  const byId = useSourceControlProviderRegistry((state) => state.byId);
  return React.useCallback((id) => (id ? byId.get(id) : undefined) ?? unknownProviderDescriptor(id ?? ''), [byId]);
};

export const readSourceControlProvider = (id: string | null | undefined): SourceControlProviderDescriptor => (
  (id ? useSourceControlProviderRegistry.getState().byId.get(id) : undefined) ?? unknownProviderDescriptor(id ?? '')
);
