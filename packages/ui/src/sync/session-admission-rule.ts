import type { ProjectEntry } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';
import { resolveGlobalSessionDirectory } from '@/stores/globalSessionStructure';
import type { WorktreeMetadata } from '@/types/worktree';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { isSpaceArchiveDirectory } from '@/lib/spaces/space-archives';

const MAX_LINEAGE_DEPTH = 8;

export const resolveAdmittedLineageDirectory = (
  sessionId: string,
  records: ReadonlyMap<string, Session>,
  isAdmitted: (directory: string | null) => boolean,
): string | null => {
  let current = records.get(sessionId);
  for (let depth = 0; current && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    const directory = resolveGlobalSessionDirectory(current);
    if (isAdmitted(directory)) return normalizePath(directory);
    current = current.parentID ? records.get(current.parentID) : undefined;
  }
  return null;
};

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
