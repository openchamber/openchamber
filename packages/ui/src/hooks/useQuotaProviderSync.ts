/**
 * Keeps the list of usage providers installed extensions serve current while
 * the app runs. The quota store reads it when an instance loads, but an
 * extension can start or stop reporting usage at any time (approved, enabled,
 * updated, paused, removed). The server announces that on the control stream;
 * this hook reads the list again then, and when the stream reconnects, since
 * a change made during the gap was not announced to this client.
 */

import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useQuotaStore } from '@/stores/useQuotaStore';

export const useQuotaProviderSync = (): void => {
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'quota-providers-changed' && event.type !== 'event-stream-ready') return;
    void useQuotaStore.getState().loadExtensionProviders();
  }), []);
};
