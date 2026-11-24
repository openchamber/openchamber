import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useShallow } from 'zustand/react/shallow';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { readSessionCostTree, useDeferredGlobalUpdates } from '@/sync/session-event-router';
import { useAllLiveSessions, useSyncRuntime } from '@/sync/sync-context';
import { computeSubtreeCost, type SessionTree } from './subagentCost';

export type SubagentCostRollup = {
  totalCost: number | null;
  ownCost: number;
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

function countDescendants(id: string, tree: SessionTree, visited: Set<string>): number {
  if (visited.has(id)) return 0;
  visited.add(id);
  const kids = tree.childIdsOf(id) ?? [];
  let count = kids.length;
  for (const kid of kids) count += countDescendants(kid, tree, visited);
  return count;
}

export function computeRollup(tree: SessionTree, sessionId: string | null): SubagentCostRollup {
  if (!sessionId || !tree.readSession(sessionId)) return EMPTY_ROLLUP;

  const totalCost = computeSubtreeCost(sessionId, tree);

  const perChildCost = new Map<string, number>();
  let subagentCost = 0;
  for (const childId of tree.childIdsOf(sessionId) ?? []) {
    const childSubtree = computeSubtreeCost(childId, tree);
    perChildCost.set(childId, childSubtree);
    subagentCost += childSubtree;
  }

  const ownCost = totalCost - subagentCost;
  const subagentCount = countDescendants(sessionId, tree, new Set());

  return { totalCost, ownCost, subagentCost, subagentCount, perChildCost };
}

const NO_SESSIONS: Session[] = [];

export function useSessionsWithListedChildren(sessionId: string | null): Session[] {
  const liveSessions = useAllLiveSessions();
  const listedChildren = useGlobalSessionsStore(useShallow((state) => {
    const childIds = sessionId ? state.structure.activeChildrenByParentId.get(sessionId) : undefined;
    if (!childIds) return NO_SESSIONS;
    return childIds.flatMap((id) => {
      const child = state.entityById.get(id);
      return child ? [child] : [];
    });
  }));
  return React.useMemo(() => {
    if (listedChildren.length === 0) return liveSessions;
    const listedById = new Map(listedChildren.map((child) => [child.id, child]));
    const merged = liveSessions.map((session) => {
      const listed = listedById.get(session.id);
      if (!listed) return session;
      listedById.delete(session.id);
      return session.model || !listed.model ? session : { ...session, agent: session.agent ?? listed.agent, model: listed.model };
    });
    return [...merged, ...listedById.values()];
  }, [listedChildren, liveSessions]);
}

type SessionSlices = ReadonlyArray<readonly [string, readonly Session[]]>;

const sameSlices = (left: SessionSlices, right: SessionSlices): boolean => (
  left.length === right.length
  && left.every(([directory, sessions], index) => right[index][0] === directory && right[index][1] === sessions)
);

function useDirectorySessionSlices(): SessionSlices {
  const { childStores } = useSyncRuntime();
  const cacheRef = React.useRef<SessionSlices | null>(null);
  const getSnapshot = React.useCallback(() => {
    const next = Array.from(childStores.children, ([directory, store]) => [directory, store.getState().session] as const);
    const cached = cacheRef.current;
    if (cached && sameSlices(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [childStores]);
  const subscribe = React.useCallback(
    (notify: () => void) => childStores.subscribeAllSelected((state) => state.session, notify),
    [childStores],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useSessionCostTree(): SessionTree {
  const entityById = useGlobalSessionsStore((state) => state.entityById);
  const structure = useGlobalSessionsStore((state) => state.structure);
  const deferred = useDeferredGlobalUpdates();
  const slices = useDirectorySessionSlices();
  return React.useMemo(
    () => readSessionCostTree({ entityById, structure }, deferred, slices),
    [deferred, entityById, slices, structure],
  );
}

export function useSubagentCostRollup(sessionId: string | null): SubagentCostRollup {
  const tree = useSessionCostTree();
  return React.useMemo(() => computeRollup(tree, sessionId), [tree, sessionId]);
}
