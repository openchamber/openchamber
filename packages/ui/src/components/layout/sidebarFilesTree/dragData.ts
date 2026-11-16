import { INTERNAL_FILE_PATH_TYPE } from '@/components/chat/composer/attachments/dataTransfer';
import { getFileTreeDragSource, type FileTreeEntry } from '../fileTreeMoveDrag';
import { getRelativePath } from './treePaths';

export const hasExternalFiles = (dataTransfer: DataTransfer): boolean => (
  Array.from(dataTransfer.types).includes('Files')
);

/** The tree row drag in progress, when this drag event belongs to it. */
export const getMoveDragSource = (dataTransfer: DataTransfer): FileTreeEntry | null => (
  Array.from(dataTransfer.types).includes(INTERNAL_FILE_PATH_TYPE) ? getFileTreeDragSource() : null
);

/**
 * The drag data is readable only on drop: check that it is the row the tree
 * recorded, so a source left behind by a drag that never ended moves nothing.
 */
export const isDropOfMoveSource = (dataTransfer: DataTransfer, root: string, source: FileTreeEntry): boolean => (
  dataTransfer.getData(INTERNAL_FILE_PATH_TYPE) === getRelativePath(root, source.path)
);

export const getExternalFiles = (dataTransfer: DataTransfer): File[] => {
  const items = Array.from(dataTransfer.items);
  if (items.length === 0) return Array.from(dataTransfer.files);

  return items.flatMap((item) => {
    if (item.kind !== 'file' || item.webkitGetAsEntry()?.isDirectory) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
};
