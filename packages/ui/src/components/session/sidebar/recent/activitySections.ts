import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from '../types';
import type { SidebarSessionLocation } from './sessionLocation';

type SidebarActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null; inSpace?: boolean } | null;
  getSecondaryMeta?: (sessionId: string) => SidebarActivityItem['secondaryMeta'];
};

// The timeline and In work filter their own lists with the sidebar's rule:
// an exact `ses_` id, otherwise a case-insensitive title match.
const matchesSidebarSessionQuery = (session: Session, query: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (normalizedQuery.startsWith('ses_')) return session.id.toLowerCase() === normalizedQuery;
  const title = typeof session.title === 'string' ? session.title.toLowerCase() : '';
  return title.includes(query);
};

/**
 * Whether a session tree answers a sidebar query: its root or any session
 * below it. Search lists a tree in work only in the work block, so that block
 * must keep a root whose subsession is the match, or the match disappears
 * from the sidebar entirely.
 */
export const sessionTreeMatchesSidebarQuery = (node: SessionNode, query: string): boolean => (
  matchesSidebarSessionQuery(node.session, query)
  || node.children.some((child) => sessionTreeMatchesSidebarQuery(child, query))
);

/** Sessions in a tree that answer the query themselves, ancestors kept only as context excluded. */
export const countSessionTreeQueryMatches = (node: SessionNode, query: string): number => (
  (matchesSidebarSessionQuery(node.session, query) ? 1 : 0)
  + node.children.reduce((total, child) => total + countSessionTreeQueryMatches(child, query), 0)
);

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
      inSpace: location?.inSpace ?? false,
    },
  }];
});
