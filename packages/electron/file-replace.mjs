import fs from 'node:fs';
import fsp from 'node:fs/promises';

const WINDOWS_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

const isTransientWindowsReplaceError = (error, platform) => (
  platform === 'win32' && WINDOWS_REPLACE_ERRORS.has(error?.code)
);

export const readJsonFileWithBackup = (targetPath) => {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (targetError) {
    try {
      return JSON.parse(fs.readFileSync(`${targetPath}.backup`, 'utf8'));
    } catch {
      throw targetError;
    }
  }
};

export const replaceFile = async (temporaryPath, targetPath, platform = process.platform) => {
  const backupPath = `${targetPath}.backup`;

  if (platform === 'win32') {
    try {
      await fsp.access(targetPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        await fsp.rename(backupPath, targetPath);
      } catch (backupError) {
        if (backupError?.code !== 'ENOENT') throw backupError;
      }
    }
  }

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

  await fsp.rename(targetPath, backupPath);
  try {
    await fsp.rename(temporaryPath, targetPath);
  } catch (error) {
    await fsp.rename(backupPath, targetPath);
    throw error;
  }
  await fsp.rm(backupPath, { force: true });
};
