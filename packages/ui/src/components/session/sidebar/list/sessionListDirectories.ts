import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '../utils';

export const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizePath(project.path);
    if (normalized) directories.add(normalized);
  }
  if (options?.includeWorktrees === false) {
    return directories;
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const normalized = normalizePath(worktree.path);
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};

/**
 * Directories whose session list still has to be fetched for one sync pass.
 * Once a previous pass exists, only newly added directories are fetched.
 * On the first full-app pass the global bootstrap already covers the project
 * roots, so only non-root (worktree) directories need a fetch; VS Code has no
 * bootstrap for known directories and fetches everything it is allowed to see.
 */
export const getSessionDirectoriesToSync = (
  knownDirectories: ReadonlySet<string>,
  previous: ReadonlySet<string> | null,
  options: { isVSCode: boolean; projectRoots: ReadonlySet<string> },
): string[] => {
  if (previous) {
    return [...knownDirectories].filter((directory) => !previous.has(directory));
  }
  if (options.isVSCode) {
    return [...knownDirectories];
  }
  return [...knownDirectories].filter((directory) => !options.projectRoots.has(directory));
};
