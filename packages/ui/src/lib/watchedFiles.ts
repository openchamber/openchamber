/**
 * Files on screen that OpenCode watches (`fs.watch`, OpenCode 2.2), so a view
 * re-reads one the moment it changes on disk, by an agent, an editor or a
 * terminal, instead of waiting for its next poll. OpenCode watches where the
 * files are, so this also works against a remote OpenCode.
 *
 * A watch lasts 24 hours and is shared by every client of that OpenCode, so
 * nothing here unwatches: stopping it for one view would stop it for another
 * window looking at the same file. A view that stays open renews it. OpenCode
 * keeps watches in memory, so every reconnect of the event stream asks again
 * and has each view check its file once for what changed during the gap.
 */

import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';

/** Well inside OpenCode's 24-hour expiry. */
const RENEW_MS = 12 * 60 * 60 * 1000;

type Watch = { directory: string; relative: string; file: string; onChange: () => void };

const active = new Set<Watch>();

const relativeTo = (directory: string, file: string): string | null => {
  const prefix = directory.endsWith('/') ? directory : `${directory}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : null;
};

const request = (watch: Watch): Promise<boolean> => (
  opencodeClient.watchFile(watch.directory, watch.relative).then(() => true, () => false)
);

type FileWatch = {
  /** True once OpenCode watches the file; false when it cannot (outside `directory`, a failing OpenCode). */
  watching: Promise<boolean>;
  stop: () => void;
};

/**
 * Calls `onChange` whenever OpenCode reports `filePath` changed or removed
 * while the watch runs. `directory` is the OpenCode location the file belongs
 * to.
 */
export const watchFileOnScreen = (directory: string, filePath: string, onChange: () => void): FileWatch => {
  const root = normalizePath(directory);
  const file = normalizePath(filePath);
  const relative = root && file ? relativeTo(root, file) : null;
  if (!file || !relative) return { watching: Promise.resolve(false), stop: () => {} };

  const watch: Watch = { directory, relative, file, onChange };
  active.add(watch);
  const renew = setInterval(() => { void request(watch); }, RENEW_MS);
  return {
    watching: request(watch),
    stop: () => {
      clearInterval(renew);
      active.delete(watch);
    },
  };
};

/** Fed by the event stream with the absolute path OpenCode names. */
export const notifyWatchedFileChanged = (filePath: string): void => {
  const file = normalizePath(filePath);
  if (!file) return;
  for (const watch of active) {
    if (watch.file === file) watch.onChange();
  }
};

/** After the event stream reconnects: OpenCode may have restarted and dropped its watches. */
export const renewWatchedFiles = (): void => {
  for (const watch of active) {
    void request(watch);
    watch.onChange();
  }
};
