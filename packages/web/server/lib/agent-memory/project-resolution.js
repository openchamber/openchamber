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
