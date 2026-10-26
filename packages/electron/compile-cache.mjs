/**
 * Node's on-disk V8 code cache for the packaged main process. Once enabled,
 * every module loaded afterwards (the main bundle and the in-process server's
 * module graph inside app.asar) is compiled from cached bytecode on later
 * launches instead of from source. The entry module's own static imports are
 * compiled before any of its code runs, so they stay outside the cache; they
 * are small on purpose.
 */
import fsp from 'node:fs/promises';
import nodeModule from 'node:module';
import path from 'node:path';

export const COMPILE_CACHE_DIR_NAME = 'v8-compile-cache';

/**
 * Packaged builds only: development loads changing sources and would only
 * churn the cache. Skipped under AppImage, which mounts the app at a new
 * /tmp/.mount_* path on every launch; Node keys entries by path, so every
 * launch would miss and leave another copy behind.
 *
 * Node 24 does not export the directory through NODE_COMPILE_CACHE, but the
 * environment is restored regardless: OpenCode, terminals and git hooks inherit
 * it, and the user's own Node programs must not write into the app profile.
 *
 * Returns the cache directory, or null when the cache is off.
 */
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
    // The cache is only a speedup; it must never stop the app from starting.
    return null;
  } finally {
    if (inherited === undefined) delete env.NODE_COMPILE_CACHE;
    else env.NODE_COMPILE_CACHE = inherited;
  }
};

/**
 * Called once startup is done. Writes what startup compiled now, so a launch
 * that ends in a crash or a forced kill still leaves a warm cache, then removes
 * the caches of other Node versions: Node writes into one subdirectory per
 * Node version, architecture and user, so after an Electron upgrade the old
 * one is never read again.
 *
 * Deletion is confined to the cache root this module owns
 * (<userData>/v8-compile-cache). The root is never derived from what Node
 * reports, because the parent of that would be userData itself. When the
 * active directory is not a direct child of the known root, nothing is
 * deleted.
 */
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
