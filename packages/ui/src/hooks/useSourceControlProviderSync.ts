
import React from 'react';

import type { SourceControlAPI } from '@/lib/api/types';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

export const useSourceControlProviderSync = (
  sourceControl: Pick<SourceControlAPI, 'providers' | 'authInstances' | 'authStatus'>,
): void => {
  const refresh = useSourceControlProviderRegistry((state) => state.refresh);
  const refreshAuth = useSourceControlAuthStore((state) => state.refreshAll);

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'source-control-providers-changed' && event.type !== 'event-stream-ready') return;
    void refresh(sourceControl);
    void refreshAuth(sourceControl, { force: true });
  }), [refresh, refreshAuth, sourceControl]);
};
