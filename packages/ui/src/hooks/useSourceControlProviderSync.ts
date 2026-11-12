/**
 * Keeps the source-control provider list, and the connected instances of
 * those providers, current while the app runs.
 *
 * Both are read once when the app connects, but an extension can start or
 * stop acting as a Git host at any time (approved, enabled, updated, paused,
 * removed). The server announces that on the control stream; this hook asks
 * for the provider list and the auth store's instances again then, and also
 * when the stream reconnects, since a change made during the gap was not
 * announced to this client. The instance list names only registered
 * providers, so a provider added mid-session has no instances (and no link
 * matching or account status) until it is read again. The registry keeps the
 * held list when a refresh fails, and a refresh made while a read is out is
 * answered by one more read after it.
 */

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
