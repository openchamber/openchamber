import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGuestPackageWatch } from './package-watch.js';

const POLL_MS = 20;
const roots = [];
let installed = [];
afterEach(async () => {
  installed = [];
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A few polls: a change shows on one and is reported once the next sees it unchanged. */
const settle = () => new Promise((resolve) => setTimeout(resolve, POLL_MS * 8));

const write = (root, file, content) => fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  .then(() => fs.writeFile(path.join(root, file), content));

const folderInstall = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-watch-'));
  roots.push(root);
  await write(root, 'package.json', JSON.stringify({
    name: 'hello',
    version: '1.0.0',
    openchamber: {
      apiVersion: 1,
      contributes: {
        panel: { id: 'hello', name: 'Hello', icon: 'window', entry: 'panel/index.html' },
        service: { entry: 'service/main.js', runtime: 'host' },
      },
    },
  }));
  await write(root, 'panel/index.html', '<link rel="stylesheet" href="styles.css"><img src="logo.png"><script src="../dist/main.js"></script>');
  await write(root, 'panel/styles.css', 'one');
  await write(root, 'panel/logo.png', 'one');
  await write(root, 'dist/main.js', 'one');
  await write(root, 'service/main.js', 'one');
  await write(root, 'service/lib/routes.js', 'one');
  await write(root, 'service/node_modules/dep/index.js', 'one');
  installed = [root];
  const changes = [];
  const packageWatch = createGuestPackageWatch({ listFolderInstalls: async () => installed, onChange: (changed) => changes.push(changed), pollMs: POLL_MS });
  await packageWatch.sync();
  return { root, changes, packageWatch };
};

describe('createGuestPackageWatch', () => {
  test('reports a rebuilt script and service once, and ignores what a service writes beside them', async () => {
    const { root, changes } = await folderInstall();

    await write(root, 'service/state.json', '{}');
    await settle();
    expect(changes).toEqual([]);

    await write(root, 'dist/main.js', 'two two');
    await write(root, 'service/main.js', 'two two');
    await settle();
    expect(changes).toEqual([root]);
  });

  test('a page stylesheet and image and a module the service imports count; its node_modules do not', async () => {
    const { root, changes } = await folderInstall();

    await write(root, 'service/node_modules/dep/index.js', 'two two');
    await settle();
    expect(changes).toEqual([]);

    await write(root, 'panel/styles.css', 'two two');
    await settle();
    await write(root, 'panel/logo.png', 'two two');
    await settle();
    await write(root, 'service/lib/routes.js', 'two two');
    await settle();
    expect(changes).toEqual([root, root, root]);
  });

  test('a build that removes its output folder is reported again when the output comes back', async () => {
    const { root, changes } = await folderInstall();

    await fs.rm(path.join(root, 'dist'), { recursive: true });
    await settle();
    await write(root, 'dist/main.js', 'three three three');
    await settle();
    expect(changes).toEqual([root, root]);
  });

  test('stops once the folder is no longer installed', async () => {
    const { root, changes, packageWatch } = await folderInstall();

    installed = [];
    await packageWatch.sync();
    await write(root, 'dist/main.js', 'four four four four');
    await settle();
    expect(changes).toEqual([]);
  });
});
