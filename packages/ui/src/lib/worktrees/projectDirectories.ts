import type { WorktreeMetadata } from '@/types/worktree';

export interface ProjectDirectoryOption {
  path: string;
  label: string;
}

const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const replaced = trimmed.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

export const getProjectDirectoryOptions = (
  projectPath: string | null,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
): ProjectDirectoryOption[] => {
  if (!projectPath) {
    return [];
  }

  const normalizedProjectPath = normalizePath(projectPath);
  const worktrees = availableWorktreesByProject.get(normalizedProjectPath) ?? [];

  const options: ProjectDirectoryOption[] = [];
  const seenPaths = new Set<string>();

  if (normalizedProjectPath) {
    options.push({
      path: normalizedProjectPath,
      label: 'Project root',
    });
    seenPaths.add(normalizedProjectPath);
  }

  for (const worktree of worktrees) {
    const normalizedPath = normalizePath(worktree.path);
    if (normalizedPath && !seenPaths.has(normalizedPath)) {
      options.push({
        path: normalizedPath,
        label: worktree.label || worktree.name || worktree.path,
      });
      seenPaths.add(normalizedPath);
    }
  }

  return options;
};

export const getProjectDirectories = (
  projectPath: string | null,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>
): string[] => {
  const options = getProjectDirectoryOptions(projectPath, availableWorktreesByProject);
  return options.map((opt) => opt.path);
};
