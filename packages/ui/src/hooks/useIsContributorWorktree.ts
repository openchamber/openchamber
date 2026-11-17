import { normalizePath } from '@/lib/pathNormalization';
import { findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const useIsContributorWorktree = (directory: string | null | undefined): boolean =>
  useSessionUIStore((state) => {
    const target = normalizePath(directory ?? null);
    if (!target) return false;
    for (const worktrees of state.availableWorktreesByProject.values()) {
      if (findWorktreeHoldingDirectory(worktrees, target)?.provenance?.kind === 'contributor-fork') return true;
    }
    return false;
  });
