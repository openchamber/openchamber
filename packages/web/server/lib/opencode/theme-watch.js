const POLL_MS = 1000;

/**
 * Watches the custom themes folder and calls `onChange()` when its theme files
 * were added, removed or rewritten and then held still for one poll, so a file
 * caught mid-write is never announced.
 *
 * It polls `readdir` and `stat` like the extension folder watch: a folder
 * watcher goes silent on Linux and Windows when the folder it watched is
 * deleted and made again, and the themes folder may not exist yet.
 *
 * The first look is taken at once, before any client reads the themes, so a
 * change right after start is compared against it and announced. `ready`
 * settles when that look is done.
 */
export const createThemeFolderWatch = ({ fsPromises, path, themesDir, onChange, pollMs = POLL_MS, logger = console }) => {
  const fingerprint = async () => {
    const names = await fsPromises.readdir(themesDir).catch(() => []);
    const themes = names.filter((name) => name.toLowerCase().endsWith('.json')).sort();
    const stamps = await Promise.all(themes.map((name) => fsPromises.stat(path.join(themesDir, name)).then(
      (stat) => `${stat.mtimeMs}:${stat.size}`,
      () => 'missing',
    )));
    return themes.map((name, index) => `${name}=${stamps[index]}`).join('\n');
  };

  let reported = null;
  let seen = null;
  let polling = false;
  let stopped = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const current = await fingerprint();
      if (reported === null) {
        reported = current;
        seen = current;
        return;
      }
      const settled = current === seen;
      seen = current;
      if (!settled || current === reported || stopped) return;
      reported = current;
      onChange();
    } finally {
      polling = false;
    }
  };

  const check = () => poll().catch((error) => logger.warn('[themes] Failed to check the themes folder:', error?.message ?? error));
  const ready = check();
  const timer = setInterval(check, pollMs);
  timer.unref?.();

  return {
    ready,
    check,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
