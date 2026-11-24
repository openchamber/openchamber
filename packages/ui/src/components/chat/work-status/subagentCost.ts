import type { Session } from '@/lib/opencode/model';

const trimZeros = (value: string): string =>
  (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

export const formatCost = (cost: number): string => `$${trimZeros(cost.toFixed(4))}`;

export type SessionTree = {
  readSession: (sessionId: string) => Session | undefined;
  childIdsOf: (sessionId: string) => readonly string[] | undefined;
};

export function computeSubtreeCost(id: string, tree: SessionTree, visited: Set<string> = new Set()): number {
  if (visited.has(id)) return 0;
  visited.add(id);

  let total = tree.readSession(id)?.cost ?? 0;
  for (const childId of tree.childIdsOf(id) ?? []) {
    total += computeSubtreeCost(childId, tree, visited);
  }
  return total;
}
