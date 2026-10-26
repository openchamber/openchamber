import { normalizeProjectPath } from '@/lib/projectResolution';

/**
 * Where workflows belong: the project, as project actions do. Its runs are
 * those of sessions in the project's folder and in any of its worktrees, and
 * its saved workflows are the project folder's `.openchamber/workflows/`. A
 * folder that is no project keeps to itself.
 */
export type WorkflowProjectScope = {
  /** Folders whose sessions' runs are the project's. */
  directories: readonly string[];
  /** Where the project's saved workflows live. */
  savedDirectory: string;
};

/** Whether a run's folder is one of the scope's. */
export const isRunInScope = (runDirectory: string, scope: WorkflowProjectScope): boolean => {
  const path = normalizeProjectPath(runDirectory);
  return path !== null && scope.directories.includes(path);
};
