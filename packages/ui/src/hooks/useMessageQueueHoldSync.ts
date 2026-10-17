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
  // Session id → its directory, which names the server that owns the session's queue.
  const heldRef = React.useRef<Map<string, string>>(new Map());

  const running = React.useMemo(() => {
    if (!isServerOwnedMessageQueue()) return new Map<string, string>();
    const runtimeKey = getRuntimeKey();
    return new Map(
      Object.values(runs)
        .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey)
        .map((run) => [run.originalSessionID, run.directory]),
    );
  }, [runs]);

  React.useEffect(() => {
    const setHold = (sessionId: string, directory: string, held: boolean) => {
      useMessageQueueStore.getState().setServerHold(sessionId, directory, held).catch((error) => {
        console.warn(`[queue] failed to ${held ? 'hold' : 'release'} the queue for ${sessionId}:`, error);
      });
    };

    for (const [sessionId, directory] of heldRef.current) {
      if (!running.has(sessionId)) {
        heldRef.current.delete(sessionId);
        setHold(sessionId, directory, false);
      }
    }
    for (const [sessionId, directory] of running) {
      if (!heldRef.current.has(sessionId)) {
        heldRef.current.set(sessionId, directory);
        setHold(sessionId, directory, true);
      }
    }

    if (running.size === 0) return;
    const interval = setInterval(() => {
      for (const [sessionId, directory] of running) setHold(sessionId, directory, true);
    }, REASSERT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running]);

  React.useEffect(() => () => {
    const held = heldRef.current;
    for (const [sessionId, directory] of held) {
      void useMessageQueueStore.getState().setServerHold(sessionId, directory, false).catch(() => undefined);
    }
    held.clear();
  }, []);
}
