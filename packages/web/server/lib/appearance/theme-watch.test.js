import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createThemeFolderWatch } from './theme-watch.js';
import { folderWatchHarness } from '../fs/folder-watch-test-helpers.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const watchThemes = async ({ createFolder = true, fail = false } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-theme-watch-'));
  const themesDir = path.join(root, 'themes');
  if (createFolder) await fs.mkdir(themesDir);
  const changes = [];
  const clock = folderWatchHarness();
  clock.fail(fail || !createFolder);
  let reads = 0;
  const fsPromises = { ...fs, readdir: (...args) => { reads++; return fs.readdir(...args); } };
  const watch = createThemeFolderWatch({ fsPromises, path, themesDir, onChange: () => changes.push('changed'), fsWatch: clock.fsWatch, timers: clock.timers });
  cleanups.push(async () => {
    watch.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await watch.ready;
  return { themesDir, changes, watch, clock, reads: () => reads };
};

/** A change shows on one poll and is reported on the next that sees it unchanged. */
const twoPolls = async (watch) => {
  await watch.check();
  await watch.check();
};

describe('createThemeFolderWatch', () => {
  test('a theme saved right after start is reported', async () => {
    const { themesDir, changes, watch } = await watchThemes();

    await fs.writeFile(path.join(themesDir, 'one.json'), '{}');
    await twoPolls(watch);
    expect(changes).toEqual(['changed']);
  });

  test('reports a rewritten theme once, after it holds still for one poll', async () => {
    const { themesDir, changes, watch } = await watchThemes();
    await fs.writeFile(path.join(themesDir, 'one.json'), '{}');
    await twoPolls(watch);
    changes.length = 0;

    await fs.writeFile(path.join(themesDir, 'one.json'), '{"metadata":{}}');
    await watch.check();
    expect(changes).toEqual([]);
    await watch.check();
    expect(changes).toEqual(['changed']);
    await watch.check();
    expect(changes).toEqual(['changed']);
  });

  test('reports added and removed themes and ignores other files', async () => {
    const { themesDir, changes, watch } = await watchThemes();

    await fs.writeFile(path.join(themesDir, 'draft.tmp'), 'x');
    await twoPolls(watch);
    expect(changes).toEqual([]);

    await fs.writeFile(path.join(themesDir, 'new.json'), '{}');
    await twoPolls(watch);
    await fs.rm(path.join(themesDir, 'new.json'));
    await twoPolls(watch);
    expect(changes).toEqual(['changed', 'changed']);
  });

  test('a themes folder created after start is watched', async () => {
    const { themesDir, changes, watch } = await watchThemes({ createFolder: false });

    await fs.mkdir(themesDir);
    await fs.writeFile(path.join(themesDir, 'first.json'), '{}');
    await twoPolls(watch);
    expect(changes).toEqual(['changed']);
  });

  test('reports nothing once stopped', async () => {
    const { themesDir, changes, watch } = await watchThemes();

    watch.stop();
    await fs.writeFile(path.join(themesDir, 'late.json'), '{}');
    await twoPolls(watch);
    expect(changes).toEqual([]);
  });

  test('idle themes do no reads before the safety poll and a burst settles at the fast cadence', async () => {
    const { themesDir, changes, clock, reads } = await watchThemes();
    expect(clock.watchers[0].options.recursive).toBe(false);
    await clock.advance(20_000);
    expect(reads()).toBe(1);
    await fs.writeFile(path.join(themesDir, 'new.json'), '{}');
    for (let i = 0; i < 100; i++) clock.watchers[0].signal();
    await clock.advance(1000);
    expect(reads()).toBe(2);
    expect(changes).toEqual([]);
    await clock.advance(1000);
    expect(reads()).toBe(3);
    expect(changes).toEqual(['changed']);
    await clock.advance(1000);
    expect(reads()).toBe(3);
  });

  test('a failed or closed watcher fast-polls until safety re-arms it', async () => {
    const { themesDir, changes, clock, reads } = await watchThemes({ fail: true });
    await fs.writeFile(path.join(themesDir, 'new.json'), '{}');
    await clock.advance(2000);
    expect(changes).toEqual(['changed']);
    clock.fail(false);
    await clock.advance(28_000);
    expect(clock.watchers).toHaveLength(1);
    const recovered = reads();
    await clock.advance(2000);
    expect(reads()).toBe(recovered);
    clock.watchers[0].close();
    await fs.writeFile(path.join(themesDir, 'new.json'), '{"changed":true}');
    await clock.advance(2000);
    expect(changes).toEqual(['changed', 'changed']);
  });

  test('safety finds a silently recreated folder and restores immediate signals', async () => {
    const { themesDir, changes, clock } = await watchThemes();
    await fs.rm(themesDir, { recursive: true });
    await fs.mkdir(themesDir);
    await fs.writeFile(path.join(themesDir, 'new.json'), '{}');
    await clock.advance(30_000);
    expect(clock.watchers[0].closed).toBe(true);
    expect(clock.watchers).toHaveLength(2);
    await clock.advance(1000);
    expect(changes).toEqual(['changed']);
    await fs.writeFile(path.join(themesDir, 'new.json'), '{"changed":true}');
    clock.watchers[1].signal();
    await clock.advance(2000);
    expect(changes).toEqual(['changed', 'changed']);
  });

  test('folder creation keeps the first-look baseline and stop cancels pending checks', async () => {
    const { themesDir, changes, watch, clock } = await watchThemes({ createFolder: false });
    await fs.mkdir(themesDir);
    await fs.writeFile(path.join(themesDir, 'first.json'), '{}');
    await clock.advance(2000);
    expect(changes).toEqual(['changed']);
    clock.fail(false);
    await clock.advance(28_000);
    clock.watchers[0].signal();
    watch.stop();
    await clock.advance(60_000);
    expect(changes).toEqual(['changed']);
    expect(clock.jobs.size).toBe(0);
    expect(clock.watchers.every((watcher) => watcher.closed)).toBe(true);
  });

  test('a continuing save waits for one unchanged check', async () => {
    const { themesDir, changes, clock } = await watchThemes();
    await fs.writeFile(path.join(themesDir, 'new.json'), '{}');
    clock.watchers[0].signal();
    await clock.advance(1000);
    await fs.writeFile(path.join(themesDir, 'new.json'), '{"changed":true}');
    clock.watchers[0].signal();
    await clock.advance(1000);
    expect(changes).toEqual([]);
    await clock.advance(1000);
    expect(changes).toEqual(['changed']);
  });

  test('stop suppresses a fingerprint that is already reading', async () => {
    const clock = folderWatchHarness();
    let finish;
    let names = [];
    const changes = [];
    const watch = createThemeFolderWatch({
      fsPromises: { readdir: async () => names, stat: async () => ({ mtimeMs: 1, size: 1 }) },
      path, themesDir: '/themes', onChange: () => changes.push('changed'),
      fsWatch: clock.fsWatch, timers: clock.timers,
    });
    cleanups.push(() => watch.stop());
    await watch.ready;
    names = ['new.json'];
    await watch.check();
    names = new Promise((resolve) => { finish = resolve; });
    const checking = watch.check();
    watch.stop();
    finish(['new.json']);
    await checking;
    expect(changes).toEqual([]);
    expect(clock.jobs.size).toBe(0);
  });
});
