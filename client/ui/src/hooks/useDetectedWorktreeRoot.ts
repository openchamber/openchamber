import React from 'react';
import { resolveGitPrimaryRoot, resolveGitTopLevel } from '@/lib/gitApi';
import type { WorktreeMetadata } from '@/types/worktree';

const normalizePath = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

/**
 * When the store-based WorktreeMetadata lookup fails, this hook falls back to
 * narrow git runtime APIs to detect whether `currentDirectory` is a secondary
 * worktree. If it is, a minimal
 * WorktreeMetadata is synthesised so that "Re-integrate commits" and other
 * worktree features can function without explicit store entries.
 *
 * @param currentDirectory  Effective directory for the active session/tab.
 * @param storeMetadata     Result of the normal store-based lookup (may be undefined).
 * @param currentBranch     Current git branch (from status?.current in the parent).
 */
export function useDetectedWorktreeMetadata(
  currentDirectory: string | undefined,
  storeMetadata: WorktreeMetadata | undefined,
  currentBranch: string | undefined,
): WorktreeMetadata | undefined {
  const [detected, setDetected] = React.useState<WorktreeMetadata | undefined>();

  React.useEffect(() => {
    if (storeMetadata) {
      setDetected(undefined);
      return;
    }

    if (!currentDirectory) {
      setDetected(undefined);
      return;
    }

    // Reset immediately so callers never see stale metadata from a previous directory.
    setDetected(undefined);

    let cancelled = false;
    void (async () => {
      const [projectRootRaw, worktreePathRaw] = await Promise.all([
        resolveGitPrimaryRoot(currentDirectory),
        resolveGitTopLevel(currentDirectory),
      ]).catch(() => ['', '']);
      if (cancelled) return;

      const projectRoot = normalizePath(projectRootRaw);
      // Use the worktree toplevel, not the active sub-directory, so that
      // worktree operations (e.g. `git worktree remove`) receive a valid root path.
      const worktreePath = normalizePath(worktreePathRaw);

      // Sanity-check: secondary worktree path must differ from project root
      if (!projectRoot || !worktreePath || worktreePath === projectRoot) {
        return;
      }

      const branch = currentBranch || '';
      const name = worktreePath.split('/').filter(Boolean).pop() || worktreePath;
      const headState = !branch ? 'unborn' : 'branch';

      setDetected({
        source: 'sdk',
        path: worktreePath,
        projectDirectory: projectRoot,
        branch,
        label: branch || name,
        name,
        // Phase 1 canonical fields — this hook is fallback-only
        worktreeRoot: worktreePath,
        worktreeStatus: 'ready',
        headState,
        worktreeSource: 'existing',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, storeMetadata, currentBranch]);

  return storeMetadata ?? detected;
}
