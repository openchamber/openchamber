import type fsModule from 'node:fs/promises';

import { directoryReachability } from '../directory-reachability/index.js';
import { isString } from '../shared/object-guards.js';

const hasProjectFields = (value: unknown): value is { path?: unknown } => value != null;
const hasErrorCode = (value: unknown): value is { code?: unknown } => Boolean(value && typeof value === 'object');

const STAT_WAIT_MS = 2000;

const within = async <Result>(running: Promise<Result>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(resolve, STAT_WAIT_MS, null); });
  return Promise.race([running, late]).finally(() => clearTimeout(timer));
};

export const createProjectValidation = (fsPromises: Pick<typeof fsModule, 'stat'>) => async (projects: unknown[]) => {
  const validations = projects.map(async (project) => {
    if (!project || !hasProjectFields(project) || !isString(project.path) || project.path.length === 0) {
      console.warn('[validateProjectEntries] Dropping project entry with missing or empty path');
      return null;
    }
    try {
      if (await directoryReachability.isUnreachable(project.path)) return project;
      const stats = await within(fsPromises.stat(project.path));
      if (!stats) return project;
      if (!stats.isDirectory()) {
        console.warn(`[validateProjectEntries] Dropping project — path is not a directory: ${project.path}`);
        return null;
      }
      return project;
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        console.warn(`[validateProjectEntries] Dropping project — directory no longer exists: ${project.path}`);
        return null;
      }
      return project;
    }
  });
  return (await Promise.all(validations)).filter((project) => project !== null);
};
