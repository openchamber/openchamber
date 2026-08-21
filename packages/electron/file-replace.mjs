import fsp from 'node:fs/promises';

const WINDOWS_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

const isTransientWindowsReplaceError = (error, platform) => (
  platform === 'win32' && WINDOWS_REPLACE_ERRORS.has(error?.code)
);

export const replaceFile = async (temporaryPath, targetPath, platform = process.platform) => {
  const maxAttempts = platform === 'win32' ? 6 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fsp.rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientWindowsReplaceError(error, platform)) throw error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  await fsp.copyFile(temporaryPath, targetPath);
  await fsp.rm(temporaryPath, { force: true });
};
