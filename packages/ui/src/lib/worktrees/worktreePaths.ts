/**
 * Path containment for checkouts. Kept free of store and runtime imports so
 * sync, multi-run and worktree modules that the manager itself reaches can
 * use it without an import cycle.
 */

import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';

/** True when `directory` lies inside `checkoutPath`. Both paths are normalized. */
export const checkoutHoldsSubfolder = (checkoutPath: string, directory: string): boolean => {
  const prefix = checkoutPath.endsWith('/') ? checkoutPath : `${checkoutPath}/`;
  return directory.startsWith(prefix);
};

/** True when `directory` is `checkoutPath` itself or lies inside it. Both paths are normalized. */
export const checkoutHoldsDirectory = (checkoutPath: string, directory: string): boolean => (
  directory === checkoutPath || checkoutHoldsSubfolder(checkoutPath, directory)
);

/**
 * The worktree whose checkout holds `directory`, itself or a sub-folder of it.
 * The longest checkout path wins so a worktree nested in another one is found.
 * Compares normalized paths and returns undefined when none holds it.
 */
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

/**
 * The registered project a directory belongs to, given where it sits inside
 * its checkout (`folder`, `ai/src` for `<checkout>/ai/src`) and the primary
 * checkout of its repository. The longest project containing the directory
 * inside the same checkout wins; a project that only contains the checkout,
 * such as `/repo` around a worktree at `/repo/.worktrees/a`, does not count.
 * Otherwise the longest project in the primary checkout whose folder holds
 * `folder`, so a session in `<worktree>/ai/src` follows `/repo/ai` rather
 * than `/repo`. The server applies the same rule to `session.moveToWorktree`.
 */
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
