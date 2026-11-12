import React from 'react';
import {
  NO_ROW_GUEST_MARKS,
  guestBranchMarkKey,
  mergeRowGuestMarks,
  type RowGuestMark,
} from '@/lib/guests/marks';
import { useGuestMarksStore } from '@/lib/guests/marks-store';

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
export const useRowGuestMarks = ({ sessionId, projectId, branch, folder, containerFolder }: RowGuestMarkKeys): readonly RowGuestMark[] => {
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
