import type { WorktreeMetadata } from '@/types/worktree';
import { canonicalizePathIdentity } from '@/lib/pathNormalization';

export const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const identity = canonicalizePathIdentity(project.path);
    if (identity) directories.add(identity);
  }
  if (options?.includeWorktrees === false) {
    return directories;
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const identity = canonicalizePathIdentity(worktree.path);
      if (identity) directories.add(identity);
    }
  }
  return directories;
};
