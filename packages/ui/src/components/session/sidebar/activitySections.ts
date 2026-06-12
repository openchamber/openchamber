import type { Session } from '@opencode-ai/sdk/v2';

export const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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

export const sortSessionsByUpdated = (sessions: Session[]): Session[] => {
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

export const getSessionUpdatedAtMs = getSessionUpdatedAt;
