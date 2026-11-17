import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PROMPT_VERSION, WALKTHROUGH_VERSION } from './schema.js';

const DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const WALKTHROUGH_DIR = path.join(DATA_DIR, 'walkthroughs');
const ENTRIES_DIR = path.join(WALKTHROUGH_DIR, 'entries');
const POINTERS_DIR = path.join(WALKTHROUGH_DIR, 'pointers');

const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const canonicalReadContext = (readContext) => readContext ? {
  provider: readContext.provider,
  instance: readContext.instance,
  accountId: readContext.accountId,
  repositoryId: readContext.repositoryId,
  bindingRevision: readContext.bindingRevision,
  directory: readContext.directory,
  primaryRemote: readContext.primaryRemote,
} : undefined;

const ensureDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    console.error('[walkthrough] failed to create store directory:', error?.message || error);
    return false;
  }
};

const writeJsonAtomic = (filePath, value) => {
  if (!ensureDir(path.dirname(filePath))) return false;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (error) {
    console.error('[walkthrough] failed to write store file:', error?.message || error);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing else to do; the temp file is already orphaned.
    }
    return false;
  }
};

const readJson = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

export function buildCacheKey({ repoRoot, sourceKey, providerID, modelID, language, files, readContext }) {
  const input = {
    walkthroughVersion: WALKTHROUGH_VERSION,
    promptVersion: PROMPT_VERSION,
    repoRoot,
    sourceKey,
    providerID,
    modelID,
    language,
    files: [...files]
      .map((file) => ({ path: file.path, status: file.status, hunkIds: file.hunks.map((hunk) => hunk.id) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  if (readContext) input.readContext = canonicalReadContext(readContext);
  return sha256(JSON.stringify(input));
}

const entryPath = (cacheKey) => path.join(ENTRIES_DIR, `${cacheKey}.json`);
const pointerPath = (repoRoot, sourceKey, readContext) => path.join(
  POINTERS_DIR,
  `${sha256(readContext
    ? JSON.stringify({ repoRoot, sourceKey, readContext: canonicalReadContext(readContext) })
    : `${repoRoot}\0${sourceKey}`)}.json`,
);

const isWalkthroughEntry = (value) => Boolean(
  value
  && typeof value === 'object'
  && value.walkthroughVersion === WALKTHROUGH_VERSION
  && value.walkthrough
  && Array.isArray(value.walkthrough.chapters),
);

export function readCachedWalkthrough(cacheKey) {
  const value = readJson(entryPath(cacheKey));
  return isWalkthroughEntry(value) ? value : null;
}

export function writeCachedWalkthrough(cacheKey, entry) {
  const written = writeJsonAtomic(entryPath(cacheKey), {
    walkthroughVersion: WALKTHROUGH_VERSION,
    ...entry,
  });
  if (written) evictEntries();
  return written;
}

export function readPointer(repoRoot, sourceKey, readContext) {
  const value = readJson(pointerPath(repoRoot, sourceKey, readContext));
  if (!value || typeof value !== 'object' || typeof value.cacheKey !== 'string') return null;
  if (readContext && JSON.stringify(value.readContext) !== JSON.stringify(canonicalReadContext(readContext))) return null;
  return value;
}

export function writePointer(repoRoot, sourceKey, pointer, readContext) {
  const value = { ...pointer };
  if (readContext) value.readContext = canonicalReadContext(readContext);
  return writeJsonAtomic(pointerPath(repoRoot, sourceKey, readContext), value);
}

function evictEntries() {
  let files;
  try {
    files = fs.readdirSync(ENTRIES_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const full = path.join(ENTRIES_DIR, name);
        try {
          const stat = fs.statSync(full);
          return { full, size: stat.size, atime: stat.atimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return;
  }

  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) return;

  files.sort((a, b) => a.atime - b.atime);
  let count = files.length;
  for (const file of files) {
    if (count <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break;
    try {
      fs.unlinkSync(file.full);
      count -= 1;
      totalBytes -= file.size;
    } catch {
      // Skip files we cannot remove; the next write retries.
    }
  }
}

const PRUNE_LIMIT = 500;

export async function pruneMissingRepositories() {
  let names;
  try {
    names = (await fsp.readdir(POINTERS_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names.slice(0, PRUNE_LIMIT)) {
    const full = path.join(POINTERS_DIR, name);
    let repoRoot = null;
    try {
      const value = JSON.parse(await fsp.readFile(full, 'utf8'));
      repoRoot = value && typeof value.repoRoot === 'string' ? value.repoRoot : null;
    } catch {
      continue;
    }
    if (!repoRoot) continue;

    try {
      await fsp.stat(repoRoot);
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }

    try {
      await fsp.unlink(full);
      removed += 1;
    } catch {
      // Leave it; the next prune retries.
    }
  }
  return removed;
}

export const __testing = { WALKTHROUGH_DIR, ENTRIES_DIR, POINTERS_DIR, MAX_ENTRIES, MAX_TOTAL_BYTES };
