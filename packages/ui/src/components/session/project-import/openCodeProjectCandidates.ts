import type { Project } from '@/lib/opencode/model';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { getNormalizedParentDirectory, normalizePath } from '@/lib/pathNormalization';

export type OpenCodeProject = {
  path: string;
  name: string;
  /** The folder holding it, shown beside the name to tell equal names apart. */
  parent: string;
};

const TEMPORARY_ROOT = /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)(?:\/|$)/;
const MACHINE_SEGMENTS = new Set(['AppData', 'Library', 'node_modules', 'Temp']);

// OpenCode records every folder it ever started in: its own config, the temp
// folders of test runs, editor storage, disposable checkouts. Each of these
// sits under a hidden or machine folder.
const isMachineFolder = (path: string): boolean => TEMPORARY_ROOT.test(path)
  || path.split('/').some((segment) => segment.startsWith('.') || MACHINE_SEGMENTS.has(segment));

/**
 * The repositories worth offering from OpenCode's project list, latest first.
 * A folder that is not a repository is left out: home, Documents subfolders
 * and other places OpenCode was merely started in have no project identity.
 */
export const openCodeProjectCandidates = (
  projects: ReadonlyArray<Pick<Project, 'worktree' | 'vcs' | 'name' | 'time'>>,
  configuredPaths: ReadonlySet<string>,
): OpenCodeProject[] => {
  const seen = new Set<string>();
  const candidates: OpenCodeProject[] = [];
  for (const project of [...projects].sort((left, right) => right.time.updated - left.time.updated)) {
    const path = normalizePath(project.worktree);
    if (!path || seen.has(path) || project.vcs !== 'git') continue;
    const parent = getNormalizedParentDirectory(path);
    if (!parent || configuredPaths.has(path) || isChatDirectoryPath(path) || isMachineFolder(path)) continue;
    seen.add(path);
    candidates.push({ path, parent, name: project.name?.trim() || path.slice(path.lastIndexOf('/') + 1) });
  }
  return candidates;
};
