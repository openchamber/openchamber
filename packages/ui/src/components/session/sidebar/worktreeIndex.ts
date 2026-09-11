import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from './utils';

export type WorktreeIndexProject = {
  id: string;
  normalizedPath: string | null | undefined;
  label?: string | null;
};

export type WorktreeIndexEntry<P extends WorktreeIndexProject = WorktreeIndexProject> = {
  meta: WorktreeMetadata;
  project: P;
};

/**
 * Canonical exact worktree index shared by Recent, project grouping, and the
 * session switcher. Normalizes every key, excludes the owning project root,
 * and keeps the first entry on duplicate paths so repeated topology publishes
 * cannot flip ownership.
 */
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

/**
 * Per-project exact worktree index for `useSessionGrouping`. Same contract as
 * the global index: normalized keys, project-root exclusion, first-wins
 * dedupe. Previously the grouping map kept the last duplicate; unifying on
 * first-wins matches Recent and keeps repeated publishes stable.
 */
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

/**
 * Longest-prefix worktree lookup for sessions inside `<worktree>/sub`.
 * Exact matches are included (`directory === path`). Returns null when no
 * indexed worktree contains the directory.
 */
export const findPrefixWorktreeEntry = <T>(
  directory: string,
  index: ReadonlyMap<string, T>,
): T | null => {
  let best: T | null = null;
  let bestLength = -1;
  for (const [path, entry] of index) {
    if (path.length <= bestLength) continue;
    if (directory === path || directory.startsWith(`${path}/`)) {
      best = entry;
      bestLength = path.length;
    }
  }
  return best;
};

/**
 * Live-first branch invariant: live git status wins over discovered worktree
 * metadata when they disagree. The worktree-root live lookup covers sessions
 * in `<worktree>/sub`, whose own directory rarely has a git-status entry.
 */
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
