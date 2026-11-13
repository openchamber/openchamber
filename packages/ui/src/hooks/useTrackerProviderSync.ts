/**
 * Keeps the tracker list, and the sign-in status of each tracker, current
 * while the app runs. Both are read once when the app connects, but an
 * extension can start or stop acting as a tracker at any time (approved,
 * enabled, updated, paused, removed), and its links follow the server it
 * connects. The server announces that on the control stream; this hook reads
 * the trackers and their statuses again then, and when the stream reconnects,
 * since a change made during the gap was not announced to this client.
 */

import React from 'react';

import type { TrackerAPI } from '@/lib/api/types';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { refreshTrackers } from '@/stores/useTrackerAuthStore';

export const useTrackerProviderSync = (trackers: TrackerAPI | undefined): void => {
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'tracker-providers-changed' && event.type !== 'event-stream-ready') return;
    void refreshTrackers(trackers);
  }), [trackers]);
};
