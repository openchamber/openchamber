import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';

const retryDelay = (failures: number) => Math.min(30_000, 2000 * 2 ** (failures - 1));

export const useLoadSessionTodos = (sessionId: string | null, directory: string | null): void => {
  const failures = useSessionTodosStore((state) => (sessionId ? state.entries[sessionId]?.failures ?? -1 : 0));
  React.useEffect(() => {
    if (!sessionId || !directory || failures === 0 || isVSCodeRuntime()) return;
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
