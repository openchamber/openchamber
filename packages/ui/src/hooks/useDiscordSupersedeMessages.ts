import { useEffect, useRef } from 'react';
import { toast } from '@/components/ui/toast';
import {
  useOttoEventsStore,
  type OttoUiRealtimeEvent,
} from '@/stores/useOttoEventsStore';
import { usePendingDiscordStore } from '@/stores/usePendingDiscordStore';

type SupersedeIncomingPayload = {
  type?: 'discord';
  sessionId?: string;
  channelId?: string;
  threadId?: string;
  text?: string;
  from?: { username?: string | null; firstName?: string | null } | null;
  projectPath?: string | null;
};

/**
 * Listens for messenger.discord.supersede_incoming events from the OpenChamber agent
 * WebSocket and stores the incoming Discord message text in the pending
 * Discord store so the UI can render it immediately — before the aborted
 * turn settles and the real OpenCode response begins streaming.
 *
 * Also shows a toast notification so the user knows a new message arrived
 * and the current turn is being superseded.
 *
 * The pending entry is resolved naturally when the SSE pipeline delivers
 * the real user message. See ChatContainer for the cleanup logic.
 */
export function useDiscordSupersedeMessages() {
  const setPending = usePendingDiscordStore((s) => s.setPending);
  const subscribeToEvents = useOttoEventsStore((s) => s.subscribeToEvents);

  // Track recently-seen session IDs to avoid duplicate toasts.
  const recentSessionsRef = useRef<Set<string>>(new Set());
  const recentCleanupTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const handler = (event: OttoUiRealtimeEvent) => {
      if (event.eventType !== 'messenger.discord.supersede_incoming') return;
      const data = event.data as SupersedeIncomingPayload | undefined;
      if (!data || !data.sessionId || !data.text) return;

      const sessionId = data.sessionId;
      const friendlyName =
        data.from?.firstName ?? data.from?.username ?? 'Discord user';
      const preview = data.text.length > 120
        ? data.text.slice(0, 120) + '…'
        : data.text;

      // Deduplicate: skip if we already showed a toast for this session
      // within the last second.
      if (recentSessionsRef.current.has(sessionId)) return;
      recentSessionsRef.current.add(sessionId);
      if (recentCleanupTimerRef.current === null) {
        recentCleanupTimerRef.current = window.setTimeout(() => {
          recentSessionsRef.current.clear();
          recentCleanupTimerRef.current = null;
        }, 1_000);
      }

      // Store the pending message for the chat UI to render.
      setPending(sessionId, {
        messageId: `discord_sup_${sessionId}_${Date.now()}`,
        text: data.text,
        from: data.from ?? null,
        timestamp: Date.now(),
        channelId: data.channelId,
        threadId: data.threadId,
      });

      // Show a toast so the user is immediately aware.
      toast.info(`📨 Discord — ${friendlyName}`, {
        description: preview,
        duration: 6_000,
      });
    };

    return subscribeToEvents(handler);
  }, [setPending, subscribeToEvents]);
}
