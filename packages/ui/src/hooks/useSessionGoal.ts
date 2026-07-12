import { useSession } from '@/sync/sync-context';
import { getSessionGoal, type SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { useUIStore } from '@/stores/useUIStore';

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
