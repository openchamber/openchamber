import type { Session } from '@opencode-ai/sdk/v2';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';

/**
 * Returns the ordered list of top-level (parent) sessions, most-recent-first,
 * using the single lifecycle ordering authority (pinned-first, then activity
 * rank, then time). This mirrors the ordering used by the session switcher
 * (`useSwitcherItems`) so keyboard "recent session" jumps and cycling agree
 * with what the user sees. Unlike the switcher it is NOT sliced, so index-based
 * jumps (alt+1..9) can reach deeper than the visible switcher cap.
 *
 * Reads live from stores at call time (no cached ordering) so it stays correct
 * across runtime/instance switches.
 */
export const getRecentParentSessions = (): Session[] => {
  const activeSessions = useGlobalSessionsStore.getState().activeSessions;
  const pinnedSessionIds = useSessionPinnedStore.getState().ids;
  const rankById = useSessionOrderingStore.getState().rankById;

  return activeSessions
    .filter((session) => !session.time?.archived)
    .filter((session) => !(session as Session & { parentID?: string | null }).parentID)
    .slice()
    .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, rankById));
};
