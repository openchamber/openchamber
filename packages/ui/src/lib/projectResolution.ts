import type { Session } from "@opencode-ai/sdk/v2";
import type { ProjectEntry } from "@/lib/api/types";
import type { WorktreeMetadata } from "@/types/worktree";

import { normalizePath } from "@/lib/pathNormalization";
export const normalizeProjectPath = normalizePath;

export const deriveProjectLabelFromPath = (path: string, preserveCasing = false): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') return 'Root';
  const segments = normalized.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] || normalized;
  return preserveCasing
    ? raw
    : raw.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
};

export const resolveProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let best: ProjectEntry | null = null;
  for (const p of projects) {
    const pp = normalizeProjectPath(p.path);
    if (!pp) continue;
    const isWithinProject = pp === '/'
      ? nd.startsWith('/')
      : nd === pp || nd.startsWith(`${pp}/`);
    if (!isWithinProject) continue;
    if (!best || pp.length > (normalizeProjectPath(best.path)?.length ?? 0)) best = p;
  }
  return best;
};

const resolveProjectFromWorktreeDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let matchedWorktree: WorktreeMetadata | null = null;
  let matchedProjectPath: string | null = null;
  let bestLen = -1;
  for (const [projectPath, worktrees] of availableWorktreesByProject.entries()) {
    for (const wt of worktrees) {
      const wp = normalizeProjectPath(wt.path);
      if (!wp) continue;
      if (nd !== wp && !nd.startsWith(`${wp}/`)) continue;
      if (wp.length > bestLen) {
        bestLen = wp.length;
        matchedWorktree = wt;
        matchedProjectPath = normalizeProjectPath(projectPath);
      }
    }
  }
  if (!matchedWorktree) return null;
  const candidates = [normalizeProjectPath(matchedWorktree.projectDirectory), matchedProjectPath]
    .filter((v): v is string => Boolean(v));
  for (const c of candidates) {
    const exact = projects.find((p) => normalizeProjectPath(p.path) === c) ?? null;
    if (exact) return exact;
    const nested = resolveProjectForDirectory(projects, c);
    if (nested) return nested;
  }
  return null;
};

export const resolveProjectForSessionDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null =>
  resolveProjectFromWorktreeDirectory(projects, availableWorktreesByProject, directory) ??
  resolveProjectForDirectory(projects, directory);

const resolveSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizeProjectPath(record.directory ?? record.project?.worktree ?? null);
};

export const resolveProjectsWithNoActiveSessions = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  activeSessions: Session[],
  changedDirectories: Iterable<string | null | undefined>,
): ProjectEntry[] => {
  const candidates = new Map<string, ProjectEntry>();
  for (const directory of changedDirectories) {
    const project = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory ?? null);
    if (project) candidates.set(project.id, project);
  }
  if (candidates.size === 0) return [];

  for (const session of activeSessions) {
    const project = resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      resolveSessionDirectory(session),
    );
    if (project) candidates.delete(project.id);
    if (candidates.size === 0) return [];
  }

  return [...candidates.values()];
};
