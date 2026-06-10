import { normalizeWindowsDriveLetter } from './pathUtils';

export type WorkingDirectoryChange =
  | { changed: false; path: string }
  | { changed: true; path: string };

export function resolveWorkingDirectoryChange(
  currentDirectory: string,
  nextDirectory: string
): WorkingDirectoryChange {
  const normalized = normalizeWindowsDriveLetter(nextDirectory.trim());
  if (currentDirectory === normalized) {
    return { changed: false, path: normalized };
  }
  return { changed: true, path: normalized };
}
