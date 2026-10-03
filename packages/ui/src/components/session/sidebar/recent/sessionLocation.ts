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
  worktree: WorktreeMetadata | null;
};

type ResolveArgs = {
  sessions: readonly Session[];
  projects: readonly SidebarSessionLocationProject[];
  /**
   * Authoritative session → owner index. Managed worktrees live outside the
   * project path (OpenCode keeps them under its data directory), so a path
   * prefix match alone never finds their project.
   */
  ownerBySessionId: ReadonlyMap<string, DirectoryOwner>;
  availableWorktreesByProject: ReadonlyMap<string, WorktreeMetadata[]>;
  gitBranches: ReadonlyMap<string, string | null>;
  homeDirectory: string | null;
  /**
   * Live branch of each project's root directory. Supplied by surfaces that
   * show the branch for root-directory sessions too; Recent omits it because
   * it only labels worktree rows.
   */
  rootBranchByProjectId?: ReadonlyMap<string, string | null>;
  /**
   * Recent hides a branch that repeats the project label, because the row
   * already carries that label. Timeline shows both lines unconditionally.
   */
  hideBranchMatchingProjectLabel: boolean;
  /**
   * The display name of each isolated space by id. A session owned by a space
   * is labelled with the space's name where a worktree session shows its
   * branch, and its group is the space's directory.
   */
  spaceLabelById?: ReadonlyMap<string, string>;
};

// One owner for "where does this session live": the project it belongs to, the
// directory that owns its folder scope, and the branch to show beside it.
// Recent and Timeline both read their row metadata from here.
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
  // Canonical exact worktree index (normalized keys, project-root exclusion,
  // first-wins dedupe) shared with grouping and the switcher. One build per
  // resolve pass; the longest-prefix walk below reuses it for subdirectories.
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
    // The resolved owner stays authoritative: a containing worktree only
    // labels this session when it belongs to that same project. The longest
    // prefix covers sessions inside `<worktree>/sub`.
    const worktreeHit = findPrefixWorktreeEntry(directory, worktreeByPath);
    const worktree = worktreeHit && worktreeHit.project.id === owner.id ? worktreeHit.meta : null;
    const projectLabel = formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath);
    const rootBranch = normalizePath(owner.normalizedPath) === directory
      ? rootBranchByProjectId?.get(owner.id)?.trim() || null
      : null;
    // Live-first: a live git status wins over discovered worktree metadata.
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
      worktree,
    });
  }
  return locations;
};
