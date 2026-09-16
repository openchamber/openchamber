import type { Session } from '@opencode-ai/sdk/v2';
import { formatDirectoryName } from '@/lib/utils';
import type { WorktreeMetadata } from '@/types/worktree';
import { formatProjectLabel, normalizePath } from '../utils';

type RecentSessionLocation = {
  projectId: string | null;
  groupDirectory: string | null;
  projectLabel: string | null;
  branchLabel: string | null;
};

type RecentProject = {
  id: string;
  label?: string;
  normalizedPath: string;
};

export const buildRecentSessionLocations = ({
  sessions,
  projects,
  availableWorktreesByProject,
  gitBranches,
  homeDirectory,
}: {
  sessions: readonly Session[];
  projects: readonly RecentProject[];
  availableWorktreesByProject: ReadonlyMap<string, readonly WorktreeMetadata[]>;
  gitBranches: ReadonlyMap<string, string | null>;
  homeDirectory: string | null;
}): Map<string, RecentSessionLocation> => {
  const locations = new Map<string, RecentSessionLocation>();
  for (const session of sessions) {
    const directory = normalizePath(session.directory ?? null);
    if (!directory) continue;
    let owner: RecentProject | null = null;
    let ownerLength = -1;
    for (const project of projects) {
      const projectPath = normalizePath(project.normalizedPath);
      if (projectPath && (directory === projectPath || directory.startsWith(`${projectPath}/`)) && projectPath.length > ownerLength) {
        owner = project;
        ownerLength = projectPath.length;
      }
    }
    if (!owner) continue;
    const worktree = availableWorktreesByProject.get(owner.normalizedPath)?.find((entry) => normalizePath(entry.path) === directory);
    const projectLabel = formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath);
    const branch = worktree?.branch?.trim() || gitBranches.get(directory)?.trim() || null;
    locations.set(session.id, {
      projectId: owner.id,
      groupDirectory: directory,
      projectLabel,
      branchLabel: branch && branch !== 'HEAD' && branch !== projectLabel ? branch : null,
    });
  }
  return locations;
};
