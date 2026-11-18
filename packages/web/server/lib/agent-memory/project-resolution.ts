import path from 'node:path';

import { createProjectIdFromPath } from '../projects/project-id.js';
import { isMemoryText } from './contracts.js';

interface MemoryProjectDependencies {
  listProjectPaths: () => Promise<string[] | null>;
  resolvePrimaryWorktreeRoot: (directory: string) => Promise<{ root: string } | null>;
  managedProjectRoots?: string[];
}

const normalize = (value: string | null | undefined) => {
  if (!isMemoryText(value)) return '';
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : '';
};

export const createMemoryProjectResolver = (dependencies: MemoryProjectDependencies) => {
  const { listProjectPaths, resolvePrimaryWorktreeRoot, managedProjectRoots = [] } = dependencies;
  const managedRoots = managedProjectRoots.map(normalize).filter(Boolean);

  return async (directory: string | null | undefined) => {
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

    let configured: string[] = [];
    try {
      configured = ((await listProjectPaths()) || []).map(normalize).filter(Boolean);
    } catch {
      configured = [];
    }
    if (configured.includes(resolved)) {
      return createProjectIdFromPath(resolved);
    }

    let primaryRoot = '';
    try {
      primaryRoot = normalize((await resolvePrimaryWorktreeRoot(resolved))?.root);
    } catch {
      primaryRoot = '';
    }

    return createProjectIdFromPath(primaryRoot || resolved);
  };
};
