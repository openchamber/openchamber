import { createFolderChangeWatch } from '../fs/folder-change-watch.js';

const POLL_MS = 1000;

/**
 * Watches the custom themes folder and calls `onChange()` when its theme files
 * were added, removed or rewritten and then held still for one check, so a file
 * caught mid-write is never announced.
 *
 * Folder signals trigger checks. A slow safety poll reopens the watcher after
 * folder recreation; unavailable watchers retain the fast polling cadence.
 *
 * The first look is taken at once, before any client reads the themes, so a
 * change right after start is compared against it and announced. `ready`
 * settles when that look is done.
 */
export const createThemeFolderWatch = ({ fsPromises, path, themesDir, onChange, pollMs = POLL_MS, logger = console, fsWatch, timers }) => {
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
