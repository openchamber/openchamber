/**
 * Which project's memory a session directory belongs to.
 *
 * A session often runs in a worktree, whose path is not the project's path.
 * Keying memory by the session directory filed a worktree's memories under a
 * project the panel never reads, so the agent stored them and the user never
 * saw them. Every worktree of a repository shares one project memory, which is
 * also what the user means by "this project".
 *
 * A directory that is itself a configured project is taken as-is; anything else
 * resolves to its primary worktree. The configured check comes first because a
 * user may register a worktree as a project in its own right, and that choice
 * has to win over the git topology.
 */

import path from 'node:path';

import { createProjectIdFromPath } from '../projects/project-id.js';

const normalize = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : '';
};

export const createMemoryProjectResolver = (dependencies) => {
  const { listProjectPaths, resolvePrimaryWorktreeRoot, managedProjectRoots = [] } = dependencies;
  const managedRoots = managedProjectRoots.map(normalize).filter(Boolean);

  return async (directory) => {
    const resolved = normalize(directory);
    if (!resolved) {
      return '';
    }

    const managedRoot = managedRoots.find((root) => {
      const relative = path.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (managedRoot) {
      return createProjectIdFromPath(managedRoot);
    }

    let configured = [];
    try {
      configured = ((await listProjectPaths()) || []).map(normalize).filter(Boolean);
    } catch {
      // An unreadable project list must not lose the memory: the git-derived
      // root below still converges every worktree of the repository on one
      // store rather than scattering one per checkout.
    }
    if (configured.includes(resolved)) {
      return createProjectIdFromPath(resolved);
    }

    let primaryRoot = '';
    try {
      primaryRoot = normalize((await resolvePrimaryWorktreeRoot(resolved))?.root);
    } catch {
      // Not a git checkout, or git is unavailable.
    }

    return createProjectIdFromPath(primaryRoot || resolved);
  };
};
