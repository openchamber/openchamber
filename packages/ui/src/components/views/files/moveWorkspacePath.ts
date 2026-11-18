import { isFilesystemError } from '@/lib/api/files-errors';
import type { FilesAPI } from '@/lib/api/types';
import { beginFilePathMove } from '@/lib/filePathMoves';
import { useUIStore } from '@/stores/useUIStore';

type WorkspacePathMoveResult = 'moved' | 'conflict' | 'failed';

export const moveWorkspacePath = async (
  files: FilesAPI,
  directories: { tabs: string; files: string },
  fromPath: string,
  toPath: string,
): Promise<WorkspacePathMoveResult> => {
  if (!files.rename) return 'failed';

  const move = beginFilePathMove(fromPath);
  try {
    const result = await files.rename(fromPath, toPath);
    if (!result.success) {
      move.abort();
      return 'failed';
    }
  } catch (error) {
    move.abort();
    return isFilesystemError(error) && error.reason === 'already-exists' ? 'conflict' : 'failed';
  }

  move.commit(toPath);
  useUIStore.getState().moveContextFilePaths(directories.tabs, fromPath, toPath, directories.files);
  return 'moved';
};
