import { isFilesystemError } from '@/lib/api/files-errors';
import type { FilesAPI } from '@/lib/api/types';
import { beginFilePathMove } from '@/lib/filePathMoves';
import { useUIStore } from '@/stores/useUIStore';

type WorkspacePathMoveResult = 'moved' | 'conflict' | 'failed';

/**
 * Moves or renames a workspace path, then points open tabs, the selected file
 * and expanded folders at the new path. The open editor adopts the new path
 * with its unsaved edits (see `lib/filePathMoves.ts`); it holds back saves of
 * the source while the request is in flight. `directory` is the workspace root
 * the tabs are kept under.
 */
export const moveWorkspacePath = async (
  files: FilesAPI,
  directory: string,
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
  useUIStore.getState().moveContextFilePaths(directory, fromPath, toPath);
  return 'moved';
};
