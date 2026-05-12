import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';
import { getCompatibleSessionArchivedAt, getCompatibleSessionParentId } from '@/sync/compat';

export const ACTIVE_NOW_STORAGE_KEY = 'oc.sessions.activeNow';
export const ACTIVE_NOW_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export type ActiveNowEntry = {
  sessionId: string;
};

const isSubtaskSession = (session: Session): boolean => {
  return Boolean(getCompatibleSessionParentId(session));
};

const isArchivedSession = (session: Session): boolean => {
  return Boolean(getCompatibleSessionArchivedAt(session));
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

export const sortSessionsByUpdated = (sessions: Session[]): Session[] => {
  return [...sessions].sort((a, b) => getSessionUpdatedAt(b) - getSessionUpdatedAt(a));
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

export const getSessionUpdatedAtMs = getSessionUpdatedAt;
