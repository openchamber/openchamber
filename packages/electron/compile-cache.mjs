import fsp from 'node:fs/promises';
import nodeModule from 'node:module';
import path from 'node:path';

export const COMPILE_CACHE_DIR_NAME = 'v8-compile-cache';

export const enableMainProcessCompileCache = ({
  packaged,
  userDataDir,
  env = process.env,
  enableCompileCache = nodeModule.enableCompileCache,
}) => {
  if (!packaged || env.APPIMAGE || !userDataDir) return null;
  const inherited = env.NODE_COMPILE_CACHE;
  try {
    return enableCompileCache(path.join(userDataDir, COMPILE_CACHE_DIR_NAME)).directory || null;
  } catch {
    return null;
  } finally {
    if (inherited === undefined) delete env.NODE_COMPILE_CACHE;
    else env.NODE_COMPILE_CACHE = inherited;
  }
};

export const settleMainProcessCompileCache = async ({
  userDataDir,
  getCompileCacheDir = nodeModule.getCompileCacheDir,
  flushCompileCache = nodeModule.flushCompileCache,
} = {}) => {
  const activeDir = getCompileCacheDir();
  if (!activeDir) return;
  try {
    flushCompileCache();
  } catch {
    // A failed write only costs the next launch its cache.
  }
  if (!userDataDir) return;
  const cacheRoot = path.resolve(userDataDir, COMPILE_CACHE_DIR_NAME);
  const resolvedActive = path.resolve(activeDir);
  if (path.dirname(resolvedActive) !== cacheRoot) return;
  const activeName = path.basename(resolvedActive);
  let entries;
  try {
    entries = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== activeName)
    .map((entry) => fsp.rm(path.join(cacheRoot, entry.name), { recursive: true, force: true }).catch(() => {})));
};
