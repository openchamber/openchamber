import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGuestPackageWatch } from './package-watch.js';
import { folderWatchHarness } from '../fs/folder-watch-test-helpers.js';

const POLL_MS = 20;
const roots = [];
const watches = [];
let installed = [];
afterEach(async () => {
  installed = [];
  for (const watch of watches.splice(0)) watch.stop();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const write = (root, file, content) => fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  .then(() => fs.writeFile(path.join(root, file), content));

const folderInstall = async ({ fail = false } = {}) => {
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
  const clock = folderWatchHarness();
  clock.fail(fail);
  let reads = 0;
  const fsPromises = { ...fs, readFile: (...args) => { reads++; return fs.readFile(...args); } };
  const packageWatch = createGuestPackageWatch({ listFolderInstalls: async () => installed, onChange: (changed) => changes.push(changed), pollMs: POLL_MS, fsPromises, fsWatch: clock.fsWatch, timers: clock.timers });
  watches.push(packageWatch);
  await packageWatch.sync();
  const settle = async () => {
    clock.watchers.at(-1)?.signal();
    await clock.advance(POLL_MS * 2);
  };
  return { root, changes, packageWatch, clock, settle, reads: () => reads };
};

describe('createGuestPackageWatch', () => {
  test('reports a rebuilt script and service once, and ignores what a service writes beside them', async () => {
    const { root, changes, settle } = await folderInstall();

    await write(root, 'service/state.json', '{}');
    await settle();
    expect(changes).toEqual([]);

    await write(root, 'dist/main.js', 'two two');
    await write(root, 'service/main.js', 'two two');
    await settle();
    expect(changes).toEqual([root]);
  });

  test('a page stylesheet and image and a module the service imports count; its node_modules do not', async () => {
    const { root, changes, settle } = await folderInstall();

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
    const { root, changes, settle } = await folderInstall();

    await fs.rm(path.join(root, 'dist'), { recursive: true });
    await settle();
    await write(root, 'dist/main.js', 'three three three');
    await settle();
    expect(changes).toEqual([root, root]);
  });

  test('stops once the folder is no longer installed', async () => {
    const { root, changes, packageWatch, clock, settle } = await folderInstall();

    installed = [];
    await packageWatch.sync();
    await write(root, 'dist/main.js', 'four four four four');
    await settle();
    expect(changes).toEqual([]);
    expect(clock.watchers.every((watcher) => watcher.closed)).toBe(true);
    expect(clock.jobs.size).toBe(0);
  });

  test('idle roots do no reads before the safety poll; bursts coalesce and settle', async () => {
    const { root, changes, clock, reads } = await folderInstall();
    const initial = reads();
    expect(clock.watchers[0].options.recursive).toBe(true);
    await clock.advance(29_000);
    expect(reads()).toBe(initial);
    await write(root, 'dist/main.js', 'rebuilt');
    for (let i = 0; i < 100; i++) clock.watchers[0].signal();
    await clock.advance(POLL_MS);
    expect(reads()).toBe(initial * 2);
    expect(changes).toEqual([]);
    await clock.advance(POLL_MS);
    expect(changes).toEqual([root]);
    await clock.advance(500);
    expect(reads()).toBe(initial * 3);
  });

  test('the safety poll finds silent root recreation and re-arms the tree watcher', async () => {
    const { root, changes, clock } = await folderInstall();
    await fs.rm(root, { recursive: true });
    await write(root, 'package.json', '{}');
    await clock.advance(30_000);
    expect(clock.watchers[0].closed).toBe(true);
    expect(clock.watchers).toHaveLength(2);
    await clock.advance(POLL_MS);
    expect(changes).toEqual([root]);
    await write(root, 'package.json', '{"changed":true}');
    clock.watchers[1].signal();
    await clock.advance(POLL_MS * 2);
    expect(changes).toEqual([root, root]);
  });

  test('watch failures retain fast polling and recover on the safety poll', async () => {
    const { root, changes, clock, reads } = await folderInstall({ fail: true });
    await write(root, 'dist/main.js', 'rebuilt');
    await clock.advance(POLL_MS * 2);
    expect(changes).toEqual([root]);
    clock.fail(false);
    await clock.advance(30_000);
    expect(clock.watchers).toHaveLength(1);
    const recovered = reads();
    await clock.advance(1000);
    expect(reads()).toBe(recovered);
    clock.watchers[0].emit('error', new Error('lost watch'));
    expect(clock.watchers[0].closed).toBe(true);
    await write(root, 'dist/main.js', 'rebuilt again');
    await clock.advance(POLL_MS * 2);
    expect(changes).toEqual([root, root]);
  });

  test('stopping releases every root and pending settling check', async () => {
    const { root, changes, packageWatch, clock } = await folderInstall();
    await write(root, 'dist/main.js', 'rebuilt');
    clock.watchers[0].signal();
    await clock.advance(POLL_MS);
    packageWatch.stop();
    await clock.advance(60_000);
    expect(changes).toEqual([]);
    expect(clock.jobs.size).toBe(0);
    expect(clock.watchers[0].closed).toBe(true);
    await packageWatch.sync();
    expect(clock.watchers).toHaveLength(1);
  });

  test('a watch failure enables fast reads only for that root', async () => {
    const { root, packageWatch } = await folderInstall();
    packageWatch.stop();
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-guest-watch-'));
    roots.push(other);
    const clock = folderWatchHarness();
    const reads = new Map();
    const watch = createGuestPackageWatch({
      listFolderInstalls: async () => [root, other], onChange: () => {},
      fsPromises: { ...fs, readFile: (file, ...args) => {
        const key = file.startsWith(root) ? root : other;
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return fs.readFile(file, ...args);
      } },
      fsWatch: (folder, ...args) => {
        if (folder === other) throw new Error('unsupported');
        return clock.fsWatch(folder, ...args);
      },
      timers: clock.timers,
    });
    watches.push(watch);
    await watch.sync();
    const healthyReads = reads.get(root);
    await clock.advance(2000);
    expect(reads.get(root)).toBe(healthyReads);
    expect(reads.get(other)).toBe(5);
  });
});
