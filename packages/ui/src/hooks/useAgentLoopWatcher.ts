import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { useAgentLoopStore } from '@/stores/useAgentLoopStore';

/**
 * Hook that monitors session status transitions and advances
 * agent loops when a child session finishes (busy/retry → idle).
 *
 * Mount this once at the app level (e.g. inside MainLayout or App).
 */
export function useAgentLoopWatcher(): void {
  // Track the previous status per session to detect transitions
  const prevStatusRef = React.useRef<Map<string, string>>(new Map());

  const sessionStatus = useSessionStore((s) => s.sessionStatus);
  const onSessionCompleted = useAgentLoopStore((s) => s.onSessionCompleted);
  const loops = useAgentLoopStore((s) => s.loops);

  React.useEffect(() => {
    if (!sessionStatus) return;

    // Build a set of session IDs we care about (all running workpackage sessions)
    const watchedSessionIds = new Set<string>();
    for (const loop of loops.values()) {
      if (loop.status !== 'running') continue;
      for (const wp of loop.workpackages) {
        if (wp.sessionId && wp.status === 'running') {
          watchedSessionIds.add(wp.sessionId);
        }
      }
    }

    if (watchedSessionIds.size === 0) return;

    // Check for transitions
    const prev = prevStatusRef.current;
    for (const sessionId of watchedSessionIds) {
      const currentStatus = sessionStatus.get(sessionId);
      const currentType = currentStatus?.type ?? 'idle';
      const prevType = prev.get(sessionId);

      // Detect busy/retry → idle transition (skip if no previous status recorded)
      if (
        prevType !== undefined &&
        (prevType === 'busy' || prevType === 'retry') &&
        currentType === 'idle'
      ) {
        onSessionCompleted(sessionId);
      }
    }

    // Update previous status snapshot
    const nextPrev = new Map<string, string>();
    for (const sessionId of watchedSessionIds) {
      const currentStatus = sessionStatus.get(sessionId);
      nextPrev.set(sessionId, currentStatus?.type ?? 'idle');
    }
    prevStatusRef.current = nextPrev;
  }, [sessionStatus, loops, onSessionCompleted]);
}
