import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import { isSessionPinned } from '@/stores/useSessionPinnedStore';
import { countSyncPerformance } from './performance-diagnostics';

export type SessionActivityPhase = 'active' | 'settled';

export type SessionOrderingMutation =
  | { type: 'observe'; sessionId: string; phase: SessionActivityPhase }
  | { type: 'remove'; sessionId: string };

type SessionOrderingState = {
  rankById: Map<string, number>;
};

export const EMPTY_SESSION_ORDER_RANKS: ReadonlyMap<string, number> = new Map();

const phaseById = new Map<string, SessionActivityPhase>();
const baselineRankById = new Map<string, { created?: number; updated?: number }>();
let lastRank = 0;

export const useSessionOrderingStore = create<SessionOrderingState>(() => ({
  rankById: new Map(),
}));
useSessionOrderingStore.subscribe(() => countSyncPerformance('orderingPublications'));

const nextRank = (): number => {
  lastRank = Math.max(lastRank + 1, Date.now());
  return lastRank;
};

const promoteSessions = (sessionIds: Iterable<string>, useSharedRank = false): void => {
  const ids = [...sessionIds];
  if (ids.length === 0) return;

  useSessionOrderingStore.setState((state) => {
    const rankById = new Map(state.rankById);
    const sharedRank = useSharedRank ? nextRank() : null;
    for (const sessionId of ids) {
      rankById.set(sessionId, sharedRank ?? nextRank());
    }
    return { rankById };
  });
};

export const observeSessionActivityEvent = (
  sessionId: string,
  phase: SessionActivityPhase,
): void => {
  applySessionOrderingMutations([{ type: 'observe', sessionId, phase }]);
};

export const applySessionOrderingMutations = (
  mutations: readonly SessionOrderingMutation[],
): void => {
  if (mutations.length === 0) return;
  const currentRanks = useSessionOrderingStore.getState().rankById;
  let rankById: Map<string, number> | null = null;

  for (const mutation of mutations) {
    if (mutation.type === 'remove') {
      phaseById.delete(mutation.sessionId);
      baselineRankById.delete(mutation.sessionId);
      if ((rankById ?? currentRanks).has(mutation.sessionId)) {
        rankById ??= new Map(currentRanks);
        rankById.delete(mutation.sessionId);
      }
      continue;
    }

    const previous = phaseById.get(mutation.sessionId);
    phaseById.set(mutation.sessionId, mutation.phase);
    if (previous === mutation.phase) continue;
    if (previous === undefined && mutation.phase === 'settled') continue;
    rankById ??= new Map(currentRanks);
    rankById.set(mutation.sessionId, nextRank());
  }

  if (rankById) useSessionOrderingStore.setState({ rankById });
};

export const reconcileSessionActivitySnapshot = (
  activeSessionIds: Iterable<string>,
  knownSessionIds: Iterable<string>,
): void => {
  const active = new Set(activeSessionIds);
  const observed = new Set([...knownSessionIds, ...active]);
  const promoted: string[] = [];

  for (const sessionId of observed) {
    const phase: SessionActivityPhase = active.has(sessionId) ? 'active' : 'settled';
    const previous = phaseById.get(sessionId);
    phaseById.set(sessionId, phase);
    if (previous !== undefined && previous !== phase) promoted.push(sessionId);
  }

  // A snapshot cannot recover the order of missed transitions. Give the batch
  // one rank and let authoritative timestamps break ties deterministically.
  promoteSessions(promoted, true);
};

export const removeSessionOrdering = (sessionId: string): void => {
  applySessionOrderingMutations([{ type: 'remove', sessionId }]);
};

export const resetSessionOrdering = (): void => {
  phaseById.clear();
  baselineRankById.clear();
  lastRank = 0;
  useSessionOrderingStore.setState({ rankById: new Map() });
};

const finiteTime = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const updatedAt = (session: Session): number => (
  finiteTime(session.time?.updated) || finiteTime(session.time?.created)
);

const createdAt = (session: Session): number => finiteTime(session.time?.created);

const parentIdOf = (session: Session): string | null => (
  (session as Session & { parentID?: string | null }).parentID ?? null
);

const sessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return record.directory ?? record.project?.worktree ?? null;
};

const baselineRank = (session: Session, pinned: boolean): number => {
  const existing = baselineRankById.get(session.id);
  const key = pinned ? 'created' : 'updated';
  const existingRank = existing?.[key];
  if (existingRank !== undefined) return existingRank;
  const rank = pinned ? createdAt(session) : updatedAt(session);
  baselineRankById.set(session.id, { ...existing, [key]: rank });
  return rank;
};

/**
 * Raise cached baselines to the sessions' current authoritative timestamps.
 *
 * The frozen baseline keeps live metadata churn from reordering an open list,
 * but a client that slept through a session's whole active→settled cycle never
 * saw the transition that would have promoted its live rank — so its stale
 * baseline pins it in place forever. Call this when an authoritative session
 * SNAPSHOT arrives (global refresh); monotonic, so it can never demote.
 */
