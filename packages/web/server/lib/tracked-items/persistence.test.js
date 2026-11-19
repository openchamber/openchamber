import { describe, expect, it, vi } from 'vitest';
import { createTrackedItemsPersistence } from './persistence.js';

const item = { provider: 'linear', kind: 'work-item', identifier: 'OPE-1' };

const persistenceWith = (contents) => createTrackedItemsPersistence({
  dataDir: '/data',
  fs: {
    readFile: vi.fn(async () => contents),
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  },
});

describe('tracked item persistence', () => {
  it('keeps arbitrary cached state and drops invalid records independently', async () => {
    const state = { state: { type: 'completed' }, checks: 'legacy', future: { flag: true } };
    const persistence = persistenceWith(JSON.stringify({
      version: 1,
      items: [
        { item, state, fetchedAt: 123 },
        null,
        { item: null, state, fetchedAt: 124 },
        { item, state, fetchedAt: '125' },
        { item: { provider: 'missing', kind: 'pull' }, state, fetchedAt: 126 },
        { item, state: [], fetchedAt: 127 },
        { item, fetchedAt: 128 },
      ],
    }));
    await expect(persistence.load()).resolves.toEqual([
      { item, state, fetchedAt: 123 },
      { item, state: null, fetchedAt: 127 },
      { item, state: null, fetchedAt: 128 },
    ]);
  });

  it('returns no records for unsupported files and propagates malformed JSON', async () => {
    for (const value of [null, [], 1, { version: 2, items: [] }, { version: 1, items: {} }]) {
      await expect(persistenceWith(JSON.stringify(value)).load()).resolves.toEqual([]);
    }
    await expect(persistenceWith('{').load()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('treats only a missing file as an empty cache', async () => {
    const readFile = vi.fn();
    const persistence = createTrackedItemsPersistence({ dataDir: '/data', fs: { readFile } });
    readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(persistence.load()).resolves.toEqual([]);
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    readFile.mockRejectedValueOnce(failure);
    await expect(persistence.load()).rejects.toBe(failure);
  });

  it('writes the unchanged envelope through a sibling temporary file', async () => {
    const fs = { writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}) };
    const persistence = createTrackedItemsPersistence({ dataDir: '/data', fs });
    const items = [{ key: 'linear|OPE-1', item, state: { future: true }, fetchedAt: 123 }];
    await persistence.save(items);
    const temporary = `/data/tracked-items.json.${process.pid}.tmp`;
    expect(fs.writeFile).toHaveBeenCalledWith(temporary, JSON.stringify({ version: 1, items }), 'utf8');
    expect(fs.rename).toHaveBeenCalledWith(temporary, '/data/tracked-items.json');
  });
});
