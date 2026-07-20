import { useEffect, useRef } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessengerStore } from '@/stores/useMessengerStore';
import { useOpenChamberAgentEventsStore } from '@/stores/useOpenChamberAgentEventsStore';

/**
 * Keep Discord settings status aligned with the live server gateway.
 *
 * After a server rebuild/restart the listener often auto-starts and keeps
 * working, but the persisted UI store still says "disconnected". Re-sync when
 * the OpenChamber runtime becomes connected again, and flip to connected as
 * soon as the gateway emits `listener_ready`.
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

  useEffect(() => {
    return useOpenChamberAgentEventsStore.getState().subscribeToEvents((event) => {
      if (event.eventType !== 'messenger.discord.listener_ready') return;
      const data =
        event.data && typeof event.data === 'object'
          ? (event.data as { botId?: string; botUsername?: string })
          : null;
      useMessengerStore.getState().updateConnection('discord', {
        status: 'connected',
        error: null,
        discordListenerRunning: true,
        discordListenerConnected: true,
        lastConnectedAt: Date.now(),
        ...(data?.botId ? { discordBotId: data.botId } : {}),
        ...(data?.botUsername ? { discordBotUsername: data.botUsername } : {}),
      });
    });
  }, []);
}
