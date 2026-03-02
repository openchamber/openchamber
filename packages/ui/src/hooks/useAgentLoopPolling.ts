import React from 'react';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';

const POLLING_INTERVAL_MS = 2000;

/**
 * Hook that polls the backend for agent loop state.
 * Fetches on mount (recovers state after page refresh) and
 * polls every 2s while any loop is running or paused.
 *
 * Mount this once at the app level (e.g. inside MainLayout).
 */
export function useAgentLoopPolling(): void {
  const fetchLoops = useAgentLoopStore((s) => s.fetchLoops);
  const loops = useAgentLoopStore((s) => s.loops);

  // Fetch on mount
  React.useEffect(() => {
    void fetchLoops();
  }, [fetchLoops]);

  // Determine if we have any active loops
  const hasActiveLoops = React.useMemo(() => {
    for (const loop of loops.values()) {
      if (loop.status === 'running' || loop.status === 'paused') return true;
    }
    return false;
  }, [loops]);

  // Poll while loops are active
  React.useEffect(() => {
    if (!hasActiveLoops) return;

    const intervalId = setInterval(() => {
      void fetchLoops();
    }, POLLING_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [hasActiveLoops, fetchLoops]);
}
