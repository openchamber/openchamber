import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { JsonValue } from '../src/index.ts';

const script = resolve(import.meta.dir, 'check-guest.ts');
const made: string[] = [];
afterAll(() => Promise.all(made.map((path) => rm(path, { recursive: true, force: true }))));

const packageWith = async (contributes: JsonValue, files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'guest-check-'));
  made.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', openchamber: { apiVersion: 1, contributes } }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

const check = (root: string) => {
  const run = Bun.spawnSync(['bun', script, root]);
  return { code: run.exitCode, text: `${run.stdout}${run.stderr}` };
};

const panel = { id: 'x', name: 'X', icon: 'window', entry: 'panel/index.html' };
const page = '<script src="./main.js"></script>';

describe('openchamber-guest-check', () => {
  test('passes a built package', async () => {
    expect(check(await packageWith({ panel }, { 'panel/index.html': page, 'panel/main.js': '' })).code).toBe(0);
  });

  test('names a manifest the host would refuse', async () => {
    const result = check(await packageWith({ panel: { ...panel, id: 'Bad Id' } }, {}));
    expect(result.code).toBe(1);
    expect(result.text).toContain('package.json');
  });

  test('names a page that is not built', async () => {
    const result = check(await packageWith({ panel }, { 'panel/index.html': page }));
    expect(result.code).toBe(1);
    expect(result.text).toContain('main.js');
  });

  test('names a service that was not bundled', async () => {
    const service = { entry: 'service/main.js', runtime: 'host' };
    const result = check(await packageWith({ panel: { id: 'x', name: 'X', icon: 'window' }, service, background: { entry: 'b.html' } }, {
      'b.html': '<p>x</p>',
      'service/main.js': "import { createServiceHost } from '@openchamber/sdk';",
    }));
    expect(result.code).toBe(1);
    expect(result.text).toContain('--node');
  });
});
