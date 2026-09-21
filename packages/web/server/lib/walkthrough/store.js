import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PROMPT_VERSION, WALKTHROUGH_VERSION } from './schema.js';

// Two artifacts with two different jobs.
//
// Cache entries are content-addressed and immutable: the key is derived from
// the *current* diff, so a hit means "this walkthrough was written about
// exactly this code". There is no freshness question to ask of an entry —
// staleness is a miss.
//
// The pointer is mutable and keyed by repository + source only. It answers the
// questions the cache cannot: which walkthrough was the last one here, what was
// it written about, and has the code moved since. It is also what feeds the
// previous walkthrough into a regeneration.

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

const ensureDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    console.error('[walkthrough] failed to create store directory:', error?.message || error);
    return false;
  }
};

// Atomic so a crash mid-write leaves the previous entry intact rather than a
// half-written file that later fails to parse.
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
    // Missing, unreadable, or corrupt all mean the same thing to callers: no
    // usable cached walkthrough. Never throw — a bad cache file must not break
    // the feature.
    return null;
  }
};

/**
 * Content-addressed key. Every input that can change the output is in here:
 * change any of them and you get a miss rather than a stale hit.
 */
export function buildCacheKey({ repoRoot, sourceKey, providerID, modelID, language, files }) {
  const canonical = JSON.stringify({
    walkthroughVersion: WALKTHROUGH_VERSION,
    promptVersion: PROMPT_VERSION,
    repoRoot,
    sourceKey,
    providerID,
    modelID,
    // Without this, switching language hits the entry written in the previous
    // one and the panel answers a request to translate with the untranslated
    // text it already had.
    language,
    files: [...files]
      .map((file) => ({ path: file.path, status: file.status, hunkIds: file.hunks.map((hunk) => hunk.id) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  return sha256(canonical);
}

const entryPath = (cacheKey) => path.join(ENTRIES_DIR, `${cacheKey}.json`);
const pointerPath = (repoRoot, sourceKey) => path.join(POINTERS_DIR, `${sha256(`${repoRoot}\0${sourceKey}`)}.json`);

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

export function readPointer(repoRoot, sourceKey) {
  const value = readJson(pointerPath(repoRoot, sourceKey));
  if (!value || typeof value !== 'object' || typeof value.cacheKey !== 'string') return null;
  return value;
}

export function writePointer(repoRoot, sourceKey, pointer) {
  return writeJsonAtomic(pointerPath(repoRoot, sourceKey), pointer);
}

/**
 * Bound the cache by count and total size, dropping least-recently-used
 * entries. Pointers are tiny and are left alone; a pointer to an evicted entry
 * simply reads as "no walkthrough", which is the truthful answer.
 */
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

// Housekeeping runs off the request path and never synchronously.
//
// The Electron desktop app hosts this server inside the main process, so a
// blocking loop here stalls IPC and the window, not just one request. Worse,
// the paths being checked are user repositories: a worktree on an unplugged
// drive or an unreachable network share can make a single existence check hang
// for seconds. Async calls wait without holding the loop, and the cap keeps a
// pathological directory from turning into a long tail of work.
const PRUNE_LIMIT = 500;

/**
 * Drop pointers for repositories that no longer exist. Only ever removes
 * entries whose subject is provably gone.
 */
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
      // Unreachable is not the same as gone. Only a definite "no such file"
      // justifies deleting: a disconnected share or a permissions error must
      // not cost the user their walkthroughs.
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
