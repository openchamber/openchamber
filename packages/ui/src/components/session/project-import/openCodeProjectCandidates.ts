import type { Project } from '@/lib/opencode/model';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { getNormalizedParentDirectory, normalizePath } from '@/lib/pathNormalization';

export type OpenCodeProject = {
  path: string;
  name: string;
  parent: string;
};

const TEMPORARY_ROOT = /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)(?:\/|$)/;
const MACHINE_SEGMENTS = new Set(['AppData', 'Library', 'node_modules', 'Temp']);

const isMachineFolder = (path: string): boolean => TEMPORARY_ROOT.test(path)
  || path.split('/').some((segment) => segment.startsWith('.') || MACHINE_SEGMENTS.has(segment));

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
