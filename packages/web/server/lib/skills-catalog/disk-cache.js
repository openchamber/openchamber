import fs from 'fs';
import os from 'os';
import path from 'path';

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const readJsonFile = (filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
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
    fs.renameSync(tempPath, filePath);
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
