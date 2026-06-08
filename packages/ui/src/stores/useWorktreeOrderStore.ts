import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { WorktreeMetadata } from '@/types/worktree';

/**
 * Persisted display order for worktrees within a project, mirroring how
 * projects persist their order (the array position IS the order). Keyed by
 * project id, the value is an ordered list of normalized worktree paths.
 *
 * Worktrees come from git and are otherwise listed alphabetically; this store
 * lets the user reorder them (e.g. in the mobile project editor) and have that
 * order stick across restarts.
 */
type WorktreeOrderStore = {
  orderByProject: Record<string, string[]>;
  setWorktreeOrder: (projectId: string, orderedPaths: string[]) => void;
};

export const useWorktreeOrderStore = create<WorktreeOrderStore>()(
  persist(
    (set) => ({
      orderByProject: {},
      setWorktreeOrder: (projectId, orderedPaths) =>
        set((state) => ({ orderByProject: { ...state.orderByProject, [projectId]: orderedPaths } })),
    }),
    {
      name: 'mobile-worktree-order',
    },
  ),
);

const normalizeWorktreePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Stable-sort worktrees by a stored order of paths. Worktrees not present in
 * the stored order keep their incoming (alphabetical) order, appended after
 * the known ones.
 */
export const orderWorktrees = (
  orderedPaths: string[] | undefined,
  worktrees: WorktreeMetadata[],
): WorktreeMetadata[] => {
  if (!orderedPaths || orderedPaths.length === 0) return worktrees;
  const rank = new Map(orderedPaths.map((path, index) => [normalizeWorktreePath(path), index] as const));
  const rankOf = (worktree: WorktreeMetadata): number =>
    rank.get(normalizeWorktreePath(worktree.path)) ?? Number.MAX_SAFE_INTEGER;
  return worktrees
    .map((worktree, index) => ({ worktree, index }))
    .sort((a, b) => {
      const byRank = rankOf(a.worktree) - rankOf(b.worktree);
      // Preserve incoming order for ties (unknown worktrees / equal ranks).
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map((entry) => entry.worktree);
};
