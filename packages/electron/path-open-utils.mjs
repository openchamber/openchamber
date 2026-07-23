import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const accessErrorMessage = (label, targetPath, error) => {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return `${label} does not exist: ${targetPath}`;
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return `${label} is not accessible: ${targetPath}`;
  }
  return `${label} could not be checked: ${error?.message || String(error)}`;
};

export const normalizeRequiredPath = (rawPath, label = 'Path') => {
  const targetPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!targetPath) {
    throw new Error(`${label} is required`);
  }
  return path.resolve(targetPath);
};

export const validateLocalPath = async (rawPath, label = 'Path') => {
  const targetPath = normalizeRequiredPath(rawPath, label);
  let stats;
  try {
    stats = await fsp.stat(targetPath);
  } catch (error) {
    throw new Error(accessErrorMessage(label, targetPath, error));
  }

  const accessMode = stats.isDirectory()
    ? fs.constants.R_OK | fs.constants.X_OK
    : fs.constants.R_OK;
  try {
    await fsp.access(targetPath, accessMode);
  } catch (error) {
    throw new Error(accessErrorMessage(label, targetPath, error));
  }

  return { path: targetPath, stats };
};

export const unsupportedAppSpecificOpenError = (targetKind, platform = process.platform) => {
  const platformName = platform === 'linux'
    ? 'Linux'
    : platform === 'win32'
      ? 'Windows'
      : platform;
  return `Opening ${targetKind} in a specific app is not supported on ${platformName} yet. Use the default open action instead.`;
};
