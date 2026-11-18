import { createFolderChangeWatch } from '../fs/folder-change-watch.js';

const POLL_MS = 1000;

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
