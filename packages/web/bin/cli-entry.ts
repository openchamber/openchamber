import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

type Realpath = (filePath: string) => string;

function hasEntryPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCliEntryPath(filePath: string | undefined, realpath: Realpath = fs.realpathSync) {
  if (!hasEntryPath(filePath)) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  try {
    return realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isModuleCliExecution(
  entryPath: string | undefined = process.argv[1],
  moduleUrl?: string,
  realpath: Realpath = fs.realpathSync,
  expectedBinName?: string,
) {
  if (!hasEntryPath(entryPath)) {
    return false;
  }
  if (!hasEntryPath(moduleUrl)) {
    return false;
  }

  try {
    const normalizedEntryPath = normalizeCliEntryPath(entryPath, realpath);
    const normalizedModulePath = normalizeCliEntryPath(fileURLToPath(moduleUrl), realpath);
    if (!normalizedEntryPath || !normalizedModulePath) {
      return false;
    }
    if (pathToFileURL(normalizedEntryPath).href === pathToFileURL(normalizedModulePath).href) {
      return true;
    }

    if (hasEntryPath(expectedBinName)) {
      const parsedEntryName = path.parse(normalizedEntryPath).name.toLowerCase();
      return parsedEntryName === expectedBinName.trim().toLowerCase();
    }

    return false;
  } catch {
    return false;
  }
}

export {
  normalizeCliEntryPath,
  isModuleCliExecution,
};
