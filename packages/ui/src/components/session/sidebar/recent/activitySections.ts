import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../types';
import type { SidebarSessionLocation } from './sessionLocation';

type RecentSessionLocation = SidebarSessionLocation;

type SidebarActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null;
  getSecondaryMeta?: (sessionId: string) => SidebarActivityItem['secondaryMeta'];
};

type RecentActivitySection = {
  key: 'active-now';
  items: SidebarActivityItem[];
};

// Recent and Timeline filter their own lists with the sidebar's rule: an
// exact `ses_` id, otherwise a case-insensitive title match.
const matchesSidebarSessionQuery = (session: Session, query: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (normalizedQuery.startsWith('ses_')) return session.id.toLowerCase() === normalizedQuery;
  const title = typeof session.title === 'string' ? session.title.toLowerCase() : '';
  return title.includes(query);
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

const attachRecentWorktrees = (
  node: SessionNode,
  getSessionLocation: (sessionId: string) => RecentSessionLocation | null,
): SessionNode => {
  const worktree = getSessionLocation(node.session.id)?.worktree ?? null;
  const children = node.children.map((child) => attachRecentWorktrees(child, getSessionLocation));
  if (worktree === node.worktree && children.every((child, index) => child === node.children[index])) {
    return node;
  }
  return { ...node, worktree, children };
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
    if (!matchesSidebarSessionQuery(session, query)) return [];
    const location = getSessionLocation(session.id);
    const node = getSessionNode?.(session) ?? { session, children: [], worktree: null };
    return [{
      node: attachRecentWorktrees(node, getSessionLocation),
      projectId: location?.projectId ?? null,
      groupDirectory: location?.groupDirectory ?? session.directory ?? null,
      secondaryMeta: location ? {
        projectLabel: location.projectLabel,
        branchLabel: location.branchLabel,
      } : null,
      getSecondaryMeta: (sessionId: string) => {
        const childLocation = getSessionLocation(sessionId);
        return childLocation ? {
          projectLabel: childLocation.projectLabel,
          branchLabel: childLocation.branchLabel,
        } : null;
      },
    }];
  }),
}];

// Timeline lists every non-archived root project session as one flat zone.
// Ordering, membership, and branch/project metadata are resolved by the
// caller; this projection only applies the search filter and shapes rows.
export const deriveTimelineActivityItems = ({
  sessions,
  getSessionLocation,
  getSessionNode,
  query,
}: {
  sessions: readonly Session[];
  getSessionLocation: (sessionId: string) => SidebarSessionLocation | null;
  getSessionNode: (session: Session) => SessionNode;
  query: string;
}): SidebarActivityItem[] => sessions.flatMap((session) => {
  if (!matchesSidebarSessionQuery(session, query)) return [];
  const location = getSessionLocation(session.id);
  return [{
    node: getSessionNode(session),
    projectId: location?.projectId ?? null,
    groupDirectory: location?.groupDirectory ?? session.directory ?? null,
    secondaryMeta: {
      projectLabel: location?.projectLabel ?? null,
      branchLabel: location?.branchLabel ?? null,
    },
  }];
});
