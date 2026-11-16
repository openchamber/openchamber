import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isPlainRecord, parseTrackedItem } from './items.js';

const FILE_NAME = 'tracked-items.json';
const VERSION = 1;

export function createTrackedItemsPersistence({ dataDir, fs = fsPromises }) {
  const filePath = path.join(dataDir, FILE_NAME);
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const parsed = JSON.parse(raw);
      if (parsed?.version !== VERSION || !Array.isArray(parsed.items)) return [];
      return parsed.items.flatMap((record) => {
        const item = parseTrackedItem(record?.item);
        if (!item || !Number.isFinite(record?.fetchedAt)) return [];
        return [{ item, state: isPlainRecord(record.state) ? record.state : null, fetchedAt: record.fetchedAt }];
      });
    },
    async save(items) {
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify({ version: VERSION, items }), 'utf8');
      await fs.rename(tmpPath, filePath);
    },
  };
}
