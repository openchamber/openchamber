import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const settingsRootSchema = z.looseObject({});

const WINDOWS_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000, 1_000];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isTransientWindowsFileError = (error, platform) => {
  if (platform !== 'win32') return false;
  const code = error?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
};

export const replaceFileWithRetry = async (source, target, options = {}) => {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? fsp.rename;
  const wait = options.wait ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const delay = WINDOWS_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientWindowsFileError(error, platform)) throw error;
      await wait(delay);
    }
  }
};

export const readJsonObjectForUpdate = async (filePath, options = {}) => {
  const readFile = options.readFile ?? ((target) => fsp.readFile(target, 'utf8'));
  const wait = options.wait ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const parsed = settingsRootSchema.safeParse(JSON.parse(await readFile(filePath)));
      if (parsed.success) return parsed.data;
      throw new Error(`${path.basename(filePath)} does not hold a JSON object`);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      const delay = WINDOWS_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await wait(delay);
    }
  }
};
