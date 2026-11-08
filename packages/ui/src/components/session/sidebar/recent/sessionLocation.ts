import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DirectoryOwner } from '../sessions/sessionOwnership';
import { formatDirectoryName } from '@/lib/utils';
import { formatProjectLabel, isPathWithinProject, normalizePath } from '../utils';
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
  /** True for a session of an isolated space: `branchLabel` is then the space's name, not a branch. */
  inSpace: boolean;
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
   * Resolved branch of each project's root directory, used when no live
   * status for the root is loaded yet. It also labels sessions in a project
   * subdirectory that has no live branch of its own.
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

// The live branch of the nearest directory at or above `directory` inside the
// project: a session can sit in a nested checkout of the project, whose branch
// differs from the project root's, and a status read for that checkout (or a
// directory inside it) already knows the right one.
const liveBranchAtOrAbove = (
  directory: string,
  projectRoot: string,
  gitBranches: ReadonlyMap<string, string | null>,
): string | null => {
  let current = directory;
  while (current.startsWith(`${projectRoot}/`)) {
    const branch = gitBranches.get(current)?.trim();
    if (branch) return branch;
    const separator = current.lastIndexOf('/');
    if (separator <= 0) break;
    current = current.slice(0, separator);
  }
  return gitBranches.get(projectRoot)?.trim() || null;
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
    // The resolved owner stays authoritative: a containing worktree only
    // labels this session when it belongs to that same project. The longest
    // prefix covers sessions inside `<worktree>/sub`.
    const worktreeHit = findPrefixWorktreeEntry(directory, worktreeByPath);
    const worktree = worktreeHit && worktreeHit.project.id === owner.id ? worktreeHit.meta : null;
    const projectLabel = formatProjectLabel(owner.label?.trim() || formatDirectoryName(owner.normalizedPath, homeDirectory) || owner.normalizedPath);
    const projectRoot = normalizePath(owner.normalizedPath);
    // A session can live in a subdirectory of its project (a chat started in
    // a folder inside the repo). It has no worktree of its own and no git
    // status is read for that directory, so the nearest live branch inside
    // the project is the branch above it. A containing worktree still owns
    // its sessions, even when that branch is not known yet.
    const rootBranch = !worktree && projectRoot && isPathWithinProject(directory, projectRoot)
      ? liveBranchAtOrAbove(directory, projectRoot, gitBranches)
        || rootBranchByProjectId?.get(owner.id)?.trim()
        || null
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
      inSpace: false,
      worktree,
    });
  }
  return locations;
};