export const raiseSessionOrderingBaselines = (sessions: Iterable<Session>): void => {
  const currentRanks = useSessionOrderingStore.getState().rankById;
  let nextRanks: Map<string, number> | null = null;
  let baselinesChanged = false;

  for (const session of sessions) {
    const fresh = updatedAt(session);
    const liveRank = currentRanks.get(session.id);
    if (liveRank !== undefined) {
      // A live rank frozen BEFORE this newer authoritative stamp is stale —
      // the session was active again while this client wasn't watching (its
      // transition events never arrived, e.g. another device + sleep). Ranks
      // share the epoch-ms scale with `updated`, so raising is well-ordered.
      if (fresh > liveRank) {
        nextRanks = nextRanks ?? new Map(currentRanks);
        nextRanks.set(session.id, fresh);
      }
      continue;
    }
    const existing = baselineRankById.get(session.id);
    if (existing?.updated !== undefined && existing.updated >= fresh) continue;
    baselineRankById.set(session.id, { ...existing, updated: fresh });
    baselinesChanged = true;
  }

  if (nextRanks) {
    useSessionOrderingStore.setState({ rankById: nextRanks });
  } else if (baselinesChanged) {
    // Baselines live outside the store; nudge subscribers so open lists re-sort.
    useSessionOrderingStore.setState((state) => ({ rankById: new Map(state.rankById) }));
  }
};

export const getSessionLifecycleOrderValue = (
  session: Session,
  rankById: ReadonlyMap<string, number>,
  pinned = false,
): number => rankById.get(session.id) ?? baselineRank(session, pinned);

export const compareSessionsByLifecycleOrder = (
  left: Session,
  right: Session,
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
): number => {
  const leftPinned = isSessionPinned(pinnedSessionIds, sessionDirectory(left), left.id);
  const rightPinned = isSessionPinned(pinnedSessionIds, sessionDirectory(right), right.id);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

  const leftFallback = baselineRank(left, leftPinned);
  const rightFallback = baselineRank(right, rightPinned);
  if (parentIdOf(left) === parentIdOf(right)) {
    const rankDelta = getSessionLifecycleOrderValue(right, rankById, rightPinned)
      - getSessionLifecycleOrderValue(left, rankById, leftPinned);
    if (rankDelta !== 0) return rankDelta;
  }

  const baselineDelta = rightFallback - leftFallback;
  if (baselineDelta !== 0) return baselineDelta;
  const createdDelta = baselineRank(right, true) - baselineRank(left, true);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
};

export const orderSessionsByLifecycleScopes = (
  sessions: Session[],
  pinnedSessionIds: Set<string>,
  rankById: ReadonlyMap<string, number>,
  hierarchy?: {
    rootIds: readonly string[];
    childrenByParentId: ReadonlyMap<string, readonly string[]>;
  },
): Session[] => {
  countSyncPerformance('sidebarOrderBuilds');
  const sessionIds = new Set(sessions.map((session) => session.id));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const roots: Session[] = [];
  const childrenByParent = new Map<string, Session[]>();
  const indexedIds = new Set<string>();

  if (hierarchy) {
    for (const sessionId of hierarchy.rootIds) {
      const session = sessionById.get(sessionId);
      if (!session) continue;
      indexedIds.add(sessionId);
      roots.push(session);
    }
    for (const [parentId, childIds] of hierarchy.childrenByParentId) {
      if (!sessionIds.has(parentId)) continue;
      const children = childIds.flatMap((sessionId) => {
        const session = sessionById.get(sessionId);
        if (!session) return [];
        indexedIds.add(sessionId);
        return [session];
      });
      if (children.length > 0) childrenByParent.set(parentId, children);
    }
  }

  for (const session of sessions) {
    if (indexedIds.has(session.id)) continue;
    const parentId = parentIdOf(session);
    if (!parentId || !sessionIds.has(parentId)) {
      roots.push(session);
      continue;
    }

    const siblings = childrenByParent.get(parentId);
    if (siblings) {
      siblings.push(session);
    } else {
      childrenByParent.set(parentId, [session]);
    }
  }

  const metadataById = new Map(sessions.map((session) => {
    const parentId = parentIdOf(session);
    const pinned = isSessionPinned(pinnedSessionIds, sessionDirectory(session), session.id);
    const fallback = baselineRank(session, pinned);
    return [session.id, {
      parentId,
      pinned,
      fallback,
      lifecycle: rankById.get(session.id) ?? fallback,
      created: baselineRank(session, true),
    }] as const;
  }));
  countSyncPerformance('sidebarOrderMetadataEntries', metadataById.size);
  const compare = (left: Session, right: Session): number => {
    const leftMetadata = metadataById.get(left.id);
    const rightMetadata = metadataById.get(right.id);
    if (!leftMetadata || !rightMetadata) return left.id.localeCompare(right.id);
    if (leftMetadata.pinned !== rightMetadata.pinned) return leftMetadata.pinned ? -1 : 1;
    if (leftMetadata.parentId === rightMetadata.parentId) {
      const rankDelta = rightMetadata.lifecycle - leftMetadata.lifecycle;
      if (rankDelta !== 0) return rankDelta;
    }
    const baselineDelta = rightMetadata.fallback - leftMetadata.fallback;
    if (baselineDelta !== 0) return baselineDelta;
    const createdDelta = rightMetadata.created - leftMetadata.created;
    if (createdDelta !== 0) return createdDelta;
    return left.id.localeCompare(right.id);
  };
  roots.sort(compare);
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compare);
  }

  const ordered: Session[] = [];
  const visited = new Set<string>();
  const append = (session: Session): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    ordered.push(session);
    for (const child of childrenByParent.get(session.id) ?? []) {
      append(child);
    }
  };
  for (const root of roots) {
    append(root);
  }
  const remaining = sessions.filter((session) => !visited.has(session.id)).sort(compare);
  for (const session of remaining) {
    append(session);
  }
  return ordered;
};
