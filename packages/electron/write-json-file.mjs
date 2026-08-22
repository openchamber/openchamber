import fsp from 'node:fs/promises';
import path from 'node:path';

export const WRITE_JSON_RENAME_RETRY_DELAYS_MS = process.platform === 'win32'
  ? [25, 75, 200, 500, 1000]
  : [];

export const isTransientWindowsRenameError = (error) => {
  if (!error || process.platform !== 'win32') return false;
  const code = error.code;
  // EPERM: file is locked (antivirus, concurrent reader).
  // EBUSY: same family on Windows.
  // EACCES: shares/no-access while another process releases the file.
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
};

export const removeStaleSiblingTmpFiles = async (filePath) => {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const prefix = `${baseName}.tmp-`;
  let entries;
  try {
    entries = await fsp.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix) && name.length > prefix.length)
      .map(async (name) => {
        const candidate = path.join(directory, name);
        try {
          await fsp.unlink(candidate);
        } catch {
          // Best effort: stale tmp files owned by another live process
          // will fail to unlink; that is fine, the rename will surface
          // a real conflict again on the next attempt.
        }
      }),
  );
};

export const renameWithRetry = async (tmp, filePath, options = {}) => {
  const delays = Array.isArray(options.delays) ? options.delays : WRITE_JSON_RENAME_RETRY_DELAYS_MS;
  const isTransient = typeof options.isTransient === 'function'
    ? options.isTransient
    : isTransientWindowsRenameError;
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : null;

  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fsp.rename(tmp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === delays.length) {
        throw error;
      }
      if (onRetry) {
        await onRetry(error, attempt);
      }
      const delayMs = delays[attempt];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
};

export const writeJsonFile = async (filePath, data) => {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(directory, 0o700);
  // Atomic: write to a temp file then rename. Readers never see a partial
  // JSON file that could parse-error and get coerced to {}.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fsp.chmod(tmp, 0o600);
  await renameWithRetry(tmp, filePath);
  if (process.platform !== 'win32') await fsp.chmod(filePath, 0o600);
};
