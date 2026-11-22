import fs from 'fs';
import os from 'os';
import path from 'path';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

// Generous cap for the bounded read below (#1627): a persisted scan cache
// holds at most MAX_CACHED_SCANS scan values (~57 KB each, cache.js) and
// the github-meta cache is smaller still, so legitimate cache files fit
// in a fraction of this.
export const DISK_CACHE_MAX_BYTES = 32 * 1024 * 1024;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PersistedCacheEntry {
  expiresAt: number;
  value: object;
}

export const isPersistedCacheEntry = (value: unknown): value is PersistedCacheEntry =>
  value !== null && typeof value === 'object'
    && 'expiresAt' in value && typeof value.expiresAt === 'number'
    && 'value' in value && value.value !== null && typeof value.value === 'object';

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const isDiskCache = (value: JsonValue): value is Record<string, JsonValue> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readJsonFile = (filePath: string) => {
  // Bounded read (#1627): missing, malformed, over-cap and non-regular
  // files all answer null, exactly as an unreadable file did before —
  // but an oversized file is refused after at most cap + 1 bytes, and a
  // FIFO is refused from the opened handle instead of freezing this
  // synchronous read (and the server event loop with it).
  try {
    const result = readBoundedFileSync(filePath, DISK_CACHE_MAX_BYTES);
    if (!result.ok) return null;
    const parsed = JSON.parse(result.buffer.toString('utf8'));
    return isDiskCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const readDiskCache = (fileName: string) => {
  try {
    return readJsonFile(path.join(resolveDataDir(), fileName));
  } catch {
    return null;
  }
};

export const writeDiskCache = (fileName: string, data: Record<string, PersistedCacheEntry>) => {
  const filePath = path.join(resolveDataDir(), fileName);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), tempPath, filePath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      return false;
    }
    return false;
  }
};
