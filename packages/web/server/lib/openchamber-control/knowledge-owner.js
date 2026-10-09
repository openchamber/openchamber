import fs from 'node:fs/promises';
import { asNonEmptyString } from '../shared/guards.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

const normalize = (value) => {
  const normalized = (asNonEmptyString(value) || '')
    .replaceAll('\\', '/')
    .replace(/^([a-z]):/, (_, letter) => `${letter.toUpperCase()}:`);
  if (normalized === '/') return normalized;
  if (/^(?:\/\/\?\/)?[A-Za-z]:\/+$/u.test(normalized)) return normalized.replace(/\/+$/, '/');
  return normalized.replace(/\/+$/, '');
};

const contains = (root, directory) => Boolean(root) && (
  directory === root || directory.startsWith(root.endsWith('/') ? root : `${root}/`)
);

const longestOwner = (projects, directory) => {
  let best = null;
  for (const project of projects) {
    if (contains(project.normalized, directory) && project.normalized.length > (best?.normalized.length || 0)) best = project;
  }
  return best;
};

/** Mirrors the concrete-directory rules in useProjectContextOwner and projectResolution. */
export const createKnowledgeOwnerResolver = ({
  listProjectPaths,
  getWorktrees,
  resolvePrimaryWorktreeRoot,
  isGitRepository,
  managedProjectRoots = [],
  realpath = fs.realpath,
}) => {
  const managedRoots = managedProjectRoots.map((root) => ({ path: root, normalized: normalize(root) })).filter((root) => root.normalized);
  return async (directory) => {
    const resolved = normalize(directory);
    if (!resolved) return '';
    for (const root of managedRoots) {
      if (contains(root.normalized, resolved)) return createProjectIdFromPath(root.path);
      const canonical = await realpath(root.path).catch((error) => {
        if (error.code === 'ENOENT') return root.path;
        throw error;
      });
      if (contains(normalize(canonical), resolved)) return createProjectIdFromPath(root.path);
    }

    // Failed settings/topology reads must not select a different writable store.
    const projects = (await listProjectPaths()).map((project) => ({ path: project, normalized: normalize(project) })).filter((project) => project.normalized);
    const direct = longestOwner(projects, resolved);
    if (direct?.normalized === resolved) return createProjectIdFromPath(direct.path);
    const configuredPaths = new Set(projects.map((project) => project.normalized));

    const candidates = [];
    for (const project of projects) {
      let matchedPath = '';
      for (const worktree of await getWorktrees(project.path)) {
        const worktreePath = normalize(worktree.path);
        // Published UI topology omits every configured checkout.
        if (configuredPaths.has(worktreePath) || !contains(worktreePath, resolved)) continue;
        if (worktreePath.length > matchedPath.length) {
          matchedPath = worktreePath;
        }
      }
      if (matchedPath.length > (direct?.normalized.length || 0)) candidates.push({ project, matchedPath });
    }
    candidates.sort((a, b) => b.matchedPath.length - a.matchedPath.length);
    for (const { project } of candidates) {
      // Reuse the sidebar's Git eligibility rule, including HOME/disk roots.
      if (!await isGitRepository(project.path)) continue;
      const primary = normalize((await resolvePrimaryWorktreeRoot(project.path)).root);
      // Worktree metadata tries projectDirectory first, then the listing's key.
      const owner = longestOwner(projects, primary) || project;
      return createProjectIdFromPath(owner.path);
    }
    return direct ? createProjectIdFromPath(direct.path) : '';
  };
};
