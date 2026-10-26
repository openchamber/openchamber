import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

/**
 * Which descendants an action reaches below a session.
 *
 * - `active`: active sessions, stopping at an archived one and everything
 *   under it, the tree the project sidebar renders. Move and export.
 * - `activeThroughArchived`: active sessions at any depth, also under an
 *   archived intermediate. Archive, which must not restamp an archived one.
 * - `all`: every session at any depth, archived ones included. Delete.
 * - `archived`: archived sessions, stopping at an active one. Restore, which
 *   brings back the archived subsessions of a root.
 */
type SessionLineagePolicy = 'active' | 'activeThroughArchived' | 'all' | 'archived';

type SessionLineage = {
  /** The descendants of `rootId` under `policy`, each parent before its children. */
  descendantsOf: (rootId: string, policy: SessionLineagePolicy) => Session[];
};

const isArchived = (session: Session): boolean => Boolean(session.time?.archived);

const walks = {
  active: (session) => !isArchived(session),
  activeThroughArchived: () => true,
  all: () => true,
  archived: isArchived,
} satisfies Record<SessionLineagePolicy, (session: Session) => boolean>;

const keeps = {
  active: (session) => !isArchived(session),
  activeThroughArchived: (session) => !isArchived(session),
  all: () => true,
  archived: isArchived,
} satisfies Record<SessionLineagePolicy, (session: Session) => boolean>;

/**
 * The parent-child graph of `sessions`, indexed once. Build it once per
 * action, or once per pass over many roots.
 */
export const createSessionLineage = (sessions: readonly Session[]): SessionLineage => {
  const childrenByParentId = new Map<string, Session[]>();
  for (const session of sessions) {
    const parentId = session.parentID;
    if (!parentId) continue;
    const siblings = childrenByParentId.get(parentId);
    if (siblings) siblings.push(session);
    else childrenByParentId.set(parentId, [session]);
  }

  return {
    descendantsOf: (rootId, policy) => {
      const walk = walks[policy];
      const keep = keeps[policy];
      const descendants: Session[] = [];
      const visited = new Set<string>([rootId]);
      const visit = (parentId: string): void => {
        for (const child of childrenByParentId.get(parentId) ?? []) {
          if (visited.has(child.id) || !walk(child)) continue;
          visited.add(child.id);
          if (keep(child)) descendants.push(child);
          visit(child.id);
        }
      };
      visit(rootId);
      return descendants;
    },
  };
};

/**
 * The lineage of every session the client knows, active and archived, read
 * from the global cache when the user acts. A sidebar row may render its
 * session with no children (In work, Pinned, the List view), so an action
 * never takes its descendants from the row.
 */
export const readGlobalSessionLineage = (): SessionLineage => {
  const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
  return createSessionLineage([...activeSessions, ...archivedSessions]);
};
