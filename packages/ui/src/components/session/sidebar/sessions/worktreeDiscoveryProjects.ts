import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';
import { createSessionOwnershipIndex } from './sessionOwnership';

type Project = {
  id: string;
  path: string;
};

type Worktree = {
  path: string;
};

export const selectWorktreeDiscoveryProjects = <TProject extends Project>(
  projects: TProject[],
  activeProjectId: string | null,
  sessions: Session[],
  availableWorktreesByProject: Map<string, Worktree[]>,
): TProject[] => {
  const ownershipProjects = projects.map((project) => ({
    id: project.id,
    normalizedPath: normalizePath(project.path) ?? project.path,
  }));
  const ownership = createSessionOwnershipIndex(
    sessions,
    ownershipProjects,
    availableWorktreesByProject,
    false,
  );

  return projects.filter((project) => (
    project.id === activeProjectId || ownership.sessionsByProject.has(project.id)
  ));
};
