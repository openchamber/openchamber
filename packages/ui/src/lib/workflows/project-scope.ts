import { normalizeProjectPath } from '@/lib/projectResolution';

export type WorkflowProjectScope = {
  directories: readonly string[];
  savedDirectory: string;
};

export const isRunInScope = (runDirectory: string, scope: WorkflowProjectScope): boolean => {
  const path = normalizeProjectPath(runDirectory);
  return path !== null && scope.directories.includes(path);
};
