import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionStore } from '@/stores/useSessionStore';

type SessionStatusPayload = {
  type: 'idle' | 'busy' | 'retry';
  attempt?: number;
  message?: string;
  next?: number;
};

export const useSessionStatusBootstrap = (options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        // Use global status to detect busy sessions across all directories,
        // including sessions started externally (e.g., via CLI) before UI opened
        const statusMap = await opencodeClient.getGlobalSessionStatus();
        if (cancelled || !statusMap) return;

        const nextStatus = new Map<string, SessionStatusPayload>();
        Object.entries(statusMap).forEach(([sessionId, raw]) => {
          if (!sessionId || !raw) return;
          const status = raw as SessionStatusPayload;
          nextStatus.set(sessionId, status);
        });

        if (nextStatus.size > 0) {
          useSessionStore.setState({ sessionStatus: nextStatus });
        }
      } catch { /* ignored */ }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [enabled]);
};
