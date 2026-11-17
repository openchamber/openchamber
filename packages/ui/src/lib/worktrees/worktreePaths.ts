
import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';

export const checkoutHoldsSubfolder = (checkoutPath: string, directory: string): boolean => {
  const prefix = checkoutPath.endsWith('/') ? checkoutPath : `${checkoutPath}/`;
  return directory.startsWith(prefix);
};

export const checkoutHoldsDirectory = (checkoutPath: string, directory: string): boolean => (
  directory === checkoutPath || checkoutHoldsSubfolder(checkoutPath, directory)
);

export const findWorktreeHoldingDirectory = (
  worktrees: Iterable<WorktreeMetadata>,
  directory: string,
): WorktreeMetadata | undefined => {
  const target = normalizePath(directory);
  if (!target) return undefined;
  let best: WorktreeMetadata | undefined;
  let bestLength = -1;
  for (const worktree of worktrees) {
    const checkoutPath = normalizePath(worktree.path);
    if (!checkoutPath || checkoutPath.length <= bestLength) continue;
    if (checkoutHoldsDirectory(checkoutPath, target)) {
      best = worktree;
      bestLength = checkoutPath.length;
    }
  }
  return best;
};

export const projectPathForCheckoutFolder = (input: {
  directory: string;
  folder: string;
  primaryRoot: string;
  projectPaths: readonly string[];
}): string | null => {
  const directory = normalizePath(input.directory);
  const primaryRoot = normalizePath(input.primaryRoot);
  if (!directory || !primaryRoot) return null;
  const folder = input.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const checkoutRoot = !folder ? directory : directory.endsWith(`/${folder}`) ? directory.slice(0, -folder.length - 1) : null;
  let containing: string | null = null;
  let inPrimary: { path: string; folder: string } | null = null;
  for (const projectPath of input.projectPaths) {
    const project = normalizePath(projectPath);
    if (!project) continue;
    if (checkoutHoldsDirectory(project, directory) && (!checkoutRoot || checkoutHoldsDirectory(checkoutRoot, project))) {
      if (!containing || project.length > containing.length) containing = project;
    }
    if (!checkoutHoldsDirectory(primaryRoot, project)) continue;
    const projectFolder = project.slice(primaryRoot.length).replace(/^\/+/, '');
    if (projectFolder && !checkoutHoldsDirectory(projectFolder, folder)) continue;
    if (!inPrimary || projectFolder.length > inPrimary.folder.length) inPrimary = { path: project, folder: projectFolder };
  }
  return containing ?? inPrimary?.path ?? null;
};
