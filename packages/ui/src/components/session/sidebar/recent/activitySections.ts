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

// The zones filter their own lists with the sidebar's rule:
// an exact `ses_` id, otherwise a case-insensitive title match.
const matchesSidebarSessionQuery = (session: Session, query: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (normalizedQuery.startsWith('ses_')) return session.id.toLowerCase() === normalizedQuery;
  const title = typeof session.title === 'string' ? session.title.toLowerCase() : '';
  return title.includes(query);
};

/**
 * The part of a tree a search shows: a matching session with everything under
 * it, otherwise only the branches that lead to a match, as project groups
 * filter theirs. Null when nothing in the tree matches.
 */
export const pruneSessionTreeForSidebarQuery = (node: SessionNode, query: string): SessionNode | null => {
  if (matchesSidebarSessionQuery(node.session, query)) return node;
  const children = node.children.flatMap((child) => {
    const pruned = pruneSessionTreeForSidebarQuery(child, query);
    return pruned ? [pruned] : [];
  });
  return children.length > 0 ? { ...node, children } : null;
};

/** Sessions in a tree that answer the query themselves, ancestors kept only as context excluded. */
export const countSessionTreeQueryMatches = (node: SessionNode, query: string): number => (
  (matchesSidebarSessionQuery(node.session, query) ? 1 : 0)
  + node.children.reduce((total, child) => total + countSessionTreeQueryMatches(child, query), 0)
);

/**
 * The Pinned or In work sessions a search lists, with the matches each one
 * counts. `'tree'` looks through the whole session tree, since one-line zone
 * rows open to the match and search lists these sessions nowhere else.
 * `'session'` matches the session itself only.
 */
export const matchZoneSessionsForSidebarQuery = (
  zone: readonly Session[],
  getTree: (session: Session) => SessionNode,
  query: string,
  scope: 'tree' | 'session',
) => {
  const matchCountById = new Map<string, number>();
  if (!query) return { sessions: [...zone], matchCountById };
  const sessions = zone.filter((session) => {
    const matches = scope === 'tree'
      ? countSessionTreeQueryMatches(getTree(session), query)
      : Number(matchesSidebarSessionQuery(session, query));
    if (matches > 0) matchCountById.set(session.id, matches);
    return matches > 0;
  });
  return { sessions, matchCountById };
};

// The rows of a zone's sessions. Ordering, membership, and branch/project
// metadata are resolved by the caller; this projection only applies the
// search filter and shapes rows.
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
