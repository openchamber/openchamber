import React from 'react';
import { EMPTY_GUEST_CONNECTION, trackerProviderIdOf, type GuestConnection, type GuestTrackerRequest } from '@openchamber/sdk';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useTrackerAuthEntry, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';

import { trackerGuestConnection } from './tracker-connection';
import { readGuestTracker, type GuestTrackerProxyResult } from './tracker-reads';
import type { InstalledGuest } from './types';

export type GuestTrackerBridge = {
  provider: string | null;
  connection: GuestConnection;
  refresh: () => void;
  read: (request: GuestTrackerRequest) => Promise<GuestTrackerProxyResult>;
};

export const useGuestTracker = (
  guest: InstalledGuest | null,
  guestId: string,
  oauthConnection: GuestConnection | undefined,
): GuestTrackerBridge => {
  const trackers = React.useContext(RuntimeAPIContext)?.trackers;
  const refreshStatus = useTrackerAuthStore((state) => state.refreshStatus);
  const provider = guest?.tracker && !guest.integration ? trackerProviderIdOf(guestId) : null;
  const entry = useTrackerAuthEntry(provider);
  const connection = React.useMemo(
    () => (provider ? trackerGuestConnection(entry.status) : oauthConnection ?? EMPTY_GUEST_CONNECTION),
    [entry.status, oauthConnection, provider],
  );
  const refresh = React.useCallback(() => {
    if (provider) void refreshStatus(trackers, provider, { force: true });
  }, [provider, refreshStatus, trackers]);
  const read = React.useCallback(
    (request: GuestTrackerRequest) => readGuestTracker(provider, request, trackers),
    [provider, trackers],
  );
  return { provider, connection, refresh, read };
};
