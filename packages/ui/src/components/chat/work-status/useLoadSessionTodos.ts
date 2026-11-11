import React from 'react';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';

/** Waits before reading again after a failure: 2 s, doubling to 30 s. */
const retryDelay = (failures: number) => Math.min(30_000, 2000 * 2 ** (failures - 1));

/**
 * Asks the server for the session's todo list once per session shown, and
 * again after a failed read; later changes arrive on the control stream
 * (`sync/session-todos-sync.ts`).
 */
export const useLoadSessionTodos = (sessionId: string | null, directory: string | null): void => {
  // -1 while the session has no entry yet.
  const failures = useSessionTodosStore((state) => (sessionId ? state.entries[sessionId]?.failures ?? -1 : 0));
  React.useEffect(() => {
    if (!sessionId || !directory || failures === 0) return;
    const runtimeKey = getRuntimeKey();
    const load = () => {
      void useSessionTodosStore.getState()
        .load(sessionId, directory, () => runtimeKey === getRuntimeKey())
        .catch((error) => console.warn('[session-todos] failed to read', error));
    };
    if (failures < 0) {
      load();
      return;
    }
    const timer = window.setTimeout(load, retryDelay(failures));
    return () => window.clearTimeout(timer);
  }, [directory, failures, sessionId]);
};
