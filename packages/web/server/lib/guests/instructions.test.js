import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createGuestInstructions } from './instructions.js';

describe('extension instructions', () => {
  let dataDir;
  let store;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'guest-instructions-'));
    store = createGuestInstructions({ dataDir });
  });
  afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

  const allowed = new Set(['desk']);

  test('text for a project reaches sessions in it and its subfolders, and nowhere else', async () => {
    await store.set('desk', '/repo', 'in the repo');
    expect(await store.forDirectory('/repo/packages/ui', allowed)).toEqual([{ guestId: 'desk', text: 'in the repo' }]);
    expect(await store.forDirectory('/repo-two', allowed)).toEqual([]);
    expect(await store.forDirectory('/other', allowed)).toEqual([]);
  });

  test('global text comes first, then the widest folder', async () => {
    await store.set('desk', '/repo/app', 'narrow');
    await store.set('desk', '/repo', 'wide');
    await store.set('desk', null, 'everywhere');
    expect(await store.forDirectory('/repo/app', allowed)).toEqual([{ guestId: 'desk', text: 'everywhere\n\nwide\n\nnarrow' }]);
  });

  test('only extensions that hold the grant now are read', async () => {
    await store.set('desk', null, 'text');
    expect(await store.forDirectory('/repo', new Set())).toEqual([]);
    expect(await store.forDirectory('/repo', new Set(['other']))).toEqual([]);
  });

  test('empty text removes it, and a removed extension leaves nothing', async () => {
    await store.set('desk', '/repo', 'text');
    await store.set('desk', '/repo', '   ');
    expect(await store.forDirectory('/repo', allowed)).toEqual([]);
    await store.set('desk', null, 'text');
    await store.remove('desk');
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'guest-instructions.json'), 'utf8'))).toEqual({});
  });

  test('writes in a row all land', async () => {
    await Promise.all(['a', 'b', 'c'].map((key) => store.set('desk', `/${key}`, key)));
    expect(await store.forDirectory('/b', allowed)).toEqual([{ guestId: 'desk', text: 'b' }]);
    expect(await store.forDirectory('/c', allowed)).toEqual([{ guestId: 'desk', text: 'c' }]);
  });
});
