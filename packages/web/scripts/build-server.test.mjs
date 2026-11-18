import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect } from 'vitest';
import { buildServer } from './build-server.mjs';

test('emits server and CLI with declarations, inline source maps and runtime siblings only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-server-build-'));
  const packageRoot = path.join(directory, 'node_modules', '@openchamber', 'web');
  const output = path.join(packageRoot, 'build');
  try {
    await buildServer(output);
    for (const file of [
      'server/index.js', 'server/index.d.ts', 'server/index.js.map', 'bin/cli.js',
      'server/lib/settings/settings-registry.json',
      'server/lib/spaces/gatekeeper-program.cjs',
      'server/lib/guests/authoring/skill.txt',
      'server/lib/gitea/fixtures/api.json',
      'server/lib/gerrit/fixtures/api.json',
      'server/built-in-extensions/registry.json',
      'server/lib/trackers/tracker-contract.d.ts',
      'server/lib/source-control/provider-contract.d.ts',
    ]) {
      expect((await fs.stat(path.join(output, file))).isFile(), file).toBe(true);
    }
    const files = await fs.readdir(output, { recursive: true });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(output, 'bin/cli.js'))).mode & 0o111).not.toBe(0);
    }
    expect(files.filter((file) => /\.(?:test|spec|test-support|fixture)\./.test(file))).toEqual([]);
    expect(files.some((file) => file.includes('test-support'))).toBe(false);
    const map = JSON.parse(await fs.readFile(path.join(output, 'server/index.js.map'), 'utf8'));
    expect(map.sourcesContent).toHaveLength(map.sources.length);
    expect(map.sourcesContent[0].length).toBeGreaterThan(0);
    expect(map.sources[0]).toMatch(/server\/index.js$/);
    await fs.copyFile(new URL('../package.json', import.meta.url), path.join(packageRoot, 'package.json'));
    await fs.symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(packageRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      await import(${JSON.stringify(pathToFileURL(path.join(output, 'server/index.js')).href)});
      const {getWebPackagePaths} = await import(${JSON.stringify(pathToFileURL(path.join(output, 'server/lib/web-package-paths.js')).href)});
      try { getWebPackagePaths(new URL(${JSON.stringify(pathToFileURL(path.join(directory, 'missing', 'file.js')).href)})); }
      catch (error) { console.log(error.stack); process.exit(0); }
      process.exit(1);
    `], { encoding: 'utf8', env: process.env });
    expect(result.status, result.stderr).toBe(0);
    const trace = result.stdout.replaceAll('\\', '/');
    expect(trace).toMatch(/server\/lib\/web-package-paths\.ts:\d+:/);
    expect(trace).not.toContain('build/server/lib/web-package-paths.js:');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);
