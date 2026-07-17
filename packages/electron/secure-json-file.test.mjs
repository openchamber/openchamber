import { afterEach, describe, expect, test } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeSecureAtomicJson } from './secure-json-file.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('writeSecureAtomicJson', () => {
  test('writes owner-only and repairs a pre-existing permissive file', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-secure-json-'));
    roots.push(root);
    const target = path.join(root, 'settings.json');
    await fsp.writeFile(target, '{}', { mode: 0o644 });

    await writeSecureAtomicJson(target, { secret: true });

    expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
  });

  test('removes its temporary file when replacement fails', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-secure-json-'));
    roots.push(root);
    const target = path.join(root, 'settings.json');
    const fsPromises = { ...fsp, rename: async () => { throw new Error('replace failed'); } };

    await expect(writeSecureAtomicJson(target, { secret: true }, { fsPromises })).rejects.toThrow('replace failed');
    expect((await fsp.readdir(root)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });
});
