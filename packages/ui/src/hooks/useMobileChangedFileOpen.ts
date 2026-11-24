import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TurnFileRequest } from './useMobileChangesNavigation';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import type { GitAPI } from '@/lib/api/types';
import {
  beginChangedFileOpen,
  createLatestRequestGate,
  openChangedFileWithoutRepository,
} from '@/components/views/files/openChangedFileWithoutRepository';
import { useGitStore } from '@/stores/useGitStore';
import { useMobileAppActions } from '@/apps/mobileAppContext';

const STATUS_READ_ATTEMPTS = 2;

export const readDirectoryStatus = async (directory: string, git: GitAPI): Promise<boolean> => {
  const lastRead = () => useGitStore.getState().directories.get(directory)?.lastStatusFetch ?? 0;
  let ownReadFailed = false;
  const failOwnRead = (error: Error): never => {
    ownReadFailed = true;
    throw error;
  };
  const ownGit: GitAPI = {
    ...git,
    checkIsGitRepository: (...args) => git.checkIsGitRepository(...args).catch(failOwnRead),
    getGitStatus: (...args) => git.getGitStatus(...args).catch(failOwnRead),
  };
  for (let attempt = 0; attempt < STATUS_READ_ATTEMPTS; attempt += 1) {
    const previousRead = lastRead();
    const startedAt = Date.now();
    await useGitStore.getState().fetchStatus(directory, ownGit, { silent: true });
    if (ownReadFailed) return false;
    if (lastRead() > previousRead || lastRead() >= startedAt) return true;
  }
  return false;
};

export const useMobileChangedFileOpen = ({ request, rootDirectory, setRequest, showWorkingList }: {
  request: TurnFileRequest | null;
  rootDirectory: string;
  setRequest: (request: null) => void;
  showWorkingList: () => void;
}): void => {
  const { files } = useRuntimeAPIs();
  const mobileActions = useMobileAppActions();
  React.useEffect(() => {
    if (request?.step !== 'open') return;
    const sessionFolder = request.directory || rootDirectory;
    const gate = createLatestRequestGate();
    const isCurrent = beginChangedFileOpen(gate, request.panelSessionId);
    void openChangedFileWithoutRepository(toAbsoluteFilePath(sessionFolder, request.file), sessionFolder, files, isCurrent).then((opened) => {
      if (!isCurrent()) return;
      if (!opened) {
        showWorkingList();
        return;
      }
      setRequest(null);
      mobileActions?.openFiles();
    });
    return () => gate.cancel();
  }, [files, mobileActions, request, rootDirectory, setRequest, showWorkingList]);
};
