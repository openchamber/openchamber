import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isTrackerConnected, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useTrackerDescriptors, useTrackerRegistry } from './registry';
import type { TrackerDescriptor, TrackerProviderId } from './types';

export const useTrackerSources = (): readonly TrackerDescriptor[] => {
  const { trackers } = useRuntimeAPIs();
  const descriptors = useTrackerDescriptors();
  const entries = useTrackerAuthStore((state) => state.entries);
  return React.useMemo(
    () => (trackers ? descriptors.filter((descriptor) => isTrackerConnected(entries[descriptor.id])) : []),
    [descriptors, entries, trackers],
  );
};

export const useTrackerSourcesPending = (): boolean => {
  const { trackers } = useRuntimeAPIs();
  const descriptors = useTrackerDescriptors();
  const listPending = useTrackerRegistry((state) => !state.holdsList && state.status !== 'error');
  const entries = useTrackerAuthStore((state) => state.entries);
  React.useEffect(() => {
    if (!trackers) return;
    for (const descriptor of descriptors) {
      if (!entries[descriptor.id]) void useTrackerAuthStore.getState().refreshStatus(trackers, descriptor.id);
    }
  }, [descriptors, entries, trackers]);
  if (!trackers) return false;
  return listPending || descriptors.some((descriptor) => !entries[descriptor.id]?.status);
};

export const useTrackerSourceStatus = (provider: TrackerProviderId | null | undefined): 'ready' | 'disconnected' | 'unsupported' => {
  const { trackers } = useRuntimeAPIs();
  const registered = useTrackerRegistry((state) => Boolean(provider && state.byId.has(provider)));
  const checked = useTrackerAuthStore((state) => (provider ? state.entries[provider]?.hasChecked === true : false));
  const connected = useTrackerAuthStore((state) => (provider ? isTrackerConnected(state.entries[provider]) : false));
  if (!trackers || !provider || !registered) return 'unsupported';
  return checked && !connected ? 'disconnected' : 'ready';
};
