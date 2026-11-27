import type { GuestTrackerFilterOptions, GuestTrackerRequest, GuestTrackerResult, HostRequestErrorCode } from '@openchamber/sdk';

import type { TrackerAPI } from '@/lib/trackers/types';

export type GuestTrackerProxyResult =
  | { ok: true; result: GuestTrackerResult }
  | { ok: false; code: HostRequestErrorCode; message: string };

const trackerFilters = async (provider: string, trackers: TrackerAPI): Promise<GuestTrackerFilterOptions> => {
  const descriptor = (await trackers.providers()).find((entry) => entry.id === provider);
  if (!descriptor) throw new Error('This extension has no tracker to read.');
  return {
    name: descriptor.name,
    stateFilters: [...descriptor.stateFilters],
    people: descriptor.capabilities.filters.people,
    priority: descriptor.capabilities.filters.priority,
  };
};

export const readGuestTracker = async (
  provider: string | null,
  request: GuestTrackerRequest,
  trackers: TrackerAPI | undefined,
): Promise<GuestTrackerProxyResult> => {
  if (!provider) return { ok: false, code: 'NOT_GRANTED', message: 'This extension has no tracker.' };
  if (!trackers) return { ok: false, code: 'UNSUPPORTED', message: 'This host does not serve trackers.' };
  try {
    if (request.op === 'list') {
      return { ok: true, result: { op: 'list', result: await trackers.list(provider, request.options) } };
    }
    if (request.op === 'get') {
      return { ok: true, result: { op: 'get', result: await trackers.get(provider, request.id) } };
    }
    return { ok: true, result: { op: 'filters', result: await trackerFilters(provider, trackers) } };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : '';
    return { ok: false, code: 'HOST_REJECTED', message: message || 'The tracker did not answer.' };
  }
};
