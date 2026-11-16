import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '@/lib/pathNormalization';

type WorktreeIndexProject = {
  id: string;
  normalizedPath: string | null | undefined;
  label?: string | null;
};

type WorktreeIndexEntry<P extends WorktreeIndexProject = WorktreeIndexProject> = {
  meta: WorktreeMetadata;
  project: P;
};

export const buildWorktreeByPathIndex = <P extends WorktreeIndexProject>(
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>,
  projects: readonly P[],
): Map<string, WorktreeIndexEntry<P>> => {
  const byPath = new Map<string, WorktreeIndexEntry<P>>();
  const projectByNormalizedPath = new Map<string, P>();
  for (const project of projects) {
    const normalized = normalizePath(project.normalizedPath ?? null);
    if (normalized && !projectByNormalizedPath.has(normalized)) projectByNormalizedPath.set(normalized, project);
  }
  for (const [projectPath, worktrees] of availableWorktreesByProject) {
    const project = projectByNormalizedPath.get(normalizePath(projectPath) ?? '') ?? null;
    if (!project) continue;
    const projectRoot = normalizePath(project.normalizedPath ?? null);
    for (const entry of worktrees) {
      const entryPath = normalizePath(entry.path);
      if (!entryPath || entryPath === projectRoot || byPath.has(entryPath)) continue;
      byPath.set(entryPath, { meta: entry, project });
    }
  }
  return byPath;
};

export const buildProjectWorktreeIndex = (
  availableWorktrees: readonly WorktreeMetadata[],
  projectRoot: string | null,
): Map<string, WorktreeMetadata> => {
  const byPath = new Map<string, WorktreeMetadata>();
  for (const meta of availableWorktrees) {
    if (!meta.path) continue;
    const normalized = normalizePath(meta.path) ?? meta.path;
    if (!normalized || normalized === projectRoot || byPath.has(normalized)) continue;
    byPath.set(normalized, meta);
  }
  return byPath;
};

export const findPrefixWorktreeEntry = <T>(
  directory: string,
  index: ReadonlyMap<string, T>,
): T | null => {
  let bestPath: string | null = null;
  for (const path of index.keys()) {
    if (bestPath !== null && path.length <= bestPath.length) continue;
    if (directory === path || (directory.length > path.length && directory.charCodeAt(path.length) === 47 && directory.startsWith(path))) {
      bestPath = path;
    }
  }
  return bestPath === null ? null : index.get(bestPath) ?? null;
};

export const resolveBranchLiveFirst = (
  directory: string,
  worktreePath: string | null,
  worktreeBranch: string | null | undefined,
  gitBranches: ReadonlyMap<string, string | null>,
): string | null => {
  const liveAtDirectory = gitBranches.get(directory)?.trim() || null;
  if (liveAtDirectory) return liveAtDirectory;
  if (worktreePath && worktreePath !== directory) {
    const liveAtWorktree = gitBranches.get(worktreePath)?.trim() || null;
    if (liveAtWorktree) return liveAtWorktree;
  }
  return worktreeBranch?.trim() || null;
};
