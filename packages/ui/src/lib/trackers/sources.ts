import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isTrackerConnected, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useTrackerDescriptors, useTrackerRegistry } from './registry';
import type { TrackerDescriptor, TrackerProviderId } from './types';

/**
 * The trackers a surface can offer right now: served by the connected server
 * and signed in. Empty where the runtime has no trackers (VS Code). In the
 * server's order; one array while nothing changes.
 */
export const useTrackerSources = (): readonly TrackerDescriptor[] => {
  const { trackers } = useRuntimeAPIs();
  const descriptors = useTrackerDescriptors();
  const entries = useTrackerAuthStore((state) => state.entries);
  return React.useMemo(
    () => (trackers ? descriptors.filter((descriptor) => isTrackerConnected(entries[descriptor.id])) : []),
    [descriptors, entries, trackers],
  );
};

/**
 * Whether a tracker's lists can be read: `unsupported` where the runtime has
 * no trackers or the server does not serve this one, `disconnected` once its
 * status answered that nobody is signed in, `ready` otherwise (also while the
 * first status read is out, so a list does not flash a sign-in prompt).
 */
export const useTrackerSourceStatus = (provider: TrackerProviderId | null | undefined): 'ready' | 'disconnected' | 'unsupported' => {
  const { trackers } = useRuntimeAPIs();
  const registered = useTrackerRegistry((state) => Boolean(provider && state.byId.has(provider)));
  const checked = useTrackerAuthStore((state) => (provider ? state.entries[provider]?.hasChecked === true : false));
  const connected = useTrackerAuthStore((state) => (provider ? isTrackerConnected(state.entries[provider]) : false));
  if (!trackers || !provider || !registered) return 'unsupported';
  return checked && !connected ? 'disconnected' : 'ready';
};
