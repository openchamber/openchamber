import fs from 'fs';
import os from 'os';
import path from 'path';

// About four seconds of waiting in all before the folder is given up.
const RETRY_DELAYS_MS = [250, 500, 1000, 2000];

// Clones of catalog scans and skill installs, from the server and from the
// VS Code extension alike.
const CATALOG_FOLDER_PATTERN = /^openchamber-(vscode-)?skills-(scan|install)-/;

// A scan usually takes seconds. The fallback that reads every SKILL.md with its
// own `git show` can take many minutes on a large source, and a held clone
// deleted on the first try after about 50 minutes (#5497).
const STALE_AFTER_MS = 60 * 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const warnInConsole = (message) => console.warn(message);

/**
 * Removes a catalog clone or a skill folder. On Windows a virus scanner or
 * git's background maintenance can hold a file of a fresh clone for a moment,
 * and a single failed delete left the folder in the temp directory for good
 * (#5405). A folder that still cannot be removed is logged and left for
 * `removeStaleCatalogFolders`; the scan or install that used it still succeeds.
 */
export async function removeDirectory(dir, { rm = fs.promises.rm, sleep = wait, warn = warnInConsole } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        warn(`[skills-catalog] Failed to remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

let sweep = null;

/**
 * Removes catalog clones older than an hour from the temp directory: the ones
 * `removeDirectory` gave up on, and the ones earlier versions left behind. A
 * virus scanner can hold a fresh clone for longer than the retries wait on
 * every scan (#5497), and lets go of it long before the next one. Callers do
 * not wait for it; a folder that is still held stays for a later sweep.
 */
export function removeStaleCatalogFolders({
  tmpDir = os.tmpdir(),
  now = Date.now(),
  uid = process.getuid?.(),
  rm = fs.promises.rm,
} = {}) {
  sweep ??= removeFoldersOlderThan(tmpDir, now - STALE_AFTER_MS, uid, rm).finally(() => {
    sweep = null;
  });
  return sweep;
}

async function removeFoldersOlderThan(tmpDir, cutoffMs, uid, rm) {
  let names;
  try {
    names = await fs.promises.readdir(tmpDir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!CATALOG_FOLDER_PATTERN.test(name)) continue;
    const dir = path.join(tmpDir, name);
    try {
      // lstat: a link with a matching name is never followed. In a /tmp shared
      // with other users, a folder someone else made could hold a link that
      // is swapped in while the delete walks it, so only our own folders go.
      // Windows has no uid; its temp directory belongs to the user.
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.mtimeMs > cutoffMs) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Still held, or removed by another sweep; the next sweep tries again.
    }
  }
}
