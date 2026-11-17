import fs from 'fs';
import os from 'os';
import path from 'path';

const RETRY_DELAYS_MS = [250, 500, 1000, 2000];

const CATALOG_FOLDER_PATTERN = /^openchamber-(vscode-)?skills-(scan|install)-/;

const STALE_AFTER_MS = 60 * 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const warnInConsole = (message) => console.warn(message);

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
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.mtimeMs > cutoffMs) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Still held, or removed by another sweep; the next sweep tries again.
    }
  }
}
