import { resolveProjectRef } from '@/lib/worktreeSessionCreator';
import {
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  preserveClientTrackedWorktreeStatus,
  replaceRepositoryWorktrees,
  worktreeMapsEqual,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';

/**
 * Registered projects that own any of the directories a `worktree-changed`
 * event names. Directories are matched through the known worktree map first,
 * so a linked worktree resolves to the project that registered its repository.
 * Each project appears once.
 */
export const resolveProjectsForWorktreeChange = (directories: readonly string[]): ProjectRef[] => {
  const byId = new Map<string, ProjectRef>();
  for (const directory of directories) {
    const project = resolveProjectRef(directory);
    if (project && !byId.has(project.id)) byId.set(project.id, project);
  }
  return [...byId.values()];
};

/**
 * Refresh the published worktree topology for every registered project a
 * `worktree-changed` event touches, bypassing the listing cache. Used by the
 * surfaces that keep no separate raw topology (hosted mobile, mini chat).
 *
 * Each project is listed on its own; a failed listing keeps that project's
 * last known worktrees and does not block the others. Nothing is published
 * once `isCancelled` reports true or when the result equals the current map.
 */
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
