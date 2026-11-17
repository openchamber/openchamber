import type { Session } from '@/lib/opencode/model';

const trimZeros = (value: string): string =>
  (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

export const formatCost = (cost: number): string => `$${trimZeros(cost.toFixed(4))}`;

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
