import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { isSpaceArchiveDirectory } from '@/lib/spaces/space-archives';

/** A host destination becomes visible only after trust and project registration. */
export const isSessionDirectoryAdmitted = (
  directory: string | null | undefined,
  projects: ProjectEntry[],
  worktrees: Map<string, WorktreeMetadata[]>,
): boolean => {
  const normalized = normalizePath(directory);
  if (!normalized) return false;
  return isChatDirectoryPath(normalized) || isSpaceDirectory(normalized) || isSpaceArchiveDirectory(normalized)
    || resolveProjectForSessionDirectory(projects, worktrees, normalized) !== null;
};
