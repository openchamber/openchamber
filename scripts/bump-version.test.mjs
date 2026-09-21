import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_PACKAGE_FILES } from './bump-version.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test('a release bump packs workspace dependencies at the new version after a frozen install', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-release-pack-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(new URL('./bump-version.mjs', import.meta.url), path.join(root, 'scripts/bump-version.mjs'));
  for (const file of RELEASE_PACKAGE_FILES) {
    const directory = path.dirname(file);
    await fs.mkdir(path.join(root, directory), { recursive: true });
    const name = file === 'package.json' ? 'release-fixture' : `@openchamber/${path.basename(directory)}`;
    const manifest = { name, version: '1.23.1' };
    if (file === 'package.json') {
      manifest.private = true;
      manifest.workspaces = ['packages/*'];
    }
    if (name === '@openchamber/web') manifest.dependencies = { '@openchamber/sdk': 'workspace:*' };
    if (name === '@openchamber/electron') manifest.dependencies = { '@openchamber/web': 'workspace:*' };
    await fs.writeFile(path.join(root, file), JSON.stringify(manifest));
  }
  const bun = process.execPath;
  const runBun = (args, cwd = root) => execFileSync(bun, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  runBun(['install', '--ignore-scripts']);
  runBun(['run', 'scripts/bump-version.mjs', '1.24.0']);
  // CI uses a frozen install. It must not need to repair release metadata.
  const lockBeforeInstall = await fs.readFile(path.join(root, 'bun.lock'), 'utf8');
  runBun(['install', '--frozen-lockfile', '--ignore-scripts']);
  expect(await fs.readFile(path.join(root, 'bun.lock'), 'utf8')).toBe(lockBeforeInstall);
  for (const [workspace, dependency] of [['web', 'sdk'], ['electron', 'web']]) {
    const archive = path.join(root, `${workspace}.tgz`);
    runBun(['pm', 'pack', '--ignore-scripts', '--filename', archive], path.join(root, 'packages', workspace));
    const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    expect(packed.version).toBe('1.24.0');
    expect(packed.dependencies[`@openchamber/${dependency}`]).toBe('1.24.0');
  }
}, 30_000);
