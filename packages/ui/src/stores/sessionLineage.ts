import type { Session } from '@/lib/opencode/model';
import { getOriginalSessionID, isReviewSession } from '@/lib/sessionReviewMetadata';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

type SessionLineagePolicy = 'active' | 'activeThroughArchived' | 'all' | 'archived';

type SessionLineage = {
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

export const createSessionLineage = (sessions: readonly Session[]): SessionLineage => {
  const childrenByParentId = new Map<string, Session[]>();
  const reviewsByOriginalId = new Map<string, Session[]>();
  for (const session of sessions) {
    const parentId = session.parentID ?? (isReviewSession(session) ? getOriginalSessionID(session) : null);
    if (!parentId) continue;
    const index = session.parentID ? childrenByParentId : reviewsByOriginalId;
    const siblings = index.get(parentId);
    if (siblings) siblings.push(session);
    else index.set(parentId, [session]);
  }

  return {
    descendantsOf: (rootId, policy) => {
      const walk = walks[policy];
      const keep = keeps[policy];
      const descendants: Session[] = [];
      const visited = new Set<string>([rootId]);
      const visit = (parentId: string): void => {
        const children = childrenByParentId.get(parentId) ?? [];
        const reviews = policy === 'active' ? [] : reviewsByOriginalId.get(parentId) ?? [];
        for (const child of [...children, ...reviews]) {
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

export const readGlobalSessionLineage = (): SessionLineage => {
  const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
  return createSessionLineage([...activeSessions, ...archivedSessions]);
};
