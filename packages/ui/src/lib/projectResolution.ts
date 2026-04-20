import type { ProjectEntry } from "@/lib/api/types";
import type { WorktreeMetadata } from "@/types/worktree";

export const normalizeProjectPath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const replaced = trimmed.replace(/\\/g, "/");
  if (replaced === "/") return "/";
  return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
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
    if (nd !== pp && !nd.startsWith(`${pp}/`)) continue;
    if (!best || pp.length > (normalizeProjectPath(best.path)?.length ?? 0)) best = p;
  }
  return best;
};

export const resolveProjectFromWorktreeDirectory = (
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
