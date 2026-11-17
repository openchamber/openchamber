import { normalizePath } from '@/lib/pathNormalization';
import { checkoutHoldsDirectory } from '@/lib/worktrees/worktreePaths';

const ARCHIVED_SCOPE_PREFIX = '__archived__:';

export const getArchivedScopeKey = (projectRoot: string): string => `${ARCHIVED_SCOPE_PREFIX}${projectRoot}`;

export const folderScopeKeepsMovedSession = (
  scopeKey: string,
  destination: string,
  destinationWorktree: string | null,
): boolean => {
  if (scopeKey.startsWith(ARCHIVED_SCOPE_PREFIX)) return true;
  const scope = normalizePath(scopeKey);
  const target = normalizePath(destination);
  if (!scope || !target) return true;
  if (!checkoutHoldsDirectory(scope, target)) return false;
  const worktree = normalizePath(destinationWorktree);
  return !worktree || checkoutHoldsDirectory(worktree, scope);
};
