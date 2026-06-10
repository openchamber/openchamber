import { normalizeWindowsDriveLetter } from './pathUtils';

export type WorkingDirectoryChange =
  | { changed: false; path: string; restarted: false }
  | { changed: true; path: string; restarted: false };

export function resolveWorkingDirectoryChange(
  currentDirectory: string,
  nextDirectory: string
): WorkingDirectoryChange {
  const normalized = normalizeWindowsDriveLetter(nextDirectory.trim());
  if (currentDirectory === normalized) {
    return { changed: false, path: normalized, restarted: false };
  }
  return { changed: true, path: normalized, restarted: false };
}
