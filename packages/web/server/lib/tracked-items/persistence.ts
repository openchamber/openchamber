import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isCachedTrackedState, isPlainRecord, isTrackedItemInput, parseTrackedItem } from './items.js';
import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import type { PublicTrackedItemState } from './contracts.js';

const FILE_NAME = 'tracked-items.json';
const VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB cap

/**
 * The last known state of followed items, so a restart starts from it. Only
 * a cache: a missing, non-regular, oversized, wrong-version or wrong-shape
 * file restores nothing, and the next answers rebuild it. A file that does
 * not parse as JSON throws, so the caller logs the corruption; unexpected
 * I/O failures throw too.
 */
export function createTrackedItemsPersistence({ dataDir, fs = fsPromises }: { dataDir: string; fs?: typeof fsPromises }) {
  const filePath = path.join(dataDir, FILE_NAME);
  return {
    async load() {
      const result = await readBoundedFile(filePath, MAX_FILE_BYTES, { fs });
      if (!result.ok) return [];
      const raw = result.buffer.toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // Unparseable is corruption, not an empty cache: throw so the
        // restore failure reaches service.js's log, which is the only
        // corruption signal this store has. The next save() overwrites it.
        throw new Error(`tracked-items: ${filePath} does not parse as JSON`, { cause: error });
      }
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
      await renameWithRetry((from, to) => fs.rename(from, to), tmpPath, filePath);
    },
  };
}


const isPersistedFile = (value: unknown): value is { version: 1; items: unknown[] } => (
  isPlainRecord(value) && 'version' in value && value.version === VERSION && 'items' in value && Array.isArray(value.items)
);

const isPersistedRecord = (value: unknown): value is { fetchedAt: number; state?: unknown; item?: unknown } => (
  isPlainRecord(value) && 'fetchedAt' in value && typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt)
);
