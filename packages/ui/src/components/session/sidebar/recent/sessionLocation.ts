import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DirectoryOwner } from '../sessions/sessionOwnership';
import { formatDirectoryName } from '@/lib/utils';
import { formatProjectLabel, normalizePath } from '../utils';
import { buildWorktreeByPathIndex, findPrefixWorktreeEntry, resolveBranchLiveFirst } from '../worktreeIndex';

type SidebarSessionLocationProject = {
  id: string;
  label?: string;
  normalizedPath: string;
};

export type SidebarSessionLocation = {
  projectId: string | null;
  groupDirectory: string | null;
  projectLabel: string | null;
  branchLabel: string | null;
  inSpace: boolean;
  worktree: WorktreeMetadata | null;
};

type ResolveArgs = {
  sessions: readonly Session[];
  projects: readonly SidebarSessionLocationProject[];
  ownerBySessionId: ReadonlyMap<string, DirectoryOwner>;
  availableWorktreesByProject: ReadonlyMap<string, WorktreeMetadata[]>;
  gitBranches: ReadonlyMap<string, string | null>;
  homeDirectory: string | null;
  rootBranchByProjectId?: ReadonlyMap<string, string | null>;
  hideBranchMatchingProjectLabel: boolean;
  spaceLabelById?: ReadonlyMap<string, string>;
};

export const resolveSidebarSessionLocations = ({
  sessions,
  projects,
  ownerBySessionId,
  availableWorktreesByProject,
  gitBranches,
  homeDirectory,
  rootBranchByProjectId,
  hideBranchMatchingProjectLabel,
  spaceLabelById,
}: ResolveArgs): Map<string, SidebarSessionLocation> => {
  const locations = new Map<string, SidebarSessionLocation>();
  const worktreeByPath = buildWorktreeByPathIndex(availableWorktreesByProject, projects);
  for (const session of sessions) {
    const directory = normalizePath(session.directory ?? null);
    if (!directory) continue;
    const indexedOwner = ownerBySessionId.get(session.id) ?? null;
    const indexedOwnerId = indexedOwner?.projectId ?? null;
    let owner: SidebarSessionLocationProject | null = indexedOwnerId
      ? projects.find((project) => project.id === indexedOwnerId) ?? null
      : null;
    if (owner && indexedOwner?.kind === 'space') {
      locations.set(session.id, {
        projectId: owner.id,
        groupDirectory: indexedOwner.scopeDirectory,
        projectLabel: formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath),
        branchLabel: (indexedOwner.spaceId && spaceLabelById?.get(indexedOwner.spaceId)) || null,
        inSpace: true,
        worktree: null,
      });
      continue;
    }
    if (!owner) {
      let ownerLength = -1;
      for (const project of projects) {
        const projectPath = normalizePath(project.normalizedPath);
        if (projectPath && (directory === projectPath || directory.startsWith(`${projectPath}/`)) && projectPath.length > ownerLength) {
          owner = project;
          ownerLength = projectPath.length;
        }
      }
    }
    if (!owner) continue;
    const worktreeHit = findPrefixWorktreeEntry(directory, worktreeByPath);
    const worktree = worktreeHit && worktreeHit.project.id === owner.id ? worktreeHit.meta : null;
    const projectLabel = formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath);
    const rootBranch = normalizePath(owner.normalizedPath) === directory
      ? rootBranchByProjectId?.get(owner.id)?.trim() || null
      : null;
    const branch = resolveBranchLiveFirst(
      directory,
      worktree ? normalizePath(worktree.path) : null,
      worktree?.branch,
      gitBranches,
    ) ?? rootBranch;
    const hidden = !branch
      || branch === 'HEAD'
      || (hideBranchMatchingProjectLabel && branch === projectLabel);
    locations.set(session.id, {
      projectId: owner.id,
      groupDirectory: directory,
      projectLabel,
      branchLabel: hidden ? null : branch,
      inSpace: false,
      worktree,
    });
  }
  return locations;
};
