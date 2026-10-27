import React from 'react';

import type { ProjectEntry } from '@/lib/api/types';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { WorktreeMetadata } from '@/types/worktree';
import type { WorkflowProjectScope } from './project-scope';

export const resolveWorkflowProjectScope = (
  projects: ProjectEntry[],
  worktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): WorkflowProjectScope | null => {
  const own = normalizeProjectPath(directory);
  if (!own) return null;
  // A space keeps its own scope: the host project's saved workflows and runs stay on the host.
  const project = isSpaceDirectory(own) ? null : resolveProjectForSessionDirectory(projects, worktreesByProject, own);
  const root = normalizeProjectPath(project?.path ?? null);
  if (!root) return { directories: [own], savedDirectory: own };
  const worktrees = worktreesByProject.get(project?.path ?? '') ?? worktreesByProject.get(root) ?? [];
  const directories = new Set([root, own]);
  for (const worktree of worktrees) {
    const path = normalizeProjectPath(worktree.path);
    if (path) directories.add(path);
  }
  return { directories: [...directories], savedDirectory: root };
};

export const useWorkflowProjectScope = (directory: string | null): WorkflowProjectScope | null => {
  const projects = useProjectsStore((state) => state.projects);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  return React.useMemo(() => resolveWorkflowProjectScope(projects, worktreesByProject, directory), [directory, projects, worktreesByProject]);
};

/** The same scope outside React, for the surface-switch shortcut. */
export const getWorkflowProjectScope = (directory: string | null): WorkflowProjectScope | null => resolveWorkflowProjectScope(
  useProjectsStore.getState().projects,
  useSessionUIStore.getState().availableWorktreesByProject,
  directory,
);
