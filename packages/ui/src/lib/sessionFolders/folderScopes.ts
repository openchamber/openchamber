import { normalizePath } from '@/lib/pathNormalization';
import { checkoutHoldsDirectory } from '@/lib/worktrees/worktreePaths';

const ARCHIVED_SCOPE_PREFIX = '__archived__:';

/** The folder scope of a project's archived chats, beside its root and worktree scopes. */
export const getArchivedScopeKey = (projectRoot: string): string => `${ARCHIVED_SCOPE_PREFIX}${projectRoot}`;

/**
 * Whether a session moved to `destination` still belongs to the folders of
 * `scopeKey` (a project root, worktree, space or the chats root): the scope
 * holds the destination, and no worktree inside the scope does. A worktree
 * nested in its project's folder has folders of its own. Archived scopes are
 * kept: restoring an archived session moves it, and its placement there is
 * the restore's to settle.
 */
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
