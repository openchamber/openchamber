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
  sessionId: string | null;
  projectId: string | null;
  branch: string | null;
  folder: string | null;
  containerFolder: string | null;
};

type SessionRowMarkPlace = {
  shown: boolean;
  sessionId: string;
  directory: string | null;
  projectId: string | null;
  projectRoot: string | null;
  worktree: { path?: string | null; branch?: string | null } | null | undefined;
  inProjectTree: boolean;
  metaBranch: string | null;
};

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

export const useWorkRowGuestMarks = ({ space, projectId, directory, branch }: {
  space: boolean;
  projectId: string | null;
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
