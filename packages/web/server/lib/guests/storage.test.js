import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGuestStorage, removeGuestStorage } from './storage.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-storage-'));
  roots.push(root);
  const persistPath = path.join(root, 'extensions.json');
  return { root, persistPath, run: (request, id = 'board') => runGuestStorage(persistPath, id, request, async () => {}) };
};
describe('extension storage', () => {
  test('concurrent keys survive, namespaces are isolated, and null is present', async () => {
    const { run, persistPath } = await fixture();
    await Promise.all(Array.from({ length: 30 }, (_, index) => run({ op: 'set', key: `key-${index}`, value: index })));
    expect((await run({ op: 'keys' })).keys).toHaveLength(30);
    expect(await run({ op: 'get', key: 'key-1' }, 'other')).toMatchObject({ found: false });
    await run({ op: 'set', key: 'null', value: null });
    expect(await run({ op: 'get', key: 'null' })).toMatchObject({ found: true, value: null });
    await removeGuestStorage(persistPath, 'board');
    expect(await run({ op: 'keys' })).toMatchObject({ keys: [] });
  });
  test('limits and malformed reads preserve prior bytes', async () => {
    const { run, root } = await fixture();
    await run({ op: 'set', key: 'board', value: { columns: ['Todo'] } });
    await expect(run({ op: 'set', key: 'board', value: 'x'.repeat(65_536) })).rejects.toThrow();
    expect(await run({ op: 'get', key: 'board' })).toMatchObject({ value: { columns: ['Todo'] } });
    const file = path.join(root, 'guest-storage', 'board.json');
    await fs.writeFile(file, '{broken');
    await expect(run({ op: 'set', key: 'other', value: 1 })).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });
  test('authorization runs after earlier writes and refusal performs no write', async () => {
    const { run, persistPath } = await fixture();
    await run({ op: 'set', key: 'kept', value: 1 });
    await expect(runGuestStorage(persistPath, 'board', { op: 'set', key: 'kept', value: 2 }, async () => { throw new Error('Removed'); })).rejects.toThrow('Removed');
    expect(await run({ op: 'get', key: 'kept' })).toMatchObject({ value: 1 });
  });
  test('a failed atomic rename leaves the old value and does not poison subsequent writes', async () => {
    const { run } = await fixture();
    await run({ op: 'set', key: 'kept', value: 1 });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk failure'));
    try {
      await expect(run({ op: 'set', key: 'kept', value: 2 })).rejects.toThrow('Disk failure');
    } finally { rename.mockRestore(); }
    expect(await run({ op: 'get', key: 'kept' })).toMatchObject({ value: 1 });
    await run({ op: 'set', key: 'kept', value: 3 });
    expect(await run({ op: 'get', key: 'kept' })).toMatchObject({ value: 3 });
  });
  test('the total byte limit retains keys written before the overflowing request', async () => {
    const { run } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 35 }, (_, index) => run({ op: 'set', key: `key-${index}`, value: 'x'.repeat(60_000) })));
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await run({ op: 'keys' })).keys).toHaveLength(34);
  });
});
