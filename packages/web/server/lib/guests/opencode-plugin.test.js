import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCodePluginDelivery, resolveOpenCodePluginFolder } from './opencode-plugin.js';

describe('openCodePluginDelivery', () => {
  test('a managed OpenCode reads our file; a user-owned OPENCODE_CONFIG waits for the next start', () => {
    expect(openCodePluginDelivery({ external: false, origin: null, ownsConfigFile: true })).toBe('file');
    expect(openCodePluginDelivery({ external: false, origin: null, ownsConfigFile: false })).toBe('restart');
  });

  test('an external OpenCode on this machine gets nothing; one on another machine cannot load a folder from here', () => {
    for (const origin of [null, 'http://localhost:4096', 'http://127.0.0.1:4096', 'http://[::1]:4096', 'http://LOCALHOST:4096']) {
      expect(openCodePluginDelivery({ external: true, origin, ownsConfigFile: true }), origin ?? 'none').toBe('none');
    }
    for (const origin of ['http://192.168.1.38:4198', 'https://opencode.example.test', 'http://devbox:4096', 'not a url']) {
      expect(openCodePluginDelivery({ external: true, origin, ownsConfigFile: true }), origin).toBe('remote');
    }
    // What the managed config does is irrelevant once nobody reads it.
    expect(openCodePluginDelivery({ external: true, origin: null, ownsConfigFile: false })).toBe('none');
  });
});

describe('resolveOpenCodePluginFolder', () => {
  const temporary = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-plugin-folder-'));
    return fs.realpath(root);
  };
  const writePlugin = async (root, manifest, entryFile = 'index.js') => {
    await fs.mkdir(path.join(root, 'plugin'), { recursive: true });
    await fs.writeFile(path.join(root, 'plugin', 'package.json'), JSON.stringify(manifest));
    if (entryFile) await fs.writeFile(path.join(root, 'plugin', entryFile), 'export default { id: "p", setup: async () => {} }');
  };

  test('takes the folders OpenCode loads and refuses the ones it would skip without a word', async () => {
    const root = await temporary();
    const accepts = async (manifest, entryFile) => {
      await fs.rm(path.join(root, 'plugin'), { recursive: true, force: true });
      await writePlugin(root, manifest, entryFile);
      return (await resolveOpenCodePluginFolder(fs, root, 'plugin')) === path.join(root, 'plugin');
    };
    expect(await accepts({ type: 'module' }, 'index.js')).toBe(true);
    expect(await accepts({ type: 'module' }, 'server.ts')).toBe(true);
    expect(await accepts({ name: 'p', exports: './index.js' }, 'index.js')).toBe(true);
    expect(await accepts({ name: 'p', exports: { './server': './server.js' } }, 'server.js')).toBe(true);
    expect(await accepts({ name: 'p', exports: { '.': { import: './entry.js' } } }, 'entry.js')).toBe(true);
    expect(await accepts({ name: 'p', exports: { '.': { node: { import: './entry.js' } } } }, 'entry.js')).toBe(true);
    expect(await accepts({ name: 'p', exports: { '.': { require: './entry.js' } } }, 'entry.js')).toBe(false);
    // A build in a subfolder named by `main`: OpenCode never reads `main`.
    expect(await accepts({ name: 'p', main: 'entry.js' }, 'entry.js')).toBe(false);
    // `exports` counts only beside a `name`.
    expect(await accepts({ exports: './entry.js' }, 'entry.js')).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('refuses a missing folder, a folder without an entry, an export that is not there, and a folder outside the package', async () => {
    const root = await temporary();
    expect(await resolveOpenCodePluginFolder(fs, root, 'plugin')).toBeNull();
    await writePlugin(root, { name: 'p', type: 'module' }, null);
    expect(await resolveOpenCodePluginFolder(fs, root, 'plugin')).toBeNull();
    await writePlugin(root, { name: 'p', type: 'module', exports: './missing.js' });
    expect(await resolveOpenCodePluginFolder(fs, root, 'plugin')).toBeNull();
    await writePlugin(root, { name: 'p', type: 'module', exports: '../outside.js' });
    await fs.writeFile(path.join(root, 'outside.js'), '');
    expect(await resolveOpenCodePluginFolder(fs, root, 'plugin')).toBeNull();
    // A link that leaves the package: the manifest parse admits the name, the real path does not.
    const elsewhere = await temporary();
    await writePlugin(elsewhere, { name: 'p', type: 'module', main: 'index.js' });
    await fs.symlink(path.join(elsewhere, 'plugin'), path.join(root, 'linked'));
    expect(await resolveOpenCodePluginFolder(fs, root, 'linked')).toBeNull();
    // A file where a folder is named.
    await fs.writeFile(path.join(root, 'file-plugin'), '');
    expect(await resolveOpenCodePluginFolder(fs, root, 'file-plugin')).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });
});
