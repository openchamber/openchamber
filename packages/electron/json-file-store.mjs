import fsp from 'node:fs/promises';
import path from 'node:path';

import { replaceFileWithRetry } from './windows-file-replace.mjs';

export const writeJsonFile = async (filePath, data) => {
  const directory = path.dirname(filePath);
  // Restrictive mode on creation only: re-chmodding an existing directory
  // would clobber granted group access (chmod replaces the POSIX ACL mask).
  const createdDirectory = await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (createdDirectory !== undefined && process.platform !== 'win32') await fsp.chmod(directory, 0o700);
  // Atomic: write to a temp file then rename. Readers never see a partial
  // JSON file that could parse-error and get coerced to {}.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') await fsp.chmod(tmp, 0o600);
    await replaceFileWithRetry(tmp, filePath);
    if (process.platform !== 'win32') await fsp.chmod(filePath, 0o600);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};
