import React from 'react';
import { resolveGitPrimaryRoot, resolveGitTopLevel } from '@/lib/gitApi';
import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '@/lib/pathNormalization';

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

    setDetected(undefined);

    let cancelled = false;
    void (async () => {
      const [projectRootRaw, worktreePathRaw] = await Promise.all([
        resolveGitPrimaryRoot(currentDirectory),
        resolveGitTopLevel(currentDirectory),
      ]).catch(() => ['', '']);
      if (cancelled) return;

      const projectRoot = normalizePath(projectRootRaw);
      const worktreePath = normalizePath(worktreePathRaw);

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
