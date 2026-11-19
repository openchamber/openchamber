import { createFolderChangeWatch } from '../fs/folder-change-watch.js';
import type { FolderWatchTimer } from '../fs/folder-change-watch.js';
import type fs from 'node:fs/promises';
import type nodePath from 'node:path';

export interface ThemeFolderWatchOptions<Timer extends FolderWatchTimer> extends Pick<Parameters<typeof createFolderChangeWatch<Timer>>[0], 'onChange' | 'logger' | 'fsWatch' | 'timers'> {
  fsPromises: Pick<typeof fs, 'readdir' | 'stat'>;
  path: Pick<typeof nodePath, 'join'>;
  themesDir: string;
  pollMs?: number;
}

const POLL_MS = 1000;

export const createThemeFolderWatch = <Timer extends FolderWatchTimer = ReturnType<typeof setTimeout>>({ fsPromises, path, themesDir, onChange, pollMs = POLL_MS, logger = console, fsWatch, timers }: ThemeFolderWatchOptions<Timer>) => {
  const fingerprint = async () => {
    const names = await fsPromises.readdir(themesDir).catch(() => []);
    const themes = names.filter((name) => name.toLowerCase().endsWith('.json')).sort();
    const stamps = await Promise.all(themes.map((name) => fsPromises.stat(path.join(themesDir, name)).then(
      (stat) => `${stat.mtimeMs}:${stat.size}`,
      () => 'missing',
    )));
    return themes.map((name, index) => `${name}=${stamps[index]}`).join('\n');
  };

  return createFolderChangeWatch({ root: themesDir, fingerprint, onChange, pollMs, logger, fsWatch, timers });
};
