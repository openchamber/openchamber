import { createProjectIdFromPath } from '@/lib/projectId';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { GitProviderApiBaseUrls } from '@/stores/useGitProviderDomainsStore';

const gitProvidersRoute = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/git-providers`;

/**
 * Read the server-authoritative per-project git provider config for a project.
 * Fails closed: any non-OK, malformed, or unparseable response collapses to
 * `{ gitProviders: {} }` and this never throws. Callers treat the empty object
 * as "no project override", which is the conservative default — an unreachable
 * server must never widen provider detection.
 */
export const getProjectGitProviders = async (projectId: string): Promise<{ gitProviders: unknown }> => {
  if (!projectId) {
    return { gitProviders: {} };
  }
  try {
    const response = await runtimeFetch(gitProvidersRoute(projectId), {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return { gitProviders: {} };
    }
    const payload = (await response.json().catch(() => null)) as { gitProviders?: unknown } | null;
    if (!payload || typeof payload !== 'object' || !('gitProviders' in payload)) {
      return { gitProviders: {} };
    }
    return { gitProviders: payload.gitProviders };
  } catch {
    return { gitProviders: {} };
  }
};

/**
 * Persist the full per-project git provider config. The server replaces the
 * whole `gitProviders` key on PUT, so every provider must be sent together.
 * Returns true only on an OK response; never throws.
 */
export const saveProjectGitProviders = async (projectId: string, gitProviders: unknown): Promise<boolean> => {
  if (!projectId) {
    return false;
  }
  try {
    const response = await runtimeFetch(gitProvidersRoute(projectId), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ gitProviders }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

type ResolvableProject = { id: string; path: string };

/** Same shape as `useSessionUIStore`'s `availableWorktreesByProject`. */
export type WorktreesByProject = ReadonlyMap<string, ReadonlyArray<{ path?: string }>>;

const isNormalizedPathWithinProject = (directory: string, projectPath: string): boolean => {
  if (directory === projectPath) return true;
  if (projectPath === '/') return directory.startsWith('/');
  return directory.startsWith(`${projectPath}/`);
};

/**
 * A directory that is a known worktree resolves to its owning project, no
 * matter where the worktree lives (git worktrees can be created outside the
 * project root). Mirrors the sidebar's `worktreeInfoByPath` lookup: exact
 * normalized path match, then exact normalized owning-project match.
 */
const resolveWorktreeOwner = (
  normalizedDirectory: string,
  worktreesByProject: WorktreesByProject,
  projects: ResolvableProject[],
): ResolvableProject | null => {
  for (const [projectPath, worktrees] of worktreesByProject) {
    const normalizedProjectPath = normalizePath(projectPath);
    if (!normalizedProjectPath) continue;
    for (const worktree of worktrees) {
      if (normalizePath(worktree.path) !== normalizedDirectory) continue;
      const exact = projects.find((project) => normalizePath(project.path) === normalizedProjectPath);
      if (exact) return exact;
    }
  }
  return null;
};

/**
 * Resolve which project owns a directory, mirroring the sidebar's
 * `findProjectForDirectory` precedence: a known worktree directory resolves to
 * its owning project first (worktrees may live outside the project root),
 * then the longest normalized project path that contains the directory wins.
 * When no registered project matches, fall back to the deterministic
 * path-derived project id (`createProjectIdFromPath`) so overrides still key
 * correctly for unregistered/not-yet-indexed directories. Returns null for an
 * empty directory.
 */
export const resolveProjectIdForDirectory = (
  directory: string | null | undefined,
  projects: ResolvableProject[],
  worktreesByProject?: WorktreesByProject,
): string | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  if (worktreesByProject) {
    const worktreeOwner = resolveWorktreeOwner(normalizedDirectory, worktreesByProject, projects);
    if (worktreeOwner) return worktreeOwner.id;
  }
  let best: { id: string; normalizedPath: string } | null = null;
  for (const project of projects) {
    const normalizedPath = normalizePath(project.path);
    if (!normalizedPath) continue;
    if (!isNormalizedPathWithinProject(normalizedDirectory, normalizedPath)) continue;
    if (!best || normalizedPath.length > best.normalizedPath.length) {
      best = { id: project.id, normalizedPath };
    }
  }
  if (best) return best.id;
  const fallbackId = createProjectIdFromPath(directory ?? '');
  return fallbackId || null;
};

/**
 * The per-project api base url override for the directory's owning project, or
 * undefined when the directory has no resolvable project id.
 */
export const resolveProjectApiBaseUrls = (
  directory: string | null | undefined,
  projects: ResolvableProject[],
  projectApiBaseUrls: Record<string, GitProviderApiBaseUrls>,
  worktreesByProject?: WorktreesByProject,
): GitProviderApiBaseUrls | undefined => {
  const projectId = resolveProjectIdForDirectory(directory, projects, worktreesByProject);
  return projectId ? projectApiBaseUrls[projectId] : undefined;
};

/**
 * Merge a project-scoped override over the global settings api base urls.
 * Non-empty project values win; empty override slots fall back to the global
 * settings value (precedence: project override > global server settings).
 */
export const mergeGitProviderApiBaseUrls = (
  projectOverride: GitProviderApiBaseUrls | undefined,
  globalApiBaseUrls: GitProviderApiBaseUrls,
): GitProviderApiBaseUrls => ({
  github: projectOverride?.github || globalApiBaseUrls.github,
  gitlab: projectOverride?.gitlab || globalApiBaseUrls.gitlab,
  gitea: projectOverride?.gitea || globalApiBaseUrls.gitea,
});