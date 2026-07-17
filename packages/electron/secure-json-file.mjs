import fsp from 'node:fs/promises';
import path from 'node:path';

const OWNER_ONLY_FILE_MODE = 0o600;

export const writeSecureAtomicJson = async (filePath, value, options = {}) => {
  const fsPromises = options.fsPromises || fsp;
  const directoryOptions = { recursive: true, ...(options.privateDirectory ? { mode: 0o700 } : {}) };
  await fsPromises.mkdir(path.dirname(filePath), directoryOptions);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsPromises.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: OWNER_ONLY_FILE_MODE });
    if (process.platform !== 'win32') await fsPromises.chmod(tmp, OWNER_ONLY_FILE_MODE);
    await fsPromises.rename(tmp, filePath);
    if (process.platform !== 'win32') await fsPromises.chmod(filePath, OWNER_ONLY_FILE_MODE);
  } catch (error) {
    await fsPromises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};
