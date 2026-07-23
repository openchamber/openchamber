import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { prepareMobileAssets } from './prepare-mobile-assets.mjs';

test('copies the complete mobile bundle and replaces stale assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openchamber-harmony-assets-'));
  const source = path.join(root, 'mobile-dist');
  const destination = path.join(root, 'rawfile', 'mobile');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<script src="/assets/app.js"></script>');
  await writeFile(path.join(source, 'assets', 'app.js'), 'export const ready = true;');
  await writeFile(path.join(destination, 'stale.js'), 'stale');

  const result = await prepareMobileAssets({ source, destination });

  expect(result.fileCount).toBe(2);
  expect(await readFile(path.join(destination, 'index.html'), 'utf8')).toContain('/assets/app.js');
  expect(await readFile(path.join(destination, 'assets', 'app.js'), 'utf8')).toContain('ready = true');
  expect(await stat(path.join(destination, 'stale.js')).catch(() => null)).toBeNull();
});

test('fails before replacing assets when the mobile entry is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openchamber-harmony-assets-'));
  const source = path.join(root, 'mobile-dist');
  const destination = path.join(root, 'rawfile', 'mobile');
  await mkdir(source, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'existing.js'), 'keep');

  await expect(prepareMobileAssets({ source, destination })).rejects.toThrow('Mobile build entry is missing');
  expect(await readFile(path.join(destination, 'existing.js'), 'utf8')).toBe('keep');
});
