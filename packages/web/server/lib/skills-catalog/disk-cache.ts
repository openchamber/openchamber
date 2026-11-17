import fs from 'fs';
import os from 'os';
import path from 'path';

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
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: JsonValue = JSON.parse(raw);
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
    fs.renameSync(tempPath, filePath);
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
