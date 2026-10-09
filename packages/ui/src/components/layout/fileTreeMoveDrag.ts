import { rebaseMovedPath } from '@/lib/filePathMoves';

/**
 * Drag-to-move in the files tree.
 *
 * Rows already start a native drag that carries the file path for the chat.
 * The same drag moves the entry when it is dropped on a folder in the tree, so
 * the drop target alone decides what happens. During `dragover` the browser
 * hides the drag data, so the row records here what is being dragged. Only
 * one native drag runs at a time, which makes module state safe.
 */

export type FileTreeEntry = {
  path: string;
  type: 'file' | 'directory';
};

let activeDragSource: FileTreeEntry | null = null;

export const setFileTreeDragSource = (source: FileTreeEntry | null): void => {
  activeDragSource = source;
};

export const getFileTreeDragSource = (): FileTreeEntry | null => activeDragSource;

const getParentPath = (path: string): string => {
  const separatorIndex = path.lastIndexOf('/');
  if (separatorIndex < 0) return '';
  if (separatorIndex === 0) return '/';
  return path.slice(0, separatorIndex);
};

/**
 * The folder a drop would move `source` into, or null when the drop changes
 * nothing or cannot work. A file row stands for the folder it is in, and
 * empty space below the tree (`over` null) for `root`, as in VS Code.
 */
export const getFileTreeMoveTarget = (
  source: FileTreeEntry,
  over: FileTreeEntry | null,
  root: string,
): string | null => {
  const directory = over === null ? root : (over.type === 'directory' ? over.path : getParentPath(over.path));
  if (!directory) return null;
  // Already there.
  if (getParentPath(source.path) === directory) return null;
  // Into itself or into one of its own folders.
  if (source.type === 'directory' && rebaseMovedPath(directory, source.path, source.path) !== null) return null;
  return directory;
};

/** Where `source` lands when moved into `directory`. */
export const getFileTreeMovedPath = (source: FileTreeEntry, directory: string): string => {
  const name = source.path.slice(source.path.lastIndexOf('/') + 1);
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
};
