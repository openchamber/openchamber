import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createThemeFolderWatch } from './theme-watch.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The watch with a timer that never fires; each `check()` is one poll. */
const watchThemes = async ({ createFolder = true } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-theme-watch-'));
  const themesDir = path.join(root, 'themes');
  if (createFolder) await fs.mkdir(themesDir);
  const changes = [];
  const watch = createThemeFolderWatch({ fsPromises: fs, path, themesDir, onChange: () => changes.push('changed'), pollMs: 2 ** 30 });
  cleanups.push(async () => {
    watch.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await watch.ready;
  return { themesDir, changes, watch };
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
});
