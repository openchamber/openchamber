import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrackedItemsPersistence } from './persistence.js';
import { promises as fs } from 'node:fs';

describe('tracked-items persistence', () => {
  let dataDir;
  let fsMock;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `tracked-items-test-${Date.now()}`);
    await fs.mkdir(dataDir, { recursive: true });
    fsMock = fs;
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('returns empty array when file is missing', async () => {
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    expect(result).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('returns empty array when file is a FIFO', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    execFileSync('mkfifo', [filePath]);

    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    await expect(persistence.load()).resolves.toEqual([]);
  });

  it('returns empty array when file is oversized (> 8 MiB)', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    // Create a file larger than 8 MiB
    const largeContent = 'x'.repeat(9 * 1024 * 1024); // 9 MiB
    await fs.writeFile(filePath, largeContent, 'utf8');
    
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    expect(result).toEqual([]);
  });

  it('throws when the file does not parse, so the caller logs the corruption', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    await fs.writeFile(filePath, 'not valid json', 'utf8');

    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    await expect(persistence.load()).rejects.toThrow(/does not parse as JSON/);
  });

  it('uses the injected filesystem for both bounded reads and atomic writes', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    const original = [
      {
        item: { owner: 'owner', repo: 'repo', number: 1, provider: 'github', kind: 'issue' },
        state: { state: 'open' },
        fetchedAt: 1,
      },
    ];
    const updated = [
      {
        item: { owner: 'owner', repo: 'repo', number: 2, provider: 'github', kind: 'issue' },
        state: { state: 'closed' },
        fetchedAt: 2,
      },
    ];
    const files = new Map([[filePath, JSON.stringify({ version: 1, items: original })]]);
    const fakeFs = createFakeFs(files);
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fakeFs });

    expect(await persistence.load()).toEqual(original);
    await persistence.save(updated);
    expect(await persistence.load()).toEqual(updated);
    expect([...files.keys()]).toEqual([filePath]);
  });

  it('returns empty array when file has wrong version', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    await fs.writeFile(filePath, JSON.stringify({ version: 999, items: [] }), 'utf8');
    
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    expect(result).toEqual([]);
  });

  it('returns empty array when items is not an array', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    await fs.writeFile(filePath, JSON.stringify({ version: 1, items: 'not an array' }), 'utf8');
    
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    expect(result).toEqual([]);
  });

  it('restores valid tracked items correctly', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    const validData = {
      version: 1,
      items: [
        {
          item: { owner: 'owner', repo: 'repo', number: 1, provider: 'github', kind: 'issue' },
          state: { state: 'open' },
          fetchedAt: Date.now(),
        },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(validData), 'utf8');
    
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    expect(result).toHaveLength(1);
    expect(result[0].item).toEqual(validData.items[0].item);
    expect(result[0].state).toEqual(validData.items[0].state);
    expect(result[0].fetchedAt).toEqual(validData.items[0].fetchedAt);
  });

  it('filters out items with invalid structure', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    const data = {
      version: 1,
      items: [
        {
          item: { owner: 'owner', repo: 'repo', number: 1, provider: 'github', kind: 'issue' },
          state: { state: 'open' },
          fetchedAt: Date.now(),
        },
        {
          // Invalid item - missing required fields
          item: null,
          state: null,
          fetchedAt: Date.now(),
        },
        {
          // Invalid item - missing fetchedAt
          item: { owner: 'owner2', repo: 'repo2', number: 2, provider: 'github', kind: 'pull' },
          state: { state: 'open' },
          fetchedAt: 'not a number',
        },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    // Should only have the valid item
    expect(result).toHaveLength(1);
  });

  it('filters out items with non-plain state', async () => {
    const filePath = join(dataDir, 'tracked-items.json');
    const data = {
      version: 1,
      items: [
        {
          item: { owner: 'owner', repo: 'repo', number: 1, provider: 'github', kind: 'issue' },
          state: { state: 'open' },
          fetchedAt: Date.now(),
        },
        {
          item: { owner: 'owner2', repo: 'repo2', number: 2, provider: 'github', kind: 'pull' },
          state: 'not a plain object', // Invalid state
          fetchedAt: Date.now(),
        },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    
    const persistence = createTrackedItemsPersistence({ dataDir, fs: fsMock });
    const result = await persistence.load();
    // Should have both items, but the second one has state set to null
    expect(result).toHaveLength(2);
    expect(result[0].state).toEqual({ state: 'open' });
    expect(result[1].state).toBeNull();
  });
});

function createFakeFs(files) {
  return {
    async open(filePath) {
      const content = files.get(filePath);
      if (content === undefined) {
        const error = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      }
      const buffer = Buffer.from(content);
      return {
        async stat() {
          return { isFile: () => true, size: buffer.length };
        },
        async read(target, offset, length, position) {
          const chunk = buffer.subarray(position, position + length);
          chunk.copy(target, offset);
          return { bytesRead: chunk.length };
        },
        async close() {},
      };
    },
    async writeFile(filePath, contents) {
      files.set(filePath, contents);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}
