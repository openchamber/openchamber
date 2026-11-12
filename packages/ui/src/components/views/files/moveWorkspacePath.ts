import { isFilesystemError } from '@/lib/api/files-errors';
import type { FilesAPI } from '@/lib/api/types';
import { beginFilePathMove } from '@/lib/filePathMoves';
import { useUIStore } from '@/stores/useUIStore';

type WorkspacePathMoveResult = 'moved' | 'conflict' | 'failed';

/**
 * Moves or renames a workspace path, then points open tabs, the selected file
 * and expanded folders at the new path. The open editor adopts the new path
 * with its unsaved edits (see `lib/filePathMoves.ts`); it holds back saves of
 * the source while the request is in flight. `directories.tabs` is the folder
 * the panel's tabs are kept under, `directories.files` the workspace root the
 * tree keeps its selection under; they differ only in a draft waiting for a space.
 */
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
