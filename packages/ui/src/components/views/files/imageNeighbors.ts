import { isImageFile } from '@/lib/toolHelpers';

type FolderEntry = { name: string; path: string; type: 'file' | 'directory' };

/**
 * The images before and after `path` among a folder's entries, in the order
 * given (the file tree's), wrapping around at the ends. Null when `path` is
 * not among them or is the folder's only image.
 */
export const imageNeighborsOf = <T extends FolderEntry>(entries: readonly T[], path: string): { previous: T; next: T } | null => {
  const images = entries.filter((entry) => entry.type === 'file' && isImageFile(entry.path));
  const index = images.findIndex((entry) => entry.path === path);
  if (index === -1 || images.length < 2) return null;
  const previous = images[(index - 1 + images.length) % images.length];
  const next = images[(index + 1) % images.length];
  return previous && next ? { previous, next } : null;
};
