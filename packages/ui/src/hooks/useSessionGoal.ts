import React from 'react';
import { useSession } from '@/sync/sync-context';
import { getSessionGoal, type SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { fetchGoalObjectiveContent } from '@/lib/goalObjectiveFiles';
import { useUIStore } from '@/stores/useUIStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useSmallModelAvailability } from '@/hooks/useSmallModelAvailability';

export interface SessionGoalState {
  /** Parsed goal payload, or null when the session has no goal. */
  goal: SessionGoalPayload | null;
  /** The Settings → Chat toggle; when off, goal UI stays hidden. */
  enabled: boolean;
}

// Live goal state: the payload rides session.updated, so subscribing to the
// session record is all the plumbing needed.
export function useSessionGoal(sessionId: string, directory?: string): SessionGoalState {
  const session = useSession(sessionId, directory);
  const enabled = useUIStore((state) => state.sessionGoalEnabled);
  return {
    goal: getSessionGoal(session),
    enabled,
  };
}

/**
 * False only when nothing can check a goal's progress: Jev is not the chosen
 * checker or has no classification provider, and the small model is known to
 * be unavailable. The server checks with the small model whenever Jev cannot,
 * so that is the model asked about here.
 */
export function useGoalCheckAvailable(directory: string | undefined, active: boolean): boolean {
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);
  const checker = useUIStore((state) => state.sessionGoalChecker);
  const jevChecks = jevAvailable && checker === 'classifier';
  const smallModel = useSmallModelAvailability(directory, active && !jevChecks);
  return jevChecks || smallModel !== 'unavailable';
}

const OBJECTIVE_CONTENT_CACHE_MAX = 64;
const objectiveContentByFetchKey = new Map<string, Promise<string | null>>();

// Effective objective text for display. Inline goals return the metadata
// text directly; file-backed goals fetch the server-side file once per
// goal edit (keyed by id + updatedAt). Display-only: a failed fetch yields
// null and callers degrade gracefully (e.g. VS Code, where the OpenChamber
// route is unavailable — the strip then shows a generic goal title).
export function useGoalObjectiveContent(sessionId: string, goal: SessionGoalPayload | null): string | null {
  const [fetched, setFetched] = React.useState<string | null>(null);
  const fetchKey = goal?.objectiveFile ? `${sessionId}:${goal.id}:${goal.updatedAt}` : '';

  React.useEffect(() => {
    if (!fetchKey) {
      setFetched(null);
      return undefined;
    }
    let alive = true;
    // The key already names the goal edit, so a remount (every session switch
    // remounts the strip) reuses the text instead of fetching the file again.
    let request = objectiveContentByFetchKey.get(fetchKey);
    if (!request) {
      request = fetchGoalObjectiveContent(sessionId);
      objectiveContentByFetchKey.set(fetchKey, request);
      if (objectiveContentByFetchKey.size > OBJECTIVE_CONTENT_CACHE_MAX) {
        const oldest = objectiveContentByFetchKey.keys().next().value;
        if (oldest !== undefined) objectiveContentByFetchKey.delete(oldest);
      }
    }
    void request.then((content) => {
      if (alive) setFetched(content);
    });
    return () => {
      alive = false;
    };
  }, [fetchKey, sessionId]);

  if (!goal) return null;
  return goal.objectiveFile ? fetched : goal.objective;
}
