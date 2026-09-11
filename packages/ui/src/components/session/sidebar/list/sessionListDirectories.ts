import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '../utils';

export const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizePath(project.path)?.toLowerCase();
    if (normalized) directories.add(normalized);
  }
  if (options?.includeWorktrees === false) {
    return directories;
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const normalized = normalizePath(worktree.path)?.toLowerCase();
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};
