import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';
import { checkoutHoldsDirectory } from './worktreePaths';

type ProjectCheckouts = { repositoryRoot: string; paths: readonly string[] };

const byProject = new Map<string, ProjectCheckouts>();

export const publishIntegrateCheckouts = (projectPath: string, repositoryRoot: string, paths: readonly string[]): boolean => {
  const current = byProject.get(projectPath);
  if (paths.length === 0) return byProject.delete(projectPath);
  if (current?.repositoryRoot === repositoryRoot
    && current.paths.length === paths.length && current.paths.every((path, index) => path === paths[index])) return false;
  byProject.set(projectPath, { repositoryRoot, paths });
  return true;
};

export const clearIntegrateCheckouts = (): void => byProject.clear();

export const listIntegrateCheckouts = (): { path: string; projectPaths: string[] }[] => {
  const checkouts = new Map<string, string[]>();
  for (const [projectPath, { repositoryRoot, paths }] of byProject) {
    for (const path of paths) {
      const known = checkouts.get(path) ?? [repositoryRoot];
      if (!known.includes(projectPath)) known.push(projectPath);
      checkouts.set(path, known);
    }
  }
  return [...checkouts].map(([path, projectPaths]) => ({ path, projectPaths }));
};

export const findIntegrateCheckout = (directory: string | null | undefined): { path: string; projectPaths: string[] } | null => {
  if (byProject.size === 0) return null;
  const target = normalizePath(directory);
  if (!target) return null;
  return listIntegrateCheckouts().find((checkout) => checkoutHoldsDirectory(checkout.path, target)) ?? null;
};

export const isCheckoutRoot = (worktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>, target: string | null): boolean => (
  target !== null && (findIntegrateCheckout(target)?.path === target
    || [...worktreesByProject.values()].some((worktrees) => worktrees.some((worktree) => normalizePath(worktree.path) === target)))
);
