import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

type SessionListLoader = (archived: boolean) => Promise<readonly Session[]>;

const loadAuthoritativeSessions: SessionListLoader = async (archived) => listGlobalSessionPages(
  opencodeClient.getSdkClient(),
  { archived, pageSize: 500 },
);

const normalizeDirectory = (directory: string | null | undefined): string =>
  (directory ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

const getParentID = (session: Session): string | null | undefined =>
  (session as Session & { parentID?: string | null }).parentID;

/** Deleting a session cascades to its descendants server-side, so a request that
    names only some of them understates what is destroyed. Expand the set with
    every known descendant, requested sessions first, so the confirmation the
    user sees and the IDs we execute both match what the server removes. */
export const expandSessionsWithDescendants = (
  requested: readonly Session[],
  knownSessions: readonly Session[],
): Session[] => {
  const childrenByParentId = new Map<string, Session[]>();
  for (const session of knownSessions) {
    const parentID = getParentID(session);
    if (!parentID) continue;
    const siblings = childrenByParentId.get(parentID);
    if (siblings) siblings.push(session);
    else childrenByParentId.set(parentID, [session]);
  }

  const expanded: Session[] = [];
  const seenIds = new Set<string>();
  // Breadth-first over a growing queue with a cursor: `shift()` would make this
  // quadratic on the thousands-of-sessions archives this runs against.
  const queue: Session[] = [...requested];
  for (let index = 0; index < queue.length; index += 1) {
    const session = queue[index];
    if (seenIds.has(session.id)) continue;
    seenIds.add(session.id);
    expanded.push(session);
    const children = childrenByParentId.get(session.id);
    if (children) queue.push(...children);
  }

  return expanded;
};

/** The "never ask" opt-out covers confirming a single session. A delete that
    removes more than one — because several were selected, or because the server
    cascade takes descendants with it — always confirms. */
export const requiresDeleteConfirmation = (showDeletionDialog: boolean, sessionCount: number): boolean =>
  showDeletionDialog || sessionCount > 1;

export const resolveAuthoritativeDeleteCascade = async (
  requested: readonly Session[],
  loadSessions: SessionListLoader = loadAuthoritativeSessions,
  options: { requireArchived?: boolean; worktreeDirectory?: string } = {},
): Promise<Session[]> => {
  const [active, archived] = await Promise.all([loadSessions(false), loadSessions(true)]);
  const activeIds = new Set(active.map((session) => session.id));
  if (archived.some((session) => activeIds.has(session.id))) {
    throw new Error('Session archive state changed while resolving the delete cascade');
  }
  const authoritative = [...active, ...archived];
  const byId = new Map(authoritative.map((session) => [session.id, session]));
  if (options.worktreeDirectory) {
    const directory = normalizeDirectory(options.worktreeDirectory);
    const roots = authoritative.filter((session) => (
      normalizeDirectory(resolveGlobalSessionDirectory(session)) === directory
    ));
    return expandSessionsWithDescendants(roots, authoritative)
      .filter((session) => !session.time?.archived);
  }
  return expandSessionsWithDescendants(requested.map((session) => {
    const current = byId.get(session.id);
    if (!current) throw new Error(`Session ${session.id} no longer exists`);
    if (options.requireArchived && !current.time?.archived) {
      throw new Error(`Session ${session.id} is no longer archived`);
    }
    return current;
  }), authoritative);
};

export const deleteCascadeChanged = (confirmed: readonly Session[], current: readonly Session[]): boolean => {
  if (confirmed.length !== current.length) return true;
  const currentIds = new Set(current.map((session) => session.id));
  return confirmed.some((session) => !currentIds.has(session.id));
};

export const getDeleteExecutionOrder = (cascade: readonly Session[]): Session[] => {
  const sessionsById = new Map(cascade.map((session) => [session.id, session]));
  const remainingChildren = new Map(cascade.map((session) => [session.id, 0]));
  for (const session of sessionsById.values()) {
    const parentID = getParentID(session);
    if (parentID && parentID !== session.id && sessionsById.has(parentID)) {
      remainingChildren.set(parentID, (remainingChildren.get(parentID) ?? 0) + 1);
    }
  }

  const queue = cascade.filter((session) => remainingChildren.get(session.id) === 0);
  const ordered: Session[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const session = queue[index];
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    ordered.push(session);
    const parentID = getParentID(session);
    if (!parentID || !sessionsById.has(parentID)) continue;
    const next = (remainingChildren.get(parentID) ?? 1) - 1;
    remainingChildren.set(parentID, next);
    if (next === 0) queue.push(sessionsById.get(parentID)!);
  }
  return ordered;
};

export const executeDeleteCascade = async (
  cascade: readonly Session[],
  deleteSession: (session: Session) => Promise<boolean>,
): Promise<{ deletedIds: string[]; failedIds: string[] }> => {
  const order = getDeleteExecutionOrder(cascade);
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  const blockedIds = new Set<string>();
  const sessionsById = new Map(cascade.map((session) => [session.id, session]));
  for (const session of order) {
    if (blockedIds.has(session.id)) {
      failedIds.push(session.id);
      continue;
    }
    if (await deleteSession(session)) {
      deletedIds.push(session.id);
      continue;
    }
    failedIds.push(session.id);
    const visited = new Set<string>();
    let parentID = getParentID(session);
    while (parentID && sessionsById.has(parentID) && !visited.has(parentID)) {
      visited.add(parentID);
      blockedIds.add(parentID);
      const parent = sessionsById.get(parentID);
      parentID = parent ? getParentID(parent) : undefined;
    }
  }
  const processedIds = new Set(order.map((session) => session.id));
  for (const session of cascade) {
    if (!processedIds.has(session.id) && !failedIds.includes(session.id)) failedIds.push(session.id);
  }
  return { deletedIds, failedIds };
};

export const createArchivedSessionDeleteRequest = (sessions: Session[]) => ({
  sessions: sessions.filter((session) => Boolean(session.time?.archived)),
  mode: 'session' as const,
  requireArchived: true,
});
