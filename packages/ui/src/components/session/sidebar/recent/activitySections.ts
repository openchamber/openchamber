import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';

export type RecentSessionLocation = {
  projectId: string | null;
  groupDirectory: string | null;
  projectLabel: string | null;
  branchLabel: string | null;
};

type RecentActivitySection = {
  key: 'active-now';
  items: Array<{
    node: SessionNode;
    projectId: string | null;
    groupDirectory: string | null;
    secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null;
  }>;
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

// Recent contains non-archived root sessions that are active now or were
// updated within the retention window. The caller applies shared lifecycle
// ordering after this membership filter; batching ("Show more") handles long
// windows in the UI.
export const deriveRecentSessions = (
  sessions: Session[],
  activeSessionIds: ReadonlySet<string>,
  now = Date.now(),
): Session[] => {
  const minUpdatedAt = now - RECENT_SESSION_MAX_AGE_MS;
  return sessions.filter((session) => {
    if (isArchivedSession(session) || isSubtaskSession(session)) {
      return false;
    }
    return activeSessionIds.has(session.id) || getSessionUpdatedAt(session) >= minUpdatedAt;
  });
};

export const deriveRecentActivitySections = ({
  sessions,
  getSessionLocation,
  getSessionNode,
  query,
}: {
  sessions: Session[];
  getSessionLocation: (sessionId: string) => RecentSessionLocation | null;
  getSessionNode?: (session: Session) => SessionNode;
  query: string;
}): RecentActivitySection[] => [{
  key: 'active-now',
  items: sessions.flatMap((session) => {
    const title = typeof session.title === 'string' ? session.title.toLowerCase() : '';
    if (query && !title.includes(query)) return [];
    const location = getSessionLocation(session.id);
    return [{
      node: getSessionNode?.(session) ?? { session, children: [], worktree: null },
      projectId: location?.projectId ?? null,
      groupDirectory: location?.groupDirectory ?? session.directory ?? null,
      secondaryMeta: location ? {
        projectLabel: location.projectLabel,
        branchLabel: location.branchLabel,
      } : null,
    }];
  }),
}];
