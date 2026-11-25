import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

import { directoryReachability } from '../directory-reachability/index.js';

const REFRESH_COOLDOWN_MS = 5000;

export const isUsableDirectory = async (directory: string | null) => {
  if (!directory || await directoryReachability.check(directory) !== 'available') return false;
  try {
    if (!(await stat(directory)).isDirectory()) return false;
    await access(directory, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const usableDirectories = async (directories: Array<string | null>) => {
  if (!Array.isArray(directories)) return [];
  const checked = await Promise.all(directories.map(async (directory) => (await isUsableDirectory(directory) ? directory : null)));
  return checked.filter((directory) => directory !== null);
};

export const createDefaultDirectory = ({ getWarmupDirectories, noProjectDirectory, now }: {
  getWarmupDirectories: () => Promise<Array<string | null>>;
  noProjectDirectory: string | null;
  now: () => number;
}) => {
  let current: string | null = null;
  let warmed: string[] = [];
  let refreshing: Promise<void> | null = null;
  let refreshedAt = 0;
  let selection = 0;

  const refresh = () => {
    if (refreshing) return refreshing;
    const startedAt = selection;
    refreshing = (async () => {
      try {
        const usable = await usableDirectories(await getWarmupDirectories());
        if (selection !== startedAt) return;
        warmed = usable;
        if (usable[0]) current = usable[0];
      } catch {
        void 0;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  return {
    get: async () => {
      const candidate = current;
      if (await isUsableDirectory(candidate)) return candidate;
      const alternate = (await usableDirectories(warmed))[0];
      if (alternate) {
        if (current === candidate) current = alternate;
        return alternate;
      }
      const checkedAt = now();
      if (!refreshing && checkedAt - refreshedAt >= REFRESH_COOLDOWN_MS) {
        refreshedAt = checkedAt;
        void refresh();
      }
      return await isUsableDirectory(noProjectDirectory) ? noProjectDirectory : null;
    },
    note: async (directory: string | null, isAllowed: (directory: string) => Promise<boolean> = async () => true) => {
      if (!directory) return;
      selection += 1;
      const own = selection;
      if (!await isAllowed(directory) || !await isUsableDirectory(directory) || selection !== own) return;
      current = directory;
      warmed = [directory, ...warmed.filter((entry) => entry !== directory)];
    },
    warm: async () => {
      const startedAt = selection;
      const directories = await getWarmupDirectories().catch(() => []);
      if (!Array.isArray(directories) || directories.length === 0) return [];
      const usable = await usableDirectories(directories);
      if (selection === startedAt) {
        warmed = usable;
        current = usable[0] ?? null;
      }
      return directories;
    },
  };
};
