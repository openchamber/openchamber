import React from 'react';
import { execCommand } from '@/lib/execCommands';
import { normalizePath, pathsEqual } from '@/lib/pathUtils';
import type { WorktreeMetadata } from '@/types/worktree';

/**
 * Derive the primary worktree (project) root from the absolute git directory.
 *
 * Secondary worktree:  /project/.git/worktrees/<name>  → /project
 * Primary worktree:    /project/.git                   → null (not a secondary)
 */
const deriveProjectRoot = (gitDir: string): string | null => {
  const normalized = normalizePath(gitDir);
  if (!normalized) return null;

  const marker = '/.git/worktrees/';
  const idx = normalized.indexOf(marker);
  if (idx > 0) {
    return normalized.slice(0, idx) || null;
  }

  return null;
};

/**
 * When the store-based WorktreeMetadata lookup fails, this hook falls back to
 * a single `git rev-parse --absolute-git-dir` call to detect whether
 * `currentDirectory` is a secondary worktree.  If it is, a minimal
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
      const [gitDirResult, toplevelResult] = await Promise.all([
        execCommand('git rev-parse --absolute-git-dir', currentDirectory),
        execCommand('git rev-parse --show-toplevel', currentDirectory),
      ]);
      if (cancelled) return;

      if (!gitDirResult.success || !toplevelResult.success) {
        return;
      }

      const gitDir = normalizePath((gitDirResult.stdout || '').trim()) ?? '';
      const projectRoot = deriveProjectRoot(gitDir);

      if (!projectRoot) {
        return;
      }

      // Use the worktree toplevel, not the active sub-directory, so that
      // worktree operations (e.g. `git worktree remove`) receive a valid root path.
      const worktreePath = normalizePath((toplevelResult.stdout || '').trim()) ?? '';

      // Sanity-check: secondary worktree path must differ from project root
      if (!worktreePath || pathsEqual(worktreePath, projectRoot)) {
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
