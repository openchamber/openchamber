import {
  readContextFileExistence,
  toastContextFileOpenFailure,
  validateContextFileOpen,
} from '@/lib/contextFileOpenGuard';
import type { FilesAPI } from '@/lib/api/types';
import type { NestedRepoDiscovery } from '@/stores/useGitStore';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { findFileRepository } from '@/lib/nestedRepositories';
import { isFilePathWithinDirectory } from '@/lib/path-utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

type RepositoryKnowledge = {
  rootDirectory: string | null | undefined;
  rootIsGitRepo: boolean | null;
  nestedRepos: NestedRepoDiscovery | undefined;
  repositories: readonly string[];
};

export const isProjectFileOutsideRepositories = (
  file: string,
  { rootDirectory, rootIsGitRepo, nestedRepos, repositories }: RepositoryKnowledge,
): boolean => {
  if (!rootDirectory || rootIsGitRepo !== false || !Array.isArray(nestedRepos)) return false;
  if (!isFilePathWithinDirectory(file, rootDirectory)) return false;
  return findFileRepository(file, [...nestedRepos, ...repositories]) === null;
};

export const createLatestRequestGate = () => {
  let generation = 0;
  return {
    begin: (): (() => boolean) => {
      generation += 1;
      const id = generation;
      return () => id === generation;
    },
    cancel: (): void => {
      generation += 1;
    },
  };
};

type LatestRequestGate = ReturnType<typeof createLatestRequestGate>;

export const beginChangedFileOpen = (gate: LatestRequestGate, sessionId: string | null): (() => boolean) => {
  const isLatest = gate.begin();
  const isCurrentRuntime = captureRuntimeInstance();
  return () => isLatest()
    && isCurrentRuntime()
    && useSessionUIStore.getState().currentSessionId === sessionId;
};

export const openChangedFileWithoutRepository = async (
  file: string,
  rootDirectory: string,
  files: FilesAPI,
  isCurrent: () => boolean,
): Promise<boolean> => {
  const options = { directory: rootDirectory };
  const existence = await readContextFileExistence(files, file, options);
  if (!isCurrent()) return false;
  if (existence === 'missing') {
    toastContextFileOpenFailure(file, { reason: 'missing' });
    return false;
  }
  const validation = await validateContextFileOpen(files, file, options);
  if (!isCurrent()) return false;
  if (!validation.ok) {
    toastContextFileOpenFailure(file, validation);
    return false;
  }
  useUIStore.getState().openContextFile(rootDirectory, file);
  return true;
};
