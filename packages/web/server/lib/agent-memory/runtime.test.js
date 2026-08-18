import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgentMemoryRuntime } from './runtime.js';

const PROJECT_ID = 'path_dGVzdA';
const GLOBAL = { scope: 'global' };
const PROJECT = { scope: 'project', projectId: PROJECT_ID };

let rootDir;
let runtime;
let idCounter;

const globalPath = () => path.join(rootDir, 'config', 'memory.json');
const projectPath = () => path.join(rootDir, 'config', 'projects', PROJECT_ID, 'memory.json');

const writeJson = async (filePath, value) => {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

beforeEach(async () => {
  rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-agent-memory-'));
  idCounter = 0;
  runtime = createAgentMemoryRuntime({
    fsPromises,
    path,
    userConfigRoot: path.join(rootDir, 'config'),
    projectsDirPath: path.join(rootDir, 'config', 'projects'),
    createId: () => `mem-${++idCounter}`,
  });
});

afterEach(async () => {
  await fsPromises.rm(rootDir, { recursive: true, force: true });
});

describe('scope resolution', () => {
  test('the two scopes are separate files', async () => {
    await runtime.create(GLOBAL, { title: 'Speaks Ukrainian', body: 'Replies should be in Ukrainian.' });
    await runtime.create(PROJECT, { title: 'Uses bun', body: 'Tests run with bun test.' });

    expect((await runtime.read(GLOBAL)).entries.map((e) => e.title)).toEqual(['Speaks Ukrainian']);
    expect((await runtime.read(PROJECT)).entries.map((e) => e.title)).toEqual(['Uses bun']);
    await fsPromises.access(globalPath());
    await fsPromises.access(projectPath());
  });

  test('rejects an unknown scope', async () => {
    await expect(runtime.read({ scope: 'nope' })).rejects.toThrow('scope is required');
  });

  test('rejects a traversal projectId', async () => {
    await expect(runtime.read({ scope: 'project', projectId: '../escape' }))
      .rejects.toThrow('unsupported characters');
  });

  test('project scope requires an id', async () => {
    await expect(runtime.read({ scope: 'project' })).rejects.toThrow('projectId is required');
  });
});

describe('read', () => {
  test('missing file is authoritative empty', async () => {
    expect(await runtime.read(GLOBAL)).toEqual({ version: 1, entries: [] });
  });

  test('malformed storage fails instead of reading as empty', async () => {
    await fsPromises.mkdir(path.dirname(globalPath()), { recursive: true });
    await fsPromises.writeFile(globalPath(), '{ not json', 'utf8');

    await expect(runtime.read(GLOBAL)).rejects.toThrow('malformed');
  });

  test('drops malformed entries without failing the read', async () => {
    await writeJson(globalPath(), {
      version: 1,
      entries: [
        { id: 'a', title: 'Kept', body: 'body', createdAt: 1, updatedAt: 1 },
        { id: '', title: 'No id', body: 'body' },
        { id: 'c', title: '', body: 'no title' },
        { id: 'd', title: 'No body', body: '   ' },
      ],
    });

    expect((await runtime.read(GLOBAL)).entries.map((e) => e.id)).toEqual(['a']);
  });

  test('most recently updated is listed first', async () => {
    await writeJson(globalPath(), {
      version: 1,
      entries: [
        { id: 'old', title: 'Old', body: 'x', createdAt: 1, updatedAt: 1 },
        { id: 'new', title: 'New', body: 'x', createdAt: 1, updatedAt: 9 },
      ],
    });

    expect((await runtime.read(GLOBAL)).entries.map((e) => e.id)).toEqual(['new', 'old']);
  });

  test('an unknown type falls back to fact', async () => {
    await writeJson(globalPath(), {
      version: 1,
      entries: [{ id: 'a', title: 'T', body: 'b', type: 'nonsense', createdAt: 1, updatedAt: 1 }],
    });

    expect((await runtime.read(GLOBAL)).entries[0].type).toBe('fact');
  });
});

describe('create', () => {
  test('stores title, body, type and provenance', async () => {
    const { entry } = await runtime.create(PROJECT, {
      title: 'Bun test',
      body: 'Run tests per file.',
      type: 'reference',
      sessionId: 'ses_1',
    });

    expect(entry.type).toBe('reference');
    expect(entry.sessionId).toBe('ses_1');
    expect(entry.createdAt).toBe(entry.updatedAt);
  });

  test('rejects an empty title or body', async () => {
    await expect(runtime.create(GLOBAL, { title: '  ', body: 'x' })).rejects.toThrow('title is required');
    await expect(runtime.create(GLOBAL, { title: 'x', body: '  ' })).rejects.toThrow('body is required');
  });

  test('clamps oversized fields', async () => {
    const { entry } = await runtime.create(GLOBAL, { title: 'x'.repeat(300), body: 'y'.repeat(5000) });

    expect(entry.title).toHaveLength(60);
    expect(entry.body).toHaveLength(2000);
  });

  test('the same title updates in place instead of duplicating', async () => {
    const first = await runtime.create(PROJECT, { title: 'Uses bun', body: 'old body' });
    const second = await runtime.create(PROJECT, { title: 'uses BUN', body: 'new body' });

    expect(second.replaced).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.createdAt).toBe(first.entry.createdAt);
    expect((await runtime.read(PROJECT)).entries).toHaveLength(1);
    expect((await runtime.read(PROJECT)).entries[0].body).toBe('new body');
  });

  test('the same title in a different scope is a separate entry', async () => {
    await runtime.create(GLOBAL, { title: 'Shared title', body: 'global' });
    await runtime.create(PROJECT, { title: 'Shared title', body: 'project' });

    expect((await runtime.read(GLOBAL)).entries[0].body).toBe('global');
    expect((await runtime.read(PROJECT)).entries[0].body).toBe('project');
  });

  test('global memory is capped tighter than project memory', async () => {
    const entries = Array.from({ length: 60 }, (_unused, index) => ({
      id: `g${index}`, title: `Global ${index}`, body: 'x', createdAt: index, updatedAt: index,
    }));
    await writeJson(globalPath(), { version: 1, entries });

    await expect(runtime.create(GLOBAL, { title: 'One more', body: 'x' }))
      .rejects.toThrow('global memory is full');
  });

  test('project memory refuses to grow past its own limit', async () => {
    const entries = Array.from({ length: 200 }, (_unused, index) => ({
      id: `p${index}`, title: `Project ${index}`, body: 'x', createdAt: index, updatedAt: index,
    }));
    await writeJson(projectPath(), { version: 1, entries });

    await expect(runtime.create(PROJECT, { title: 'One more', body: 'x' }))
      .rejects.toThrow('project memory is full');
  });

  test('concurrent creates all survive', async () => {
    await Promise.all([
      runtime.create(PROJECT, { title: 'A', body: 'a' }),
      runtime.create(PROJECT, { title: 'B', body: 'b' }),
      runtime.create(PROJECT, { title: 'C', body: 'c' }),
    ]);

    expect((await runtime.read(PROJECT)).entries.map((e) => e.title).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('remove', () => {
  test('deletes only the requested entry', async () => {
    const keep = await runtime.create(PROJECT, { title: 'Keep', body: 'x' });
    const drop = await runtime.create(PROJECT, { title: 'Drop', body: 'x' });

    const result = await runtime.remove(PROJECT, drop.entry.id);
    expect(result.deleted).toBe(true);
    expect(result.entries.map((e) => e.id)).toEqual([keep.entry.id]);
  });

  test('reports no deletion for an unknown entry', async () => {
    expect((await runtime.remove(PROJECT, 'missing')).deleted).toBe(false);
  });
});

describe('readAll', () => {
  test('returns both scopes', async () => {
    await runtime.create(GLOBAL, { title: 'G', body: 'x' });
    await runtime.create(PROJECT, { title: 'P', body: 'x' });

    const all = await runtime.readAll(PROJECT_ID);
    expect(all.global.map((e) => e.title)).toEqual(['G']);
    expect(all.project.map((e) => e.title)).toEqual(['P']);
    expect(all.globalFailed).toBe(false);
    expect(all.projectFailed).toBe(false);
  });

  test('a broken project scope does not hide the global scope', async () => {
    await runtime.create(GLOBAL, { title: 'G', body: 'x' });
    await fsPromises.mkdir(path.dirname(projectPath()), { recursive: true });
    await fsPromises.writeFile(projectPath(), '{ broken', 'utf8');

    const all = await runtime.readAll(PROJECT_ID);
    expect(all.global.map((e) => e.title)).toEqual(['G']);
    expect(all.project).toEqual([]);
    expect(all.projectFailed).toBe(true);
  });

  test('works with no project at all', async () => {
    await runtime.create(GLOBAL, { title: 'G', body: 'x' });

    const all = await runtime.readAll(null);
    expect(all.global).toHaveLength(1);
    expect(all.project).toEqual([]);
  });
});

describe('restated duplicates', () => {
  test('a reworded restatement replaces the entry instead of adding a second', async () => {
    await runtime.create(PROJECT, {
      title: 'Run UI tests per file',
      body: 'UI tests must run one file at a time because module mocks leak between files.',
    });

    const result = await runtime.create(PROJECT, {
      title: 'UI tests run one file at a time',
      body: 'Because module mocks leak between files, UI tests must run per file.',
    });

    expect(result.replaced).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entry.title).toBe('UI tests run one file at a time');
  });

  test('keeps entries that merely share vocabulary', async () => {
    await runtime.create(PROJECT, {
      title: 'Package manager',
      body: 'This project installs dependencies with bun install.',
    });

    const result = await runtime.create(PROJECT, {
      title: 'Test runner',
      body: 'This project executes its unit suites through vitest.',
    });

    expect(result.replaced).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  test('short entries fall back to exact-title matching', async () => {
    await runtime.create(PROJECT, { title: 'Runtime', body: 'Use bun.' });
    const result = await runtime.create(PROJECT, { title: 'Bundler', body: 'Use vite.' });

    expect(result.replaced).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  test('a replacement bumps updatedAt so the panel can show it as changed', async () => {
    const first = await runtime.create(PROJECT, {
      title: 'Run UI tests per file',
      body: 'UI tests must run one file at a time because module mocks leak between files.',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));

    const second = await runtime.create(PROJECT, {
      title: 'UI tests run one file at a time',
      body: 'Because module mocks leak between files, UI tests must run per file.',
    });

    expect(second.entry.createdAt).toBe(first.entry.createdAt);
    expect(second.entry.updatedAt).toBeGreaterThan(first.entry.updatedAt);
  });

  test('a full store can still correct an entry it already holds', async () => {
    for (let index = 0; index < 60; index += 1) {
      await runtime.create(GLOBAL, { title: `Entry ${index}`, body: `Body number ${index}.` });
    }
    await expect(runtime.create(GLOBAL, { title: 'One more', body: 'Overflows the store.' }))
      .rejects.toThrow('memory is full');

    const result = await runtime.create(GLOBAL, { title: 'Entry 7', body: 'Corrected body.' });

    expect(result.replaced).toBe(true);
    expect(result.entries).toHaveLength(60);
    expect(result.entry.body).toBe('Corrected body.');
  });
});

describe('user corrections', () => {
  test('rewrites the wording without changing identity', async () => {
    const { entry } = await runtime.create(PROJECT, { title: 'Vague', body: 'Original.' });
    await new Promise((resolve) => setTimeout(resolve, 2));

    const result = await runtime.update(PROJECT, entry.id, { title: 'Clear', body: 'Reworded.' });

    expect(result.entry.id).toBe(entry.id);
    expect(result.entry.createdAt).toBe(entry.createdAt);
    expect(result.entry.updatedAt).toBeGreaterThan(entry.updatedAt);
    expect(result.entry.title).toBe('Clear');
  });

  test('patches only the named fields', async () => {
    const { entry } = await runtime.create(PROJECT, { title: 'Kept', body: 'Original.' });

    const result = await runtime.update(PROJECT, entry.id, { body: 'Reworded.' });

    expect(result.entry.title).toBe('Kept');
  });

  test('refuses to empty a field', async () => {
    const { entry } = await runtime.create(PROJECT, { title: 'T', body: 'b' });

    await expect(runtime.update(PROJECT, entry.id, { title: '   ' })).rejects.toThrow('title is required');
    await expect(runtime.update(PROJECT, entry.id, { body: '   ' })).rejects.toThrow('body is required');
  });

  test('rejects an empty patch', async () => {
    const { entry } = await runtime.create(PROJECT, { title: 'T', body: 'b' });

    await expect(runtime.update(PROJECT, entry.id, {})).rejects.toThrow('title, body or type is required');
  });

  test('an unknown id is reported, not invented', async () => {
    expect(await runtime.update(PROJECT, 'absent', { body: 'x' })).toBeNull();
  });
});
