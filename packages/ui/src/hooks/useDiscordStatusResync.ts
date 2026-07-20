import { useEffect, useRef } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessengerStore } from '@/stores/useMessengerStore';

/**
 * Keep Discord settings status aligned with the live server gateway.
 *
 * After a server rebuild/restart the listener often auto-starts and keeps
 * working, but the persisted UI store still says "disconnected". Re-sync when
 * the OpenChamber runtime becomes connected again (and once on mount if we
 * are already connected).
 */
export function useDiscordStatusResync() {
  const isConnected = useConfigStore((s) => s.isConnected);
  const lastSyncedConnectedRef = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      lastSyncedConnectedRef.current = false;
      return;
    }
    // Only fire on the rising edge (and the initial connected mount). Avoids
    // re-hitting Discord on unrelated re-renders while already connected.
    if (lastSyncedConnectedRef.current) return;
    lastSyncedConnectedRef.current = true;
    void useMessengerStore.getState().resyncDiscordStatus();
  }, [isConnected]);
}
