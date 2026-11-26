import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isSessionTodosStale, showSessionTodos, useSessionTodosStore } from '@/stores/useSessionTodosStore';

const retryDelay = (failures: number) => Math.min(30_000, 2000 * 2 ** (failures - 1));

export const useLoadSessionTodos = (sessionId: string | null, directory: string | null, shown: boolean): void => {
  const failures = useSessionTodosStore((state) => (sessionId ? state.entries[sessionId]?.failures ?? -1 : 0));
  React.useEffect(() => {
    if (!shown || !sessionId || !directory || isVSCodeRuntime()) return;
    const release = showSessionTodos(sessionId);
    if (failures === 0 && !isSessionTodosStale(sessionId)) return release;
    const runtimeKey = getRuntimeKey();
    const load = () => {
      void useSessionTodosStore.getState()
        .load(sessionId, directory, () => runtimeKey === getRuntimeKey())
        .catch((error) => console.warn('[session-todos] failed to read', error));
    };
    if (failures <= 0 || isSessionTodosStale(sessionId)) {
      load();
      return release;
    }
    const timer = window.setTimeout(load, retryDelay(failures));
    return () => {
      window.clearTimeout(timer);
      release();
    };
  }, [directory, failures, sessionId, shown]);
};
