import type { Session } from '@opencode-ai/sdk/v2';

// Spend is read against a budget, so it keeps its real precision instead of
// collapsing to two decimals. Trailing zeros are dropped so exact values stay
// short. Relocated from WorkStatusPrimaryGroup.tsx so both that component and
// WorkStatusSubagentsSection share one implementation.
const trimZeros = (value: string): string =>
  (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

export const formatCost = (cost: number): string => `$${trimZeros(cost.toFixed(4))}`;

/**
 * Groups a flat live-session list by parentID. One pass, O(n). Sessions
 * without a parentID (roots) are simply absent as keys — callers look up a
 * specific id's children via `.get(id) ?? []`.
 */
export function buildChildrenIndex(sessions: Session[]): Map<string, Session[]> {
  const index = new Map<string, Session[]>();
  for (const session of sessions) {
    const parentID = session.parentID;
    if (!parentID) continue;
    const existing = index.get(parentID);
    if (existing) {
      existing.push(session);
    } else {
      index.set(parentID, [session]);
    }
  }
  return index;
}

function sessionCost(session: Session | undefined): number {
  return session?.cost ?? 0;
}

/**
 * Own cost plus every descendant's cost, recursively. Cycle-guarded with a
 * visited set: parentID should form a tree, but this does not trust that
 * invariant blindly (mirrors opencode-session-cost's src/cost.ts).
 */
export function computeSubtreeCost(
  id: string,
  sessionsById: Map<string, Session>,
  childrenByParent: Map<string, Session[]>,
  visited: Set<string> = new Set(),
): number {
  if (visited.has(id)) return 0;
  visited.add(id);

  let total = sessionCost(sessionsById.get(id));
  const children = childrenByParent.get(id) ?? [];
  for (const child of children) {
    total += computeSubtreeCost(child.id, sessionsById, childrenByParent, visited);
  }
  return total;
}
