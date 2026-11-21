import fs from 'fs';
import os from 'os';
import path from 'path';

const RETRY_DELAYS_MS = [250, 500, 1000, 2000];

const CATALOG_FOLDER_PATTERN = /^openchamber-(vscode-)?skills-(scan|install)-/;

const STALE_AFTER_MS = 60 * 60 * 1000;

type RemoveFolder = (dir: string, options: { recursive: true; force: true }) => Promise<void>;

interface RemoveDirectoryOptions {
  rm?: RemoveFolder;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

interface SweepOptions {
  tmpDir?: string;
  now?: number;
  uid?: number;
  rm?: RemoveFolder;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const warnInConsole = (message: string) => console.warn(message);

export async function removeDirectory(dir: string, { rm = fs.promises.rm, sleep = wait, warn = warnInConsole }: RemoveDirectoryOptions = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        warn(`[skills-catalog] Failed to remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await sleep(delay);
    }
  }
}

let sweep: Promise<void> | null = null;

export function removeStaleCatalogFolders({
  tmpDir = os.tmpdir(),
  now = Date.now(),
  uid = process.getuid?.(),
  rm = fs.promises.rm,
}: SweepOptions = {}) {
  sweep ??= removeFoldersOlderThan(tmpDir, now - STALE_AFTER_MS, uid, rm).finally(() => {
    sweep = null;
  });
  return sweep;
}

async function removeFoldersOlderThan(tmpDir: string, cutoffMs: number, uid: number | undefined, rm: RemoveFolder) {
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
      continue;
    }
  }
}
