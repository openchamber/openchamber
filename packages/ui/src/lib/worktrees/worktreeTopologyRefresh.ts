import { resolveProjectRef } from '@/lib/worktreeSessionCreator';
import {
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  preserveClientTrackedWorktreeStatus,
  replaceRepositoryWorktrees,
  worktreeMapsEqual,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { normalizePath } from '@/lib/pathNormalization';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';

export const resolveProjectsForWorktreeChange = (directories: readonly string[]): ProjectRef[] => {
  const byId = new Map<string, ProjectRef>();
  for (const directory of directories) {
    const project = resolveProjectRef(directory);
    if (project && !byId.has(project.id)) byId.set(project.id, project);
  }
  return [...byId.values()];
};

export const resolveProjectForCreatedSession = (
  directory: string,
  projects: ReadonlyArray<ProjectRef>,
): ProjectRef | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  const root = projects.find((project) => normalizePath(project.path) === normalizedDirectory);
  if (root) return { id: root.id, path: root.path };
  for (const worktrees of useSessionUIStore.getState().availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const worktreePath = normalizePath(worktree.path);
      if (worktreePath && (normalizedDirectory === worktreePath || normalizedDirectory.startsWith(`${worktreePath}/`))) {
        return resolveProjectRef(directory);
      }
    }
  }
  return null;
};

export const refreshWorktreeTopologyForChange = async (
  projects: ReadonlyArray<ProjectRef>,
  directories: readonly string[],
  isCancelled: () => boolean = () => false,
): Promise<void> => {
  const affectedProjects = resolveProjectsForWorktreeChange(directories);
  if (affectedProjects.length === 0) return;

  const listings = await Promise.all(affectedProjects.map(async (project) => {
    try {
      return { project, worktrees: await listProjectWorktrees(project, { force: true }) };
    } catch {
      return null;
    }
  }));
  if (isCancelled()) return;

  const published = useSessionUIStore.getState().availableWorktreesByProject;
  let worktreesByProject: Map<string, WorktreeMetadata[]> | null = null;
  for (const listing of listings) {
    if (!listing) continue;
    worktreesByProject = replaceRepositoryWorktrees(
      worktreesByProject ?? published,
      listing.project.path,
      listing.worktrees,
    );
  }
  if (!worktreesByProject) return;

  const partitioned = preserveClientTrackedWorktreeStatus(
    partitionWorktreesByRegisteredProject(projects, worktreesByProject),
    published,
  );
  if (worktreeMapsEqual(partitioned, published)) return;
  useSessionUIStore.setState({
    availableWorktrees: [...partitioned.values()].flat(),
    availableWorktreesByProject: partitioned,
  });
};
