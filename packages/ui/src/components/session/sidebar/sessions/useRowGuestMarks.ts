import React from 'react';
import {
  NO_ROW_GUEST_MARKS,
  guestBranchMarkKey,
  mergeRowGuestMarks,
  type RowGuestMark,
} from '@/lib/guests/marks';
import { useGuestMarksStore } from '@/lib/guests/marks-store';
import { normalizePath } from '@/lib/pathNormalization';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useGitBranchLabel } from '@/stores/useGitStore';

type RowGuestMarkKeys = {
  /** Null for a row that is no session (a worktree's row). */
  sessionId: string | null;
  /** The row's project and branch; a row that does not know both shows no branch mark. */
  projectId: string | null;
  branch: string | null;
  /** The row's own folder and, when it lies in a worktree or the project root, that folder. Normalized. */
  folder: string | null;
  containerFolder: string | null;
};

/**
 * The marks extensions put on one sidebar row: its session's, its branch's
 * and its folder's, one per extension, the most specific first, in catalog
 * order. Each key is read by itself and the lists it finds keep their
 * identity while their content does, so a mark set on another row does not
 * render this one. Null keys read nothing: a row that shows no marks (an
 * isolated space's) passes them all null.
 */
type SessionRowMarkPlace = {
  /** False where no row shows marks (VS Code). */
  shown: boolean;
  sessionId: string;
  /** The session's folder, normalized. */
  directory: string | null;
  projectId: string | null;
  /** The project's root as the projects store has it. */
  projectRoot: string | null;
  worktree: { path?: string | null; branch?: string | null } | null | undefined;
  /** A row of the project tree, outside the archive: a session in a subfolder of the root lies in the root there. */
  inProjectTree: boolean;
  /** The branch the row's metadata names; null for a space's row, which names its space there. */
  metaBranch: string | null;
};

/**
 * A session row's marks, keyed the same on the desktop sidebar and the phone's:
 * the session's own, its branch's and its folder's, and the folder that holds
 * it (its worktree, else the project root). An isolated space's rows show
 * none, since no service hears of a space's sessions. The branch is the one
 * the row already knows, live Git state first, so a root switched to another
 * branch does not keep the old branch's mark.
 */
export const useSessionRowGuestMarks = (place: SessionRowMarkPlace): readonly RowGuestMark[] => {
  const off = !place.shown || isSpaceDirectory(place.directory);
  const root = normalizePath(place.projectRoot);
  const directory = place.directory;
  const container = off
    ? null
    : normalizePath(place.worktree?.path ?? null) ?? (root && directory && (
      directory === root || (place.inProjectTree && directory.startsWith(`${root}/`))
    ) ? root : null);
  const liveBranch = useGitBranchLabel(off ? null : directory);
  const liveContainerBranch = useGitBranchLabel(container);
  const branch = off
    ? null
    : liveBranch || liveContainerBranch || place.worktree?.branch?.trim() || place.metaBranch?.trim() || null;
  return useRowGuestMarks({
    sessionId: off ? null : place.sessionId,
    projectId: off ? null : place.projectId,
    branch,
    folder: off ? null : directory,
    containerFolder: container,
  });
};

/**
 * A worktree work row's marks: its branch's and its folder's, the branch read
 * as its sessions' rows read it, live Git state first. A space's row shows
 * none, as its sessions' rows do.
 */
export const useWorkRowGuestMarks = ({ space, projectId, directory, branch }: {
  space: boolean;
  projectId: string | null;
  /** Normalized. */
  directory: string | null;
  branch: string | null;
}): readonly RowGuestMark[] => {
  const liveBranch = useGitBranchLabel(space ? null : directory);
  return useRowGuestMarks({
    sessionId: null,
    projectId: space ? null : projectId,
    branch: space ? null : liveBranch || branch,
    folder: space ? null : directory,
    containerFolder: null,
  });
};

const useRowGuestMarks = ({ sessionId, projectId, branch, folder, containerFolder }: RowGuestMarkKeys): readonly RowGuestMark[] => {
  const ofSession = useGuestMarksStore((state) => (sessionId ? state.bySession.get(sessionId) : undefined) ?? NO_ROW_GUEST_MARKS);
  const branchKey = projectId && branch ? guestBranchMarkKey(projectId, branch) : null;
  const ofBranch = useGuestMarksStore((state) => (branchKey ? state.byBranch.get(branchKey) : undefined) ?? NO_ROW_GUEST_MARKS);
  const ofFolder = useGuestMarksStore((state) => (folder ? state.byFolder.get(folder) : undefined) ?? NO_ROW_GUEST_MARKS);
  const container = containerFolder && containerFolder !== folder ? containerFolder : null;
  const ofContainer = useGuestMarksStore((state) => (container ? state.byFolder.get(container) : undefined) ?? NO_ROW_GUEST_MARKS);
  return React.useMemo(
    () => mergeRowGuestMarks([ofSession, ofBranch, ofFolder, ofContainer]),
    [ofSession, ofBranch, ofFolder, ofContainer],
  );
};
