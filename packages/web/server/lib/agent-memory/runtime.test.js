import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
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

  test('a project id too long for a folder name is stored under the bounded stem', async () => {
    // A checkout nested deep enough that its `path_<base64url>` id is longer
    // than a folder name may be; the store lands under the bounded stem the
    // config file and project context use, instead of failing with ENAMETOOLONG.
    const longProjectId = createProjectIdFromPath(`/private/tmp/claude-501/${'segment-'.repeat(18)}/scratchpad/evidence/demo-repo`);
    const stem = projectConfigFileStemOf(longProjectId);
    expect(longProjectId.length).toBeGreaterThan(240);
    expect(stem.startsWith('path_sha256_')).toBe(true);
    const target = { scope: 'project', projectId: longProjectId };

    expect((await runtime.read(target)).entries).toEqual([]);
    await runtime.create(target, { title: 'Uses bun', body: 'Tests run with bun test.' });

    expect((await runtime.read(target)).entries.map((e) => e.title)).toEqual(['Uses bun']);
    expect((await runtime.readAll(longProjectId)).project.map((e) => e.title)).toEqual(['Uses bun']);
    await fsPromises.access(path.join(rootDir, 'config', 'projects', stem, 'memory.json'));
    expect(await fsPromises.readdir(path.join(rootDir, 'config', 'projects'))).toEqual([stem]);
    // A short id keeps naming its folder itself.
    expect(runtime.resolveTarget(PROJECT).filePath).toBe(projectPath());
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

  test.each([
    ['missing version', { entries: [] }],
    ['unknown version', { version: 99, entries: [] }],
    ['current version', { version: 1, entries: [] }],
  ])('valid empty storage stays readable with %s', async (_label, value) => {
    await writeJson(globalPath(), value);
    const before = await fsPromises.readFile(globalPath());

    expect(await runtime.read(GLOBAL)).toEqual({ version: 1, entries: [] });
    expect(await fsPromises.readFile(globalPath())).toEqual(before);
  });

  test('legacy entries and version handling remain tolerant without read-time writeback', async () => {
    await writeJson(globalPath(), {
      version: 99,
      entries: [
        { id: 'legacy', title: 'Legacy', body: 'Stored text', type: 'old-type', createdAt: 1 },
        { id: 'bad', title: '', body: 'Skipped' },
      ],
    });
    const before = await fsPromises.readFile(globalPath());

    expect(await runtime.read(GLOBAL)).toEqual({
      version: 1,
      entries: [{ id: 'legacy', title: 'Legacy', body: 'Stored text', type: 'fact', createdAt: 1, updatedAt: 1 }],
    });
    expect(await fsPromises.readFile(globalPath())).toEqual(before);
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

describe('storage integrity', () => {
  const corruptDocuments = [
    ['missing entries', '{}'],
    ['null entries', '{"entries":null}'],
    ['object entries', '{"entries":{}}'],
    ['string entries', '{"entries":"invalid"}'],
    ['number entries', '{"entries":1}'],
    ['boolean entries', '{"entries":false}'],
    ['malformed JSON', '{ broken'],
    ['array document', '[]'],
    ['null document', 'null'],
    ['primitive document', '1'],
  ];

  for (const [operation, mutate] of [
    ['read', () => runtime.read(GLOBAL)],
    ['create', () => runtime.create(GLOBAL, { title: 'New', body: 'New text' })],
    ['update', () => runtime.update(GLOBAL, 'mem-1', { body: 'Updated text' })],
    ['delete', () => runtime.remove(GLOBAL, 'mem-1')],
  ]) {
    test.each(corruptDocuments)(`${operation} rejects %s without changing bytes, then releases the lock`, async (_label, raw) => {
      await runtime.create(GLOBAL, { title: 'Keep', body: 'Original text' });
      const valid = await fsPromises.readFile(globalPath());
      await fsPromises.writeFile(globalPath(), raw);
      const before = await fsPromises.readFile(globalPath());
      await expect(mutate()).rejects.toThrow('malformed');
      expect(await fsPromises.readFile(globalPath())).toEqual(before);
      expect(await fsPromises.readdir(path.dirname(globalPath()))).toEqual(['memory.json']);

      await fsPromises.writeFile(globalPath(), valid);
      // A write after restoration also proves a failed mutation released its lock.
      await runtime.update(GLOBAL, 'mem-1', { body: 'Restored text' });
      expect(await fsPromises.readFile(globalPath())).not.toEqual(valid);
    });
  }

  test('an atomic-write failure preserves the valid file and releases the lock', async () => {
    await runtime.create(GLOBAL, { title: 'Keep', body: 'Original text' });
    const before = await fsPromises.readFile(globalPath());
    const directory = path.dirname(globalPath());
    let failNextWrite = true;
    const failingRuntime = createAgentMemoryRuntime({
      fsPromises: {
        ...fsPromises,
        writeFile: async (file, ...rest) => {
          if (failNextWrite) {
            failNextWrite = false;
            await fsPromises.writeFile(file, 'partial temporary write', 'utf8');
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          }
          return fsPromises.writeFile(file, ...rest);
        },
      },
      path,
      userConfigRoot: directory,
      projectsDirPath: path.join(directory, 'projects'),
    });
    await expect(failingRuntime.update(GLOBAL, 'mem-1', { body: 'Changed text' })).rejects.toThrow('ENOSPC');
    expect(await fsPromises.readFile(globalPath())).toEqual(before);
    expect(await fsPromises.readdir(directory)).toEqual(['memory.json']);

    await failingRuntime.update(GLOBAL, 'mem-1', { body: 'Changed text' });
    expect((await failingRuntime.read(GLOBAL)).entries[0].body).toBe('Changed text');
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

  test('rejects a body over the limit instead of truncating it', async () => {
    // A silent slice left the agent with a success for a body it never
    // stored, so an over-limit body must come back as an error, not a trim.
    await expect(runtime.create(GLOBAL, { title: 'x'.repeat(300), body: 'y'.repeat(2001) }))
      .rejects.toThrow('body holds at most 2000 characters');
    expect((await runtime.read(GLOBAL)).entries).toHaveLength(0);

    const { entry } = await runtime.create(GLOBAL, { title: 'T', body: 'y'.repeat(2000) });
    expect(entry.body).toHaveLength(2000);
  });

  test('a legacy over-limit entry still loads, while a new write of that size is rejected', async () => {
    // Older builds truncated at a shorter limit, and hand-edits can exceed it;
    // the store must stay loadable, so reads stay tolerant and only writes
    // enforce the limit.
    await writeJson(globalPath(), {
      version: 1,
      entries: [{ id: 'legacy', title: 'Legacy', body: 'z'.repeat(2500), createdAt: 1, updatedAt: 1 }],
    });
    expect((await runtime.read(GLOBAL)).entries[0].body).toHaveLength(2000);

    await expect(runtime.create(GLOBAL, { title: 'Too long', body: 'z'.repeat(2500) }))
      .rejects.toThrow('body holds at most 2000 characters');
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

  test('a reversed decision is stored beside the entry it contradicts and reports it as related', async () => {
    const original = await runtime.create(PROJECT, {
      title: 'Unit tests run with bun',
      body: 'Run the unit suites with bun test.',
    });
    await runtime.create(PROJECT, { title: 'Package manager', body: 'Dependencies install with bun install here.' });

    const result = await runtime.create(PROJECT, {
      title: 'Unit tests moved to vitest',
      body: 'Unit suites now run through vitest; bun test no longer runs them.',
    });

    expect(result.replaced).toBe(false);
    expect(result.entries).toHaveLength(3);
    expect(result.related.map((entry) => entry.id)).toEqual([original.entry.id]);
  });

  test('an unrelated new entry reports nothing related', async () => {
    await runtime.create(PROJECT, {
      title: 'Package manager',
      body: 'This project installs dependencies with bun install.',
    });

    const result = await runtime.create(PROJECT, {
      title: 'Test runner',
      body: 'This project executes its unit suites through vitest.',
    });

    expect(result.related).toEqual([]);
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

  test('rejects an over-limit body instead of truncating it', async () => {
    const { entry } = await runtime.create(PROJECT, { title: 'T', body: 'b' });

    await expect(runtime.update(PROJECT, entry.id, { body: 'y'.repeat(2001) }))
      .rejects.toThrow('body holds at most 2000 characters');
    expect((await runtime.read(PROJECT)).entries[0].body).toBe('b');
  });

  test('rejects an empty patch', async () => {
    const { entry } = await runtime.create(PROJECT, { title: 'T', body: 'b' });

    await expect(runtime.update(PROJECT, entry.id, {})).rejects.toThrow('title, body or type is required');
  });

  test('an unknown id is reported, not invented', async () => {
    expect(await runtime.update(PROJECT, 'absent', { body: 'x' })).toBeNull();
  });
});

describe('dreaming state', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const leftBy = async (target) => (await runtime.read(target)).entries.map((entry) => ({ id: entry.id, updatedAt: entry.updatedAt }));

  test('a scope that never dreamed reads as such', async () => {
    expect(await runtime.readDreamState(PROJECT)).toEqual({ lastRunAt: null, record: null, snapshot: null, after: null });
  });

  test('undo puts back what the pass removed and rewrote', async () => {
    const { entry: kept } = await runtime.create(PROJECT, { title: 'Kept', body: 'Kept as it was.' });
    const { entry: removed } = await runtime.create(PROJECT, { title: 'Removed', body: 'Gone after the pass.' });
    const before = (await runtime.read(PROJECT)).entries;

    await sleep(2);
    await runtime.update(PROJECT, kept.id, { body: 'Rewritten by the pass.' });
    await runtime.remove(PROJECT, removed.id);
    const finishedAt = Date.now();
    await runtime.recordDream(PROJECT, { lastRunAt: finishedAt, record: { finishedAt, merged: 0, removed: 1, rewritten: 1 }, snapshot: before, after: await leftBy(PROJECT) });

    const result = await runtime.undoDream(PROJECT);
    expect(result.record.undone).toBe(true);
    const after = (await runtime.read(PROJECT)).entries;
    expect(after.map((entry) => entry.body).sort()).toEqual(['Gone after the pass.', 'Kept as it was.']);

    const state = await runtime.readDreamState(PROJECT);
    expect(state.snapshot).toBeNull();
    expect(state.lastRunAt).toBe(finishedAt);
    // A second undo has nothing to put back.
    expect(await runtime.undoDream(PROJECT)).toBeNull();
  });

  test('undo keeps what was written, created and deleted after the pass', async () => {
    const { entry: survivor } = await runtime.create(PROJECT, { title: 'Survivor', body: 'Before the pass.' });
    const { entry: untouched } = await runtime.create(PROJECT, { title: 'Untouched', body: 'The pass left this alone.' });
    const before = (await runtime.read(PROJECT)).entries;
    await sleep(2);
    await runtime.update(PROJECT, survivor.id, { body: 'Merged by the pass.' });
    const finishedAt = Date.now();
    await runtime.recordDream(PROJECT, { lastRunAt: finishedAt, record: { finishedAt, merged: 1, removed: 0, rewritten: 1 }, snapshot: before, after: await leftBy(PROJECT) });

    await sleep(2);
    await runtime.update(PROJECT, survivor.id, { body: 'Corrected by the user later.' });
    await runtime.create(PROJECT, { title: 'Learned later', body: 'Saved after the pass ended.' });
    await runtime.remove(PROJECT, untouched.id);

    await runtime.undoDream(PROJECT);
    const bodies = (await runtime.read(PROJECT)).entries.map((value) => value.body).sort();
    expect(bodies).toEqual(['Corrected by the user later.', 'Saved after the pass ended.']);
  });

  test('a failed pass without a snapshot offers no undo', async () => {
    const finishedAt = Date.now();
    await runtime.recordDream(GLOBAL, { lastRunAt: finishedAt, record: { finishedAt, status: 'failed', error: 'timed out' }, snapshot: null });
    const state = await runtime.readDreamState(GLOBAL);
    expect(state.record).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(await runtime.undoDream(GLOBAL)).toBeNull();
  });
});
