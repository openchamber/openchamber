import React from 'react';
import { useSession } from '@/sync/sync-context';
import { getSessionGoal, type SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { fetchGoalObjectiveContent } from '@/lib/goalObjectiveFiles';
import { useUIStore } from '@/stores/useUIStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useSmallModelAvailability } from '@/hooks/useSmallModelAvailability';

export interface SessionGoalState {
  goal: SessionGoalPayload | null;
  enabled: boolean;
}

export function useSessionGoal(sessionId: string, directory?: string): SessionGoalState {
  const session = useSession(sessionId, directory);
  const enabled = useUIStore((state) => state.sessionGoalEnabled);
  return {
    goal: getSessionGoal(session),
    enabled,
  };
}

export function useGoalCheckAvailable(directory: string | undefined, active: boolean): boolean {
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);
  const checker = useUIStore((state) => state.sessionGoalChecker);
  const jevChecks = jevAvailable && checker === 'classifier';
  const smallModel = useSmallModelAvailability(directory, active && !jevChecks);
  return jevChecks || smallModel !== 'unavailable';
}

const OBJECTIVE_CONTENT_CACHE_MAX = 64;
const objectiveContentByFetchKey = new Map<string, Promise<string | null>>();

export function useGoalObjectiveContent(sessionId: string, goal: SessionGoalPayload | null): string | null {
  const [fetched, setFetched] = React.useState<string | null>(null);
  const fetchKey = goal?.objectiveFile ? `${sessionId}:${goal.id}:${goal.updatedAt}` : '';

  React.useEffect(() => {
    if (!fetchKey) {
      setFetched(null);
      return undefined;
    }
    let alive = true;
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
