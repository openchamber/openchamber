import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useQuotaStore } from '@/stores/useQuotaStore';

export const useQuotaProviderSync = (): void => {
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type === 'quota-credentials-changed' || event.type === 'event-stream-ready') {
      void useQuotaStore.getState().reconcileClaudeSelection({ changed: event.type === 'quota-credentials-changed' });
    }
    if (event.type !== 'quota-providers-changed' && event.type !== 'event-stream-ready') return;
    void useQuotaStore.getState().loadExtensionProviders();
  }), []);
};
