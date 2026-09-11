import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useAllLiveSessions, useDirectoryStore } from '@/sync/sync-context';
import { buildChildrenIndex, computeSubtreeCost } from './subagentCost';

export type SubagentCostRollup = {
  totalCost: number | null;
  /** The root session's own spend, excluding every subagent. */
  ownCost: number;
  /** Everything the subagents cost between them: `totalCost - ownCost`. */
  subagentCost: number;
  subagentCount: number;
  perChildCost: Map<string, number>;
};

const EMPTY_ROLLUP: SubagentCostRollup = {
  totalCost: null,
  ownCost: 0,
  subagentCost: 0,
  subagentCount: 0,
  perChildCost: new Map(),
};

function countDescendants(id: string, childrenByParent: Map<string, Session[]>, visited: Set<string>): number {
  if (visited.has(id)) return 0;
  visited.add(id);
  const kids = childrenByParent.get(id) ?? [];
  let count = kids.length;
  for (const kid of kids) count += countDescendants(kid.id, childrenByParent, visited);
  return count;
}

/**
 * Pure core of useSubagentCostRollup, kept separate so it can be unit-tested
 * directly against a plain session array instead of rendering the hook.
 */
export function computeRollup(liveSessions: Session[], sessionId: string | null): SubagentCostRollup {
  if (!sessionId) return EMPTY_ROLLUP;

  const sessionsById = new Map(liveSessions.map((session) => [session.id, session]));
  if (!sessionsById.has(sessionId)) return EMPTY_ROLLUP;

  const childrenByParent = buildChildrenIndex(liveSessions);
  const totalCost = computeSubtreeCost(sessionId, sessionsById, childrenByParent);

  const perChildCost = new Map<string, number>();
  let subagentCost = 0;
  for (const child of childrenByParent.get(sessionId) ?? []) {
    const childSubtree = computeSubtreeCost(child.id, sessionsById, childrenByParent);
    perChildCost.set(child.id, childSubtree);
    subagentCost += childSubtree;
  }

  // Derived by subtraction rather than read back off the session, so the split
  // always adds up to the total the panel shows even if a cycle guard trimmed
  // part of the walk.
  const ownCost = totalCost - subagentCost;
  const subagentCount = countDescendants(sessionId, childrenByParent, new Set());

  return { totalCost, ownCost, subagentCost, subagentCount, perChildCost };
}

/**
 * Own cost plus every descendant subagent's cost, recursively summed, for a
 * given root session. Reads the aggregate `useAllLiveSessions()` subscription;
 * callers with a known directory should prefer `useDirectorySubagentCostRollup`,
 * which does not react to unrelated directories' sessions.
 */
export function useSubagentCostRollup(sessionId: string | null): SubagentCostRollup {
  const liveSessions = useAllLiveSessions();
  return React.useMemo(() => computeRollup(liveSessions, sessionId), [liveSessions, sessionId]);
}

/**
 * Value-equality for two rollups. `computeRollup` always allocates a fresh
 * `perChildCost` map and object, so reference equality alone would treat an
 * unchanged subtree as new whenever any session in the store is republished.
 */
function areRollupsEqual(left: SubagentCostRollup, right: SubagentCostRollup): boolean {
  if (left === right) return true;
  if (
    left.totalCost !== right.totalCost
    || left.ownCost !== right.ownCost
    || left.subagentCost !== right.subagentCost
    || left.subagentCount !== right.subagentCount
    || left.perChildCost.size !== right.perChildCost.size
  ) {
    return false;
  }
  for (const [childId, cost] of left.perChildCost) {
    if (right.perChildCost.get(childId) !== cost) return false;
  }
  return true;
}

/**
 * Directory-scoped rollup for one session's subtree. Unlike
 * `useSubagentCostRollup`, it reads a single directory store and subscribes only
 * to that store's `session` slice, so an unrelated session's `time.updated`
 * bump never reaches this hook. The snapshot is cached and value-compared, so a
 * new `session` array holding the same costs still returns the previous
 * reference and React bails out before the consumer re-renders.
 */
export function useDirectorySubagentCostRollup(
  sessionId: string | null,
  directory?: string | null,
): SubagentCostRollup {
  const store = useDirectoryStore(directory ?? undefined);
  const cacheRef = React.useRef<SubagentCostRollup | null>(null);

  const getSnapshot = React.useCallback((): SubagentCostRollup => {
    const next = computeRollup(store.getState().session, sessionId);
    const cached = cacheRef.current;
    if (cached && areRollupsEqual(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [store, sessionId]);

  const subscribe = React.useCallback((notify: () => void) => store.subscribe((state, previous) => {
    if (state.session !== previous.session) notify();
  }), [store]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
