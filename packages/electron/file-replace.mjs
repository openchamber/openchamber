import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_REPLACE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
let windowsFallbackChain = Promise.resolve();

const isTransientWindowsReplaceError = (error, platform) => (
  platform === 'win32' && WINDOWS_REPLACE_ERRORS.has(error?.code)
);

export const readJsonFileWithBackup = (targetPath) => {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (targetError) {
    if (targetError?.code !== 'ENOENT') throw targetError;

    const directory = path.dirname(targetPath);
    const backupName = `${path.basename(targetPath)}.backup`;
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      throw targetError;
    }
    const name = names.filter((name) => name === backupName || name.startsWith(`${backupName}-`)).sort().at(-1);
    if (!name) throw targetError;
    try {
      return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    } catch (backupError) {
      try {
        return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      } catch (retryError) {
        if (retryError?.code !== 'ENOENT') throw retryError;
        throw backupError;
      }
    }
  }
};

export const replaceFile = async (temporaryPath, targetPath, platform = process.platform) => {
  const maxAttempts = platform === 'win32' ? 6 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fsp.rename(temporaryPath, targetPath);
    } catch (error) {
      if (!isTransientWindowsReplaceError(error, platform)) throw error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
      continue;
    }
    return;
  }

  const fallback = windowsFallbackChain.then(async () => {
    try {
      await fsp.rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientWindowsReplaceError(error, platform)) throw error;
    }

    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const backupPath = `${targetPath}.backup-${suffix}`;
    const linkProbePath = `${temporaryPath}.link-${suffix}`;
    await fsp.link(temporaryPath, linkProbePath);
    await fsp.rm(linkProbePath);
    await fsp.rename(targetPath, backupPath);
    try {
      await fsp.link(temporaryPath, targetPath);
    } catch (error) {
      await fsp.link(backupPath, targetPath);
      await fsp.rm(backupPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    await fsp.rm(backupPath, { force: true }).catch(() => undefined);
  });
  windowsFallbackChain = fallback.catch(() => undefined);
  return fallback;
};
