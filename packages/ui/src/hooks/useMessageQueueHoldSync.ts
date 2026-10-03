import React from 'react';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { isServerOwnedMessageQueue, useMessageQueueStore } from '@/stores/messageQueueStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Server holds expire on their own (the UI that asserted them may be gone);
// re-assert well inside that window while a run is still going.
const REASSERT_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Auto-review is driven from the UI: it forwards the implementer's answer to
 * the reviewer and back while the original session bounces through idle. The
 * queue owner must not deliver into those gaps, so while a run is going the
 * server is told to hold that session's queue, and released when it ends.
 */
export function useMessageQueueHoldSync(): void {
  const runs = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const heldRef = React.useRef<Set<string>>(new Set());

  const running = React.useMemo(() => {
    if (!isServerOwnedMessageQueue()) return new Set<string>();
    const runtimeKey = getRuntimeKey();
    return new Set(
      Object.values(runs)
        .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey)
        .map((run) => run.originalSessionID),
    );
  }, [runs]);

  React.useEffect(() => {
    const setHold = (sessionId: string, held: boolean) => {
      useMessageQueueStore.getState().setServerHold(sessionId, held).catch((error) => {
        console.warn(`[queue] failed to ${held ? 'hold' : 'release'} the queue for ${sessionId}:`, error);
      });
    };

    for (const sessionId of heldRef.current) {
      if (!running.has(sessionId)) {
        heldRef.current.delete(sessionId);
        setHold(sessionId, false);
      }
    }
    for (const sessionId of running) {
      if (!heldRef.current.has(sessionId)) {
        heldRef.current.add(sessionId);
        setHold(sessionId, true);
      }
    }

    if (running.size === 0) return;
    const interval = setInterval(() => {
      for (const sessionId of running) setHold(sessionId, true);
    }, REASSERT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running]);

  React.useEffect(() => () => {
    const held = heldRef.current;
    for (const sessionId of held) {
      void useMessageQueueStore.getState().setServerHold(sessionId, false).catch(() => undefined);
    }
    held.clear();
  }, []);
}
