import type { Session } from '@opencode-ai/sdk/v2';

const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const RECENT_SESSION_INITIAL_VISIBLE_COUNT = 3;
export const RECENT_SESSION_LIMIT = 8;

export const getRecentSectionDisplayState = (
  totalCount: number,
  initialVisibleCount: number,
  expanded: boolean,
): { visibleCount: number; canShowMore: boolean; canShowFewer: boolean } => {
  const safeTotalCount = Math.max(0, totalCount);
  const safeInitialVisibleCount = Math.max(0, initialVisibleCount);
  const visibleCount = expanded
    ? safeTotalCount
    : Math.min(safeInitialVisibleCount, safeTotalCount);

  return {
    visibleCount,
    canShowMore: !expanded && visibleCount < safeTotalCount,
    canShowFewer: expanded && safeTotalCount > safeInitialVisibleCount,
  };
};

export const getRecentNavigationVisibleCount = (
  targetIndex: number,
  initialVisibleCount: number,
  totalCount: number,
): number => {
  const safeInitialVisibleCount = Math.max(0, initialVisibleCount);
  if (targetIndex < safeInitialVisibleCount) {
    return safeInitialVisibleCount;
  }
  return Math.max(safeInitialVisibleCount, totalCount);
};

const isSubtaskSession = (session: Session): boolean => {
  return Boolean((session as Session & { parentID?: string | null }).parentID);
};

const isArchivedSession = (session: Session): boolean => {
  return Boolean(session.time?.archived);
};

const getSessionUpdatedAt = (session: Session): number => {
  const updated = session.time?.updated;
  const created = session.time?.created;
  if (typeof updated === 'number' && Number.isFinite(updated)) {
    return updated;
  }
  if (typeof created === 'number' && Number.isFinite(created)) {
    return created;
  }
  return 0;
};

const sortSessionsByUpdated = (sessions: Session[]): Session[] => {
  return [...sessions].sort((a, b) => getSessionUpdatedAt(b) - getSessionUpdatedAt(a));
};

// Recent sessions are simply every non-archived, top-level session updated
// within the last RECENT_SESSION_MAX_AGE_MS. No persisted history or live-busy
// tracking — membership is derived directly from session timestamps.
export const deriveRecentSessions = (
  sessions: Session[],
  now = Date.now(),
): Session[] => {
  const minUpdatedAt = now - RECENT_SESSION_MAX_AGE_MS;
  const recent = sessions.filter((session) => {
    if (isArchivedSession(session) || isSubtaskSession(session)) {
      return false;
    }
    return getSessionUpdatedAt(session) >= minUpdatedAt;
  });
  return sortSessionsByUpdated(recent);
};
