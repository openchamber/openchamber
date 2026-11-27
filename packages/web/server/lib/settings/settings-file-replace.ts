import type fsModule from 'node:fs/promises';

type ReplaceFs = Pick<typeof fsModule, 'open' | 'rename' | 'copyFile' | 'rm'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hasErrorCode = (value: unknown): value is { code?: unknown } => Boolean(value && typeof value === 'object');

const isTransientWindowsReplaceError = (error: unknown): error is { code: 'EPERM' | 'EACCES' | 'EBUSY' } => {
  if (process.platform !== 'win32' || !hasErrorCode(error)) {
    return false;
  }
  return error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
};

export const createSettingsFileReplace = (fsPromises: ReplaceFs) => {
  const flushToDisk = async (filePath: string) => {
    const handle = await fsPromises.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const replaceFile = async (tmp: string, target: string) => {
    const maxAttempts = process.platform === 'win32' ? 6 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await fsPromises.rename(tmp, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientWindowsReplaceError(error) || attempt === maxAttempts) {
          break;
        }
        await sleep(25 * attempt);
      }
    }

    if (!isTransientWindowsReplaceError(lastError)) {
      throw lastError;
    }

    try {
      await fsPromises.copyFile(tmp, target);
      await flushToDisk(target).catch((error) => console.warn(`Could not flush ${target} after copying it in place:`, error));
    } finally {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
    }
  };

  return { replaceFile, flushToDisk };
};
