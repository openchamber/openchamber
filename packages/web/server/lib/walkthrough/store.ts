import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { PROMPT_VERSION, WALKTHROUGH_VERSION } from './schema.js';
import type { ModelJson, ModelJsonObject } from './schema.js';
import type { ReadContext } from './contracts.js';

interface CacheKeyInput {
  repoRoot: string;
  sourceKey: string;
  providerID: unknown;
  modelID: unknown;
  language?: string;
  files: { path: string; status: string; hunks: { id: string }[] }[];
  readContext?: ReadContext | undefined;
}

interface StorePointer {
  repoRoot: string;
  cacheKey: string;
  sourceKey?: string;
  generatedAt?: ModelJson | undefined;
  readContext?: ReadContext;
}

interface StoredEntry extends ModelJsonObject {
  walkthroughVersion: typeof WALKTHROUGH_VERSION;
  walkthrough: ModelJson & { chapters: ModelJson[] };
}

const isStoreObject = (value: ModelJson | undefined): value is ModelJsonObject => Boolean(value) && typeof value === 'object';
const isStoreString = (value: ModelJson | undefined): value is string => typeof value === 'string';
const isStoreError = (value: unknown): value is { message?: unknown; code?: unknown } => value !== null && typeof value === 'object';
const hasStoredChapters = (value: ModelJson | undefined): value is ModelJson & { chapters: ModelJson[] } => Boolean(value && Array.isArray(Object(value).chapters));
const isStoredPointer = (value: ModelJson): value is ModelJsonObject & { cacheKey: string } => isStoreObject(value) && isStoreString(value.cacheKey);
const hasRepositoryRoot = (value: ModelJson): value is ModelJson & { repoRoot: string } => Boolean(value) && typeof Object(value).repoRoot === 'string';

const DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const WALKTHROUGH_DIR = path.join(DATA_DIR, 'walkthroughs');
const ENTRIES_DIR = path.join(WALKTHROUGH_DIR, 'entries');
const POINTERS_DIR = path.join(WALKTHROUGH_DIR, 'pointers');

const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function canonicalReadContext(readContext: ReadContext): Omit<ReadContext, 'linked'>;
export function canonicalReadContext(readContext?: ReadContext): Omit<ReadContext, 'linked'> | undefined;
export function canonicalReadContext(readContext?: ReadContext) {
  return readContext ? {
    provider: readContext.provider,
    instance: readContext.instance,
    accountId: readContext.accountId,
    repositoryId: readContext.repositoryId,
    bindingRevision: readContext.bindingRevision,
    directory: readContext.directory,
    primaryRemote: readContext.primaryRemote,
  } : undefined;
}

const ensureDir = (dir: string) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    console.error('[walkthrough] failed to create store directory:', (isStoreError(error) && error.message) || error);
    return false;
  }
};

const writeJsonAtomic = <T extends object>(filePath: string, value: T) => {
  if (!ensureDir(path.dirname(filePath))) return false;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (error) {
    console.error('[walkthrough] failed to write store file:', (isStoreError(error) && error.message) || error);
    try {
      fs.unlinkSync(tmp);
    } catch {
      return false;
    }
    return false;
  }
};

const readJson = (filePath: string): ModelJson => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

export function buildCacheKey({ repoRoot, sourceKey, providerID, modelID, language, files, readContext }: CacheKeyInput) {
  const input: Omit<CacheKeyInput, 'files' | 'language'> & {
    walkthroughVersion: number;
    promptVersion: number;
    language: string | undefined;
    files: { path: string; status: string; hunkIds: string[] }[];
  } = {
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

const entryPath = (cacheKey: string) => path.join(ENTRIES_DIR, `${cacheKey}.json`);
const pointerPath = (repoRoot: string, sourceKey: string, readContext: ReadContext | undefined) => path.join(
  POINTERS_DIR,
  `${sha256(readContext
    ? JSON.stringify({ repoRoot, sourceKey, readContext: canonicalReadContext(readContext) })
    : `${repoRoot}\0${sourceKey}`)}.json`,
);

const isWalkthroughEntry = (value: ModelJson): value is StoredEntry => Boolean(
  value
  && isStoreObject(value)
  && value.walkthroughVersion === WALKTHROUGH_VERSION
  && hasStoredChapters(value.walkthrough),
);

export function readCachedWalkthrough(cacheKey: string) {
  const value = readJson(entryPath(cacheKey));
  return isWalkthroughEntry(value) ? value : null;
}

export function writeCachedWalkthrough<T extends object>(cacheKey: string, entry: T) {
  const written = writeJsonAtomic(entryPath(cacheKey), {
    walkthroughVersion: WALKTHROUGH_VERSION,
    ...entry,
  });
  if (written) evictEntries();
  return written;
}

export function readPointer(repoRoot: string, sourceKey: string, readContext?: ReadContext) {
  const value = readJson(pointerPath(repoRoot, sourceKey, readContext));
  if (!isStoredPointer(value)) return null;
  if (readContext && JSON.stringify(value.readContext) !== JSON.stringify(canonicalReadContext(readContext))) return null;
  return value;
}

export function writePointer(repoRoot: string, sourceKey: string, pointer: StorePointer, readContext?: ReadContext) {
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
      .filter((file) => file !== null);
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
      continue;
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
      const value: ModelJson = JSON.parse(await fsp.readFile(full, 'utf8'));
      repoRoot = hasRepositoryRoot(value) ? value.repoRoot : null;
    } catch {
      continue;
    }
    if (!repoRoot) continue;

    try {
      await fsp.stat(repoRoot);
      continue;
    } catch (error) {
      if (!isStoreError(error) || error.code !== 'ENOENT') continue;
    }

    try {
      await fsp.unlink(full);
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

export const __testing = { WALKTHROUGH_DIR, ENTRIES_DIR, POINTERS_DIR, MAX_ENTRIES, MAX_TOTAL_BYTES };
