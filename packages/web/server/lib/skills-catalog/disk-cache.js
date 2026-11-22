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

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const readJsonFile = (filePath) => {
  // Bounded read (#1627): missing, malformed, over-cap and non-regular
  // files all answer null, exactly as an unreadable file did before —
  // but an oversized file is refused after at most cap + 1 bytes, and a
  // FIFO is refused from the opened handle instead of freezing this
  // synchronous read (and the server event loop with it).
  try {
    const result = readBoundedFileSync(filePath, DISK_CACHE_MAX_BYTES);
    if (!result.ok) return null;
    const parsed = JSON.parse(result.buffer.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Read a persisted cache object from the OpenChamber data directory.
 * Returns null when the file is missing, unreadable, or malformed.
 */
export const readDiskCache = (fileName) => {
  try {
    return readJsonFile(path.join(resolveDataDir(), fileName));
  } catch {
    return null;
  }
};

/**
 * Persist a cache object to the OpenChamber data directory with an atomic
 * temp-file rename. Failures are ignored: the in-memory cache stays
 * authoritative and the next successful write retries persistence.
 */
export const writeDiskCache = (fileName, data) => {
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
      // ignore
    }
    return false;
  }
};
