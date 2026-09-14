import React from 'react';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { getMessageQueueKey, isServerOwnedMessageQueue, useMessageQueueStore, type MessageQueueHoldTarget } from '@/stores/messageQueueStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Server holds expire on their own (the UI that asserted them may be gone);
// re-assert well inside that window while a run is still going.
const REASSERT_INTERVAL_MS = 2 * 60 * 1000;

const getHoldIdentityKey = (target: MessageQueueHoldTarget): string =>
  `${getMessageQueueKey(target)}\n${target.generation}`;

const isSameHoldIdentity = (left: MessageQueueHoldTarget, right: MessageQueueHoldTarget): boolean =>
  left.runtimeKey === right.runtimeKey
  && left.sessionId === right.sessionId
  && left.directory === right.directory
  && left.generation === right.generation;

/**
 * Auto-review is driven from the UI: it forwards the implementer's answer to
 * the reviewer and back while the original session bounces through idle. The
 * queue owner must not deliver into those gaps, so while a run is going the
 * server is told to hold that session's queue, and released when it ends.
 */
export function useMessageQueueHoldSync(): void {
  const runs = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const heldRef = React.useRef<Map<string, MessageQueueHoldTarget>>(new Map());
  const runtimeKey = getRuntimeKey();
  const serverSessionIdentityVersion = useMessageQueueStore((state) => state.serverSessionIdentityVersion);

  const running = React.useMemo<Map<string, MessageQueueHoldTarget>>(() => {
    if (!isServerOwnedMessageQueue()) return new Map<string, MessageQueueHoldTarget>();
    // The store signal is intentionally read here: lifecycle maps are private,
    // so this value is what invalidates target resolution for moves/recreation.
    void serverSessionIdentityVersion;
    const next = new Map<string, MessageQueueHoldTarget>();
    for (const run of Object.values(runs)) {
      if (run.status !== 'running' || run.runtimeKey !== runtimeKey) continue;
      const target = useMessageQueueStore.getState().getServerHoldTarget(run.originalSessionID, run.directory);
      if (target.deleted) continue;
      next.set(getHoldIdentityKey(target), target);
    }
    return next;
  }, [runs, runtimeKey, serverSessionIdentityVersion]);

  React.useEffect(() => {
    const setHold = (target: MessageQueueHoldTarget, held: boolean, releaseObsoleteTarget = false) => {
      useMessageQueueStore.getState().setServerHold(target, held, {
        releaseForRuntimeSwitch: !held && target.runtimeKey !== getRuntimeKey(),
        releaseObsoleteTarget: !held && releaseObsoleteTarget,
      }).catch((error) => {
        console.warn(`[queue] failed to ${held ? 'hold' : 'release'} the queue for ${target.sessionId}:`, error);
      });
    };

    for (const [targetKey, target] of heldRef.current) {
      if (!running.has(targetKey)) {
        heldRef.current.delete(targetKey);
        const currentTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId);
        const releaseObsoleteTarget = currentTarget.deleted === true || !isSameHoldIdentity(target, currentTarget);
        setHold(target, false, releaseObsoleteTarget);
      }
    }
    for (const [targetKey, target] of running) {
      if (!heldRef.current.has(targetKey)) {
        heldRef.current.set(targetKey, target);
        setHold(target, true);
      }
    }

    if (running.size === 0) return;
    const interval = setInterval(() => {
      for (const [targetKey] of running) {
        const target = heldRef.current.get(targetKey);
        if (target) setHold(target, true);
      }
    }, REASSERT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running]);

  React.useEffect(() => () => {
    const held = heldRef.current;
    for (const target of held.values()) {
      const currentTarget = useMessageQueueStore.getState().getServerHoldTarget(target.sessionId);
      void useMessageQueueStore.getState().setServerHold(target, false, {
        releaseForRuntimeSwitch: target.runtimeKey !== getRuntimeKey(),
        releaseObsoleteTarget: currentTarget.deleted === true || !isSameHoldIdentity(target, currentTarget),
      }).catch(() => undefined);
    }
    held.clear();
  }, []);
}
