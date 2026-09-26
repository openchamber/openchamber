import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import type { WorktreeMetadata } from '@/types/worktree';

export function useProjectWorktrees(
  projectRef: ProjectRef | null,
  isGitRepo: boolean | null,
  sessionsKey: string,
  listWorktrees: (project: ProjectRef) => Promise<WorktreeMetadata[]>,
) {
  const [availableWorktrees, setAvailableWorktrees] = React.useState<WorktreeMetadata[]>([]);
  const [isLoadingWorktrees, setIsLoadingWorktrees] = React.useState(false);
  const projectWorktrees = useSessionUIStore((state) =>
    state.availableWorktreesByProject.get(projectRef?.id ?? ''),
  );
  const storeWorktrees = useSessionUIStore((state) =>
    state.availableWorktreesByProject.get(projectRef?.id ?? '') ?? state.availableWorktrees,
  );

  const refreshWorktrees = React.useCallback(async () => {
    if (!projectRef || isGitRepo === false) return;
    try {
      setAvailableWorktrees(await listWorktrees(projectRef));
    } catch {
      // Keep the last known list on failure.
    }
  }, [projectRef, isGitRepo, listWorktrees]);

  React.useEffect(() => {
    if (!projectRef || isGitRepo === false) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    let cancelled = false;
    setIsLoadingWorktrees(true);
    setAvailableWorktrees([]);
    void (async () => {
      try {
        const worktrees = await listWorktrees(projectRef);
        if (!cancelled) setAvailableWorktrees(worktrees);
      } catch {
        // Keep the last known list on failure.
      } finally {
        if (!cancelled) setIsLoadingWorktrees(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectRef, isGitRepo, listWorktrees]);

  React.useEffect(() => {
    if (isGitRepo && projectRef && projectWorktrees) setAvailableWorktrees(projectWorktrees);
  }, [isGitRepo, projectRef, projectWorktrees]);

  React.useEffect(() => {
    if (!isGitRepo || !projectRef) return;
    void refreshWorktrees();
  }, [sessionsKey, storeWorktrees, isGitRepo, projectRef, refreshWorktrees]);

  return { availableWorktrees, isLoadingWorktrees };
}
