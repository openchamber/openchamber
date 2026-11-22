import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { useShallow } from 'zustand/react/shallow';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAllLiveSessions } from '@/sync/sync-context';
import { buildChildrenIndex, computeSubtreeCost } from './subagentCost';

export type SubagentCostRollup = {
  totalCost: number | null;
  ownCost: number;
  subagentCost: number;
  subagentCount: number;
};

const EMPTY_ROLLUP: SubagentCostRollup = {
  totalCost: null,
  ownCost: 0,
  subagentCost: 0,
  subagentCount: 0,
};

function countDescendants(id: string, childrenByParent: Map<string, Session[]>, visited: Set<string>): number {
  if (visited.has(id)) return 0;
  visited.add(id);
  let count = 0;
  for (const kid of childrenByParent.get(id) ?? []) {
    // A kid that is already visited closes a parent cycle; it is counted at
    // its first visit, not again here.
    if (visited.has(kid.id)) continue;
    count += 1 + countDescendants(kid.id, childrenByParent, visited);
  }
  return count;
}

export function computeRollup(liveSessions: Session[], sessionId: string | null): SubagentCostRollup {
  if (!sessionId) return EMPTY_ROLLUP;

  const sessionsById = new Map(liveSessions.map((session) => [session.id, session]));
  if (!sessionsById.has(sessionId)) return EMPTY_ROLLUP;

  const childrenByParent = buildChildrenIndex(liveSessions);
  const totalCost = computeSubtreeCost(sessionId, sessionsById, childrenByParent);

  // One visited set, seeded with the root, is shared across the per-child
  // walks: a fresh set per child lets a walk climb back through a parent
  // cycle and count the root's own cost as subagent spend.
  const visited = new Set<string>([sessionId]);
  const subagentCost = (childrenByParent.get(sessionId) ?? [])
    .reduce((sum, child) => sum + computeSubtreeCost(child.id, sessionsById, childrenByParent, visited), 0);

  const ownCost = totalCost - subagentCost;
  const subagentCount = countDescendants(sessionId, childrenByParent, new Set());

  return { totalCost, ownCost, subagentCost, subagentCount };
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

export function useSubagentCostRollup(sessionId: string | null): SubagentCostRollup {
  const sessions = useSessionsWithListedChildren(sessionId);
  return React.useMemo(() => computeRollup(sessions, sessionId), [sessions, sessionId]);
}
