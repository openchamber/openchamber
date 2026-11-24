import React from 'react';
import { findRepoFile, toAbsoluteFilePath } from '@/lib/path-utils';
import { findFileRepository } from '@/lib/nestedRepositories';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore, type NestedRepoDiscovery } from '@/stores/useGitStore';
import type { FilesAPI } from '@/lib/api/types';
import type { TurnSnapshotDiff } from '../turnSnapshotDiff';
import {
  beginChangedFileOpen, createLatestRequestGate, isProjectFileOutsideRepositories, openChangedFileWithoutRepository,
} from '../files/openChangedFileWithoutRepository';

export function useTurnChipNavigation(options: {
  visible: boolean;
  isTurnScope: boolean;
  currentSessionId: string | null;
  turnDiffSettled: boolean;
  lastTurnDiffs: readonly TurnSnapshotDiff[];
  rootDirectory: string | undefined;
  effectiveDirectory: string | undefined;
  rootIsGitRepo: boolean | null;
  nestedRepos: NestedRepoDiscovery | undefined;
  repositoryOptions: readonly string[] | undefined;
  files: FilesAPI;
  reveal: (path: string) => void;
}) {
  const {
    visible, isTurnScope, currentSessionId, turnDiffSettled, lastTurnDiffs, rootDirectory, effectiveDirectory,
    rootIsGitRepo, nestedRepos, repositoryOptions, files, reveal,
  } = options;
  const pendingTurnDiffFile = useUIStore((state) => state.pendingTurnDiffFile);
  const [gate] = React.useState(createLatestRequestGate);

  React.useEffect(() => {
    if (!pendingTurnDiffFile || !visible || !isTurnScope) return;
    const ui = useUIStore.getState();
    if (pendingTurnDiffFile.panelSessionId !== currentSessionId) {
      ui.setPendingTurnDiffFile(null);
      return;
    }
    if (!turnDiffSettled) return;
    ui.setPendingTurnDiffFile(null);
    const file = toAbsoluteFilePath(rootDirectory, pendingTurnDiffFile.file);
    const listed = findRepoFile(file, rootDirectory, lastTurnDiffs.flatMap((diff) => diff.file ?? []));
    if (listed) {
      reveal(listed);
      return;
    }
    const repositories = repositoryOptions ?? [];
    if (rootDirectory && isProjectFileOutsideRepositories(file, { rootDirectory, rootIsGitRepo, nestedRepos, repositories })) {
      void openChangedFileWithoutRepository(file, rootDirectory, files, beginChangedFileOpen(gate, currentSessionId));
      return;
    }
    const repository = findFileRepository(file, [
      ...(rootIsGitRepo && rootDirectory ? [rootDirectory] : []),
      ...repositories,
    ]);
    if (repository && repository !== effectiveDirectory && rootDirectory) {
      useGitStore.getState().selectNestedRepo(rootDirectory, repository);
    }
    ui.setPendingDiffFile(file, false, 'working');
  }, [currentSessionId, effectiveDirectory, files, gate, isTurnScope, lastTurnDiffs, nestedRepos, pendingTurnDiffFile, repositoryOptions, reveal, rootDirectory, rootIsGitRepo, turnDiffSettled, visible]);
}
