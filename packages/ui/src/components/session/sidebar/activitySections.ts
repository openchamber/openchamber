import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';

export const ACTIVE_NOW_STORAGE_KEY = 'oc.sessions.activeNow';
export const ACTIVE_NOW_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export type ActiveNowEntry = {
  sessionId: string;
};

const RECENT_SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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

export const readActiveNowEntries = (storage: Storage): ActiveNowEntry[] => {
  try {
    const raw = storage.getItem(ACTIVE_NOW_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const next: ActiveNowEntry[] = [];
    parsed.forEach((item) => {
      const sessionId = typeof item === 'string'
        ? item
        : (item && typeof item === 'object' && 'sessionId' in item && typeof item.sessionId === 'string' ? item.sessionId : null);
      if (!sessionId || seen.has(sessionId)) {
        return;
      }
      seen.add(sessionId);
      next.push({ sessionId });
    });
    return next;
  } catch {
    return [];
  }
};

export const persistActiveNowEntries = (storage: Storage, entries: ActiveNowEntry[]): void => {
  try {
    storage.setItem(ACTIVE_NOW_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignored
  }
};

export const pruneActiveNowEntries = (
  entries: ActiveNowEntry[],
  sessionsById: Map<string, Session>,
  now = Date.now(),
): ActiveNowEntry[] => {
  const minUpdatedAt = now - ACTIVE_NOW_MAX_AGE_MS;
  return entries.filter((entry) => {
    const session = sessionsById.get(entry.sessionId);
    if (!session) {
      return true;
    }
    if (isArchivedSession(session)) {
      return false;
    }
    return getSessionUpdatedAt(session) >= minUpdatedAt;
  });
};

export const addActiveNowSession = (entries: ActiveNowEntry[], sessionId: string): ActiveNowEntry[] => {
  if (!sessionId || entries.some((entry) => entry.sessionId === sessionId)) {
    return entries;
  }
  return [{ sessionId }, ...entries];
};

export const deriveActiveNowSessions = (
  entries: ActiveNowEntry[],
  sessionsById: Map<string, Session>,
): Session[] => {
  const sessions = entries
    .map((entry) => sessionsById.get(entry.sessionId) ?? null)
    .filter((session): session is Session => Boolean(session))
    .filter((session) => !isArchivedSession(session))
    .filter((session) => !isSubtaskSession(session));
  return sortSessionsByUpdated(sessions);
};

export const deriveLiveActiveNowSessions = (
  sessions: Session[],
  statuses: Record<string, SessionStatus>,
): Session[] => {
  const activeSessions = sessions.filter((session) => {
    if (isArchivedSession(session) || isSubtaskSession(session)) {
      return false;
    }

    const status = statuses[session.id];
    return status?.type === 'busy' || status?.type === 'retry';
  });

  return sortSessionsByUpdated(activeSessions);
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

/**
 * Apply manual order: sessions in manualOrder appear first (in their stored order),
 * remaining sessions follow sorted by updatedAt descending (original behavior).
 */
export function applyManualRecentOrder(
  sessions: Session[],
  manualOrder: string[],
): Session[] {
  if (manualOrder.length === 0) return sessions;

  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const ordered: Session[] = [];
  const seen = new Set<string>();

  // First: sessions in manual order (preserving manual sequence)
  for (const id of manualOrder) {
    const session = sessionMap.get(id);
    if (session) {
      ordered.push(session);
      seen.add(id);
    }
  }

  // Then: remaining sessions in original (time-sorted) order
  for (const session of sessions) {
    if (!seen.has(session.id)) {
      ordered.push(session);
    }
  }

  return ordered;
}
