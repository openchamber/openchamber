
import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';

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
  watching: Promise<boolean>;
  stop: () => void;
};

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

export const notifyWatchedFileChanged = (filePath: string): void => {
  const file = normalizePath(filePath);
  if (!file) return;
  for (const watch of active) {
    if (watch.file === file) watch.onChange();
  }
};

export const renewWatchedFiles = (): void => {
  for (const watch of active) {
    void request(watch);
    watch.onChange();
  }
};
