import { normalizePath } from '@/lib/pathNormalization';
import { findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Whether `directory` is a worktree checked out from a contributor's fork.
 * Such a worktree tracks nothing and pushes only to a destination the user
 * picks, so its push control names that choice.
 */
export const useIsContributorWorktree = (directory: string | null | undefined): boolean =>
  useSessionUIStore((state) => {
    const target = normalizePath(directory ?? null);
    if (!target) return false;
    for (const worktrees of state.availableWorktreesByProject.values()) {
      if (findWorktreeHoldingDirectory(worktrees, target)?.provenance?.kind === 'contributor-fork') return true;
    }
    return false;
  });
