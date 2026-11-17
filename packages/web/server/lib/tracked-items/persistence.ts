import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isCachedTrackedState, isPlainRecord, isTrackedItemInput, parseTrackedItem } from './items.js';
import type { PublicTrackedItemState, TrackedItemsPersistence } from './contracts.js';

const FILE_NAME = 'tracked-items.json';
const VERSION = 1;

export function createTrackedItemsPersistence({ dataDir, fs = fsPromises }: {
  dataDir: string;
  fs?: Pick<typeof fsPromises, 'readFile' | 'writeFile' | 'rename'>;
}): TrackedItemsPersistence {
  const filePath = path.join(dataDir, FILE_NAME);
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (isFileNotFound(error)) return [];
        throw error;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedFile(parsed)) return [];
      return parsed.items.flatMap((record) => {
        if (!isPersistedRecord(record)) return [];
        const item = isTrackedItemInput(record.item) ? parseTrackedItem(record.item) : null;
        if (!item) return [];
        return [{ item, state: isCachedTrackedState(record.state) ? record.state : null, fetchedAt: record.fetchedAt }];
      });
    },
    async save(items: PublicTrackedItemState[]) {
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify({ version: VERSION, items }), 'utf8');
      await fs.rename(tmpPath, filePath);
    },
  };
}

const isFileNotFound = (value: unknown): value is { code: 'ENOENT' } => (
  value !== null && (typeof value === 'object' || typeof value === 'function') && 'code' in value && value.code === 'ENOENT'
);

const isPersistedFile = (value: unknown): value is { version: 1; items: unknown[] } => (
  isPlainRecord(value) && 'version' in value && value.version === VERSION && 'items' in value && Array.isArray(value.items)
);

const isPersistedRecord = (value: unknown): value is { fetchedAt: number; state?: unknown; item?: unknown } => (
  isPlainRecord(value) && 'fetchedAt' in value && typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt)
);
