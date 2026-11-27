import { rebaseMovedPath } from '@/lib/filePathMoves';
import { getParentPath } from './sidebarFilesTree/treePaths';

// external: https://html.spec.whatwg.org/multipage/dnd.html#the-drag-data-store Drag data is protected during dragover, so record the source at dragstart.

export type FileTreeEntry = {
  path: string;
  type: 'file' | 'directory';
};

let activeDragSource: FileTreeEntry | null = null;

export const setFileTreeDragSource = (source: FileTreeEntry | null): void => {
  activeDragSource = source;
};

export const getFileTreeDragSource = (): FileTreeEntry | null => activeDragSource;

export const getFileTreeMoveTarget = (
  source: FileTreeEntry,
  over: FileTreeEntry | null,
  root: string,
): string | null => {
  const directory = over === null ? root : (over.type === 'directory' ? over.path : getParentPath(over.path));
  if (!directory) return null;
  if (getParentPath(source.path) === directory) return null;
  if (source.type === 'directory' && rebaseMovedPath(directory, source.path, source.path) !== null) return null;
  return directory;
};

export const getFileTreeMovedPath = (source: FileTreeEntry, directory: string): string => {
  const name = source.path.slice(source.path.lastIndexOf('/') + 1);
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
};
