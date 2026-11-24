import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { markStateOwned, restoreState, snapshotState } from './isolated-server.mjs';

const withRoot = async (run) => {
  const root = await mkdtemp(join(tmpdir(), 'oc-perf-state-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('clears a tool-owned home and data and leaves the rest of the state directory alone', () => withRoot(async (root) => {
  const state = join(root, 'state');
  markStateOwned(state);
  await mkdir(join(state, 'home', 'nested'), { recursive: true });
  await mkdir(join(state, 'oc-data'), { recursive: true });
  await writeFile(join(state, 'home', 'nested', 'stale.txt'), 'stale');
  await writeFile(join(state, 'oc-data', 'settings.json'), '{}');
  await writeFile(join(state, 'keep.txt'), 'keep');

  restoreState(state, undefined);

  assert.equal(existsSync(join(state, 'home')), false);
  assert.equal(existsSync(join(state, 'oc-data')), false);
  assert.equal(await readFile(join(state, 'keep.txt'), 'utf8'), 'keep');
}));

test('a reset that leaves nothing behind gives up ownership, so a home that appears later is refused', () => withRoot(async (root) => {
  const state = join(root, 'state');
  markStateOwned(state);
  await mkdir(join(state, 'home'), { recursive: true });
  restoreState(state, undefined);
  await mkdir(join(state, 'home'), { recursive: true });
  await writeFile(join(state, 'home', 'precious.txt'), 'precious');

  assert.throws(() => restoreState(state, undefined), /Remove it yourself/);
  assert.equal(await readFile(join(state, 'home', 'precious.txt'), 'utf8'), 'precious');
}));

test('a linked marker proves nothing and its target is never written', () => withRoot(async (root) => {
  const state = join(root, 'state');
  const target = join(root, 'target.txt');
  await writeFile(target, 'target');
  await mkdir(join(state, 'home'), { recursive: true });
  await writeFile(join(state, 'home', 'precious.txt'), 'precious');
  await symlink(target, join(state, '.openchamber-isolated-state'));

  assert.throws(() => restoreState(state, undefined), /Remove it yourself/);
  assert.equal(await readFile(join(state, 'home', 'precious.txt'), 'utf8'), 'precious');

  markStateOwned(state);
  assert.equal(await readFile(target, 'utf8'), 'target');
}));

test('a seed snapshot holds only home and data', () => withRoot(async (root) => {
  const state = join(root, 'state');
  const seed = join(root, 'seed');
  await mkdir(join(state, 'home'), { recursive: true });
  await mkdir(join(state, 'oc-data'), { recursive: true });
  await writeFile(join(state, 'home', 'h.txt'), 'home');
  await writeFile(join(state, 'oc-data', 'd.txt'), 'data');
  await writeFile(join(state, 'seed.json'), 'foreign');

  snapshotState(state, seed);

  assert.equal(await readFile(join(seed, 'home', 'h.txt'), 'utf8'), 'home');
  assert.equal(await readFile(join(seed, 'oc-data', 'd.txt'), 'utf8'), 'data');
  assert.equal(existsSync(join(seed, 'seed.json')), false);
}));

test('refuses a symlinked state and leaves its target untouched', () => withRoot(async (root) => {
  const target = join(root, 'elsewhere');
  await mkdir(join(target, 'home'), { recursive: true });
  await writeFile(join(target, 'home', 'precious.txt'), 'precious');
  markStateOwned(target);
  const state = join(root, 'state');
  await symlink(target, state);

  assert.throws(() => restoreState(state, undefined), (error) => error.message.includes(state) && /symbolic link/.test(error.message));
  assert.equal(await readFile(join(target, 'home', 'precious.txt'), 'utf8'), 'precious');
}));

test('refuses an unmarked directory that is only named home', () => withRoot(async (root) => {
  const state = join(root, 'state');
  await mkdir(join(state, 'home'), { recursive: true });
  await writeFile(join(state, 'home', 'precious.txt'), 'precious');

  assert.throws(() => restoreState(state, undefined), (error) => error.message.includes(join(state, 'home')) && /Remove it yourself/.test(error.message));
  assert.equal(await readFile(join(state, 'home', 'precious.txt'), 'utf8'), 'precious');
}));

test('restores only home and data from the seed and keeps foreign files on both sides', () => withRoot(async (root) => {
  const state = join(root, 'state');
  const seed = join(root, 'seed');
  await mkdir(join(seed, 'home'), { recursive: true });
  await mkdir(join(seed, 'oc-data'), { recursive: true });
  await writeFile(join(seed, 'home', 'seeded.txt'), 'seeded home');
  await writeFile(join(seed, 'oc-data', 'settings.json'), 'seeded data');
  await writeFile(join(seed, 'seed.json'), 'seed side');
  markStateOwned(state);
  await mkdir(join(state, 'home'), { recursive: true });
  await writeFile(join(state, 'home', 'stale.txt'), 'stale');
  await writeFile(join(state, 'seed.json'), 'state side');

  restoreState(state, seed);

  assert.equal(await readFile(join(state, 'home', 'seeded.txt'), 'utf8'), 'seeded home');
  assert.equal(await readFile(join(state, 'oc-data', 'settings.json'), 'utf8'), 'seeded data');
  assert.equal(existsSync(join(state, 'home', 'stale.txt')), false);
  assert.equal(await readFile(join(state, 'seed.json'), 'utf8'), 'state side');
  assert.equal(await readFile(join(seed, 'seed.json'), 'utf8'), 'seed side');
}));
