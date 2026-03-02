import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';

/**
 * Hook that monitors planning session status transitions.
 * When a planning session transitions from busy/retry to idle,
 * triggers JSON extraction and validation.
 *
 * Mount this once at the app level (e.g. inside MainLayout).
 */
export function usePlanningSessionWatcher(): void {
  const prevStatusRef = React.useRef<Map<string, string>>(new Map());

  const sessionStatus = useSessionStore((s) => s.sessionStatus);
  const onPlanningSessionCompleted = useAgentLoopStore((s) => s.onPlanningSessionCompleted);
  const planningSessions = useAgentLoopStore((s) => s.planningSessions);

  React.useEffect(() => {
    if (!sessionStatus) return;

    // Only watch planning sessions that are actively generating
    const watchedSessionIds = new Set<string>();
    for (const ps of planningSessions.values()) {
      if (ps.status === 'planning') {
        watchedSessionIds.add(ps.sessionId);
      }
    }

    if (watchedSessionIds.size === 0) return;

    const prev = prevStatusRef.current;
    for (const sessionId of watchedSessionIds) {
      const currentStatus = sessionStatus.get(sessionId);
      const currentType = currentStatus?.type ?? 'unknown';
      const prevType = prev.get(sessionId);

      if (
        prevType !== undefined &&
        (prevType === 'busy' || prevType === 'retry' || prevType === 'unknown') &&
        currentType === 'idle'
      ) {
        void onPlanningSessionCompleted(sessionId);
      }
    }

    // Update previous status snapshot
    const nextPrev = new Map<string, string>();
    for (const sessionId of watchedSessionIds) {
      const currentStatus = sessionStatus.get(sessionId);
      nextPrev.set(sessionId, currentStatus?.type ?? 'unknown');
    }
    prevStatusRef.current = nextPrev;
  }, [sessionStatus, planningSessions, onPlanningSessionCompleted]);
}
