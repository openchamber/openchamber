import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProjectContextRuntime, parsePlanMarkdown } from './runtime.js';

const PROJECT_ID = 'path_dGVzdA';

let projectsDirPath;
let runtime;
let idCounter;

const legacyConfigPath = () => path.join(projectsDirPath, `${PROJECT_ID}.json`);
const contextPath = () => path.join(projectsDirPath, PROJECT_ID, 'context.json');
const plansDir = () => path.join(projectsDirPath, PROJECT_ID, 'plans');

const writeJson = async (filePath, value) => {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

const readJson = async (filePath) => JSON.parse(await fsPromises.readFile(filePath, 'utf8'));

beforeEach(async () => {
  projectsDirPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-project-context-'));
  idCounter = 0;
  runtime = createProjectContextRuntime({
    fsPromises,
    path,
    projectsDirPath,
    createId: () => `plan-${++idCounter}`,
  });
});

afterEach(async () => {
  await fsPromises.rm(projectsDirPath, { recursive: true, force: true });
});

describe('projectId validation', () => {
  test('rejects traversal and empty ids', async () => {
    await expect(runtime.readContext('../escape')).rejects.toThrow('unsupported characters');
    await expect(runtime.readContext('a/b')).rejects.toThrow('unsupported characters');
    await expect(runtime.readContext('')).rejects.toThrow('projectId is required');
  });
});

describe('readContext', () => {
  test('missing file is authoritative empty', async () => {
    expect(await runtime.readContext(PROJECT_ID)).toEqual({
      version: 2,
      notes: [],
      todos: [],
      plans: [],
    });
  });

  test('malformed stored context fails instead of reading as empty', async () => {
    await fsPromises.mkdir(path.dirname(contextPath()), { recursive: true });
    await fsPromises.writeFile(contextPath(), '{ not json', 'utf8');
    await expect(runtime.readContext(PROJECT_ID)).rejects.toThrow('malformed');
  });

  test('drops malformed todo and plan entries without failing the read', async () => {
    await writeJson(contextPath(), {
      version: 2,
      notes: [{ id: 'n1', body: 'kept', createdAt: 1, updatedAt: 1, source: 'manual' }],
      todos: [{ id: 'a', text: 'ok', completed: false, createdAt: 1 }, { id: '', text: 'no id' }, { text: 'no id' }],
      plans: [
        { id: 'p1', file: 'a.md', title: 'A', createdAt: 2 },
        { id: 'p2', file: '../escape.md', title: 'Bad', createdAt: 3 },
        { id: 'p3', file: 'no-extension', createdAt: 4 },
      ],
    });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.notes.map((note) => note.body)).toEqual(['kept']);
    expect(context.todos.map((todo) => todo.id)).toEqual(['a']);
    expect(context.plans.map((plan) => plan.id)).toEqual(['p1']);
  });

  test('clamps a note body to the maximum length', async () => {
    await writeJson(contextPath(), {
      version: 2,
      notes: [{ id: 'n1', body: 'x'.repeat(5000), createdAt: 1, updatedAt: 1 }],
      todos: [],
      plans: [],
    });
    expect((await runtime.readContext(PROJECT_ID)).notes[0].body).toHaveLength(3000);
  });

  test('converts a version 1 string note into a single entry', async () => {
    await writeJson(contextPath(), { version: 1, notes: 'legacy blob', todos: [], plans: [] });

    const notes = (await runtime.readContext(PROJECT_ID)).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('legacy blob');
    expect(notes[0].source).toBe('manual');
    expect(notes[0].pinned).toBe(false);
  });

  test('an empty version 1 string converts to no notes at all', async () => {
    await writeJson(contextPath(), { version: 1, notes: '   ', todos: [], plans: [] });
    expect((await runtime.readContext(PROJECT_ID)).notes).toEqual([]);
  });

  test('newest note is listed first', async () => {
    await writeJson(contextPath(), {
      version: 2,
      notes: [
        { id: 'old', body: 'old', createdAt: 1, updatedAt: 1 },
        { id: 'new', body: 'new', createdAt: 9, updatedAt: 9 },
      ],
      todos: [],
      plans: [],
    });
    expect((await runtime.readContext(PROJECT_ID)).notes.map((note) => note.id)).toEqual(['new', 'old']);
  });
});

describe('legacy migration', () => {
  test('moves the three keys out of the client-owned config and preserves the rest', async () => {
    await fsPromises.mkdir(plansDir(), { recursive: true });
    await fsPromises.writeFile(path.join(plansDir(), '10-old.md'), '# Old plan\n\nbody here', 'utf8');
    await writeJson(legacyConfigPath(), {
      projectPath: '/tmp/test',
      'setup-worktree': ['bun install'],
      projectActions: [{ id: 'a', name: 'Dev', command: 'bun dev' }],
      projectNotes: 'legacy notes',
      projectTodos: [{ id: 't1', text: 'legacy todo', completed: true, createdAt: 5 }],
      projectPlanFiles: [{ id: 'p1', path: path.join(plansDir(), '10-old.md'), createdAt: 10 }],
    });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.notes.map((note) => note.body)).toEqual(['legacy notes']);
    expect(context.todos).toEqual([{ id: 't1', text: 'legacy todo', completed: true, createdAt: 5 }]);
    expect(context.plans).toEqual([{ id: 'p1', file: '10-old.md', title: 'Old plan', createdAt: 10, pinned: false }]);

    const remaining = await readJson(legacyConfigPath());
    expect(remaining).toEqual({
      projectPath: '/tmp/test',
      'setup-worktree': ['bun install'],
      projectActions: [{ id: 'a', name: 'Dev', command: 'bun dev' }],
    });
  });

  test('recovers a plan whose recorded path points outside the plans directory', async () => {
    const strayPath = path.join(projectsDirPath, 'stray.md');
    await fsPromises.writeFile(strayPath, '# Stray\n\nrecovered', 'utf8');
    await writeJson(legacyConfigPath(), {
      projectPlanFiles: [{ id: 'p1', path: strayPath, createdAt: 10 }],
    });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.plans).toEqual([{ id: 'p1', file: 'stray.md', title: 'Stray', createdAt: 10, pinned: false }]);
    expect(await fsPromises.readFile(path.join(plansDir(), 'stray.md'), 'utf8')).toContain('recovered');
  });

  test('drops a link whose markdown no longer exists anywhere', async () => {
    await writeJson(legacyConfigPath(), {
      projectNotes: 'kept',
      projectPlanFiles: [{ id: 'gone', path: path.join(plansDir(), 'missing.md'), createdAt: 10 }],
    });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.notes.map((note) => note.body)).toEqual(['kept']);
    expect(context.plans).toEqual([]);
  });

  test('does not run when the legacy config holds no context keys', async () => {
    await writeJson(legacyConfigPath(), { 'setup-worktree': ['bun install'] });

    expect(await runtime.readContext(PROJECT_ID)).toEqual({ version: 2, notes: [], todos: [], plans: [] });
    await expect(fsPromises.access(contextPath())).rejects.toThrow();
    expect(await readJson(legacyConfigPath())).toEqual({ 'setup-worktree': ['bun install'] });
  });

  test('is idempotent across repeated reads', async () => {
    await writeJson(legacyConfigPath(), { projectNotes: 'once', projectTodos: [] });

    const first = await runtime.readContext(PROJECT_ID);
    const second = await runtime.readContext(PROJECT_ID);
    expect(second).toEqual(first);
    expect(await readJson(legacyConfigPath())).toEqual({});
  });

  test('concurrent reads converge on the same migrated content', async () => {
    await writeJson(legacyConfigPath(), { projectNotes: 'concurrent', projectTodos: [] });

    const results = await Promise.all([
      runtime.readContext(PROJECT_ID),
      runtime.readContext(PROJECT_ID),
      runtime.readContext(PROJECT_ID),
    ]);
    for (const result of results) {
      expect(result.notes.map((note) => note.body)).toEqual(['concurrent']);
    }
    expect((await readJson(contextPath())).notes[0].body).toBe('concurrent');
  });
});

describe('todos', () => {
  test('round-trips through disk', async () => {
    await runtime.saveTodos(PROJECT_ID, [{ id: 't1', text: 'do it', completed: false, createdAt: 1 }]);

    expect((await runtime.readContext(PROJECT_ID)).todos).toEqual([
      { id: 't1', text: 'do it', completed: false, createdAt: 1 },
    ]);
  });

  test('preserves notes and plans it does not write', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'keep me' });
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Keep me', body: 'x' });

    await runtime.saveTodos(PROJECT_ID, [{ id: 't1', text: 'todo', createdAt: 1 }]);

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.notes.map((entry) => entry.id)).toEqual([note.id]);
    expect(context.plans.map((entry) => entry.id)).toEqual([plan.id]);
  });

  test('serializes concurrent writes without losing one', async () => {
    await Promise.all([
      runtime.saveTodos(PROJECT_ID, [{ id: '1', text: 'one', createdAt: 1 }]),
      runtime.saveTodos(PROJECT_ID, [{ id: '2', text: 'two', createdAt: 2 }]),
    ]);

    expect((await runtime.readContext(PROJECT_ID)).todos).toHaveLength(1);
  });

  test('clamps oversized todo text', async () => {
    await runtime.saveTodos(PROJECT_ID, [{ id: 't1', text: 'z'.repeat(300), createdAt: 1 }]);
    expect((await runtime.readContext(PROJECT_ID)).todos[0].text).toHaveLength(120);
  });
});

describe('notes', () => {
  test('create returns the stored note and prepends it', async () => {
    const first = await runtime.createNote(PROJECT_ID, { body: 'first' });
    const second = await runtime.createNote(PROJECT_ID, { body: 'second' });

    expect(first.note.source).toBe('manual');
    expect(first.note.pinned).toBe(false);
    expect(second.context.notes.map((note) => note.body)).toEqual(['second', 'first']);
  });

  test('create records provenance for a note distilled from a chat selection', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, {
      body: 'insight',
      source: 'selection',
      origin: { sessionId: 'ses_1', messageId: 'msg_1' },
    });

    expect(note.source).toBe('selection');
    expect(note.origin).toEqual({ sessionId: 'ses_1', messageId: 'msg_1' });
  });

  test('create drops an origin with no session', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'x', origin: { messageId: 'msg_1' } });
    expect(note.origin).toBeUndefined();
  });

  test('create rejects an empty body', async () => {
    await expect(runtime.createNote(PROJECT_ID, { body: '   ' })).rejects.toThrow('body is required');
  });

  test('create clamps an oversized body', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'y'.repeat(4000) });
    expect(note.body).toHaveLength(3000);
  });

  test('update patches the body and bumps updatedAt without touching createdAt', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'before' });
    await new Promise((resolve) => setTimeout(resolve, 2));

    const result = await runtime.updateNote(PROJECT_ID, note.id, { body: 'after' });
    expect(result.note.body).toBe('after');
    expect(result.note.createdAt).toBe(note.createdAt);
    expect(result.note.updatedAt).toBeGreaterThan(note.updatedAt);
  });

  test('pinning alone leaves the body and updatedAt untouched', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'body' });

    const result = await runtime.updateNote(PROJECT_ID, note.id, { pinned: true });
    expect(result.note.pinned).toBe(true);
    expect(result.note.body).toBe('body');
    expect(result.note.updatedAt).toBe(note.updatedAt);
  });

  test('update rejects an empty patch', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'body' });
    await expect(runtime.updateNote(PROJECT_ID, note.id, {})).rejects.toThrow('body or pinned is required');
  });

  test('update rejects blanking the body', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'body' });
    await expect(runtime.updateNote(PROJECT_ID, note.id, { body: '  ' })).rejects.toThrow('body is required');
  });

  test('update returns null for an unknown note', async () => {
    expect(await runtime.updateNote(PROJECT_ID, 'missing', { body: 'x' })).toBeNull();
  });

  test('delete removes only the requested note', async () => {
    const keep = await runtime.createNote(PROJECT_ID, { body: 'keep' });
    const drop = await runtime.createNote(PROJECT_ID, { body: 'drop' });

    const result = await runtime.deleteNote(PROJECT_ID, drop.note.id);
    expect(result.deleted).toBe(true);
    expect(result.context.notes.map((note) => note.id)).toEqual([keep.note.id]);
  });

  test('deleting an unknown note reports no deletion', async () => {
    const result = await runtime.deleteNote(PROJECT_ID, 'missing');
    expect(result.deleted).toBe(false);
  });

  test('refuses to grow past the note limit', async () => {
    const notes = Array.from({ length: 200 }, (_unused, index) => ({
      id: `n${index}`,
      body: `note ${index}`,
      createdAt: index,
      updatedAt: index,
    }));
    await writeJson(contextPath(), { version: 2, notes, todos: [], plans: [] });

    await expect(runtime.createNote(PROJECT_ID, { body: 'one too many' })).rejects.toThrow('at most 200 notes');
  });

  test('concurrent creates all survive', async () => {
    await Promise.all([
      runtime.createNote(PROJECT_ID, { body: 'a' }),
      runtime.createNote(PROJECT_ID, { body: 'b' }),
      runtime.createNote(PROJECT_ID, { body: 'c' }),
    ]);

    const bodies = (await runtime.readContext(PROJECT_ID)).notes.map((note) => note.body);
    expect(bodies.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('plans', () => {
  test('create writes markdown and returns a readable plan', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'My Plan', body: 'step one' });
    expect(plan.file).toMatch(/^\d+-my-plan\.md$/);

    const read = await runtime.readPlan(PROJECT_ID, plan.id);
    expect(read.title).toBe('My Plan');
    expect(read.body).toBe('step one');
    expect(read.raw).toBe('# My Plan\n\nstep one');
  });

  test('newest plan is listed first', async () => {
    const first = await runtime.createPlan(PROJECT_ID, { title: 'First', body: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await runtime.createPlan(PROJECT_ID, { title: 'Second', body: 'b' });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.plans.map((entry) => entry.id)).toEqual([second.plan.id, first.plan.id]);
  });

  test('reading an unknown plan returns null rather than throwing', async () => {
    expect(await runtime.readPlan(PROJECT_ID, 'nope')).toBeNull();
  });

  test('reading a plan whose markdown was deleted returns null', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Doomed', body: 'x' });
    await fsPromises.rm(path.join(plansDir(), plan.file));

    expect(await runtime.readPlan(PROJECT_ID, plan.id)).toBeNull();
  });

  test('delete removes both the entry and the markdown', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Bye', body: 'x' });

    const result = await runtime.deletePlan(PROJECT_ID, plan.id);
    expect(result.deleted).toBe(true);
    expect(result.context.plans).toEqual([]);
    await expect(fsPromises.access(path.join(plansDir(), plan.file))).rejects.toThrow();
  });

  test('deleting an unknown plan reports no deletion and keeps state', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Stay', body: 'x' });

    const result = await runtime.deletePlan(PROJECT_ID, 'missing');
    expect(result.deleted).toBe(false);
    expect(result.context.plans.map((entry) => entry.id)).toEqual([plan.id]);
  });

  test('plans created in the same millisecond do not collide on a file name', async () => {
    const created = await Promise.all([
      runtime.createPlan(PROJECT_ID, { title: 'Same', body: 'a' }),
      runtime.createPlan(PROJECT_ID, { title: 'Same', body: 'b' }),
    ]);

    const files = new Set(created.map((entry) => entry.plan.file));
    expect(files.size).toBe(2);
    const context = await runtime.readContext(PROJECT_ID);
    expect(context.plans).toHaveLength(2);
  });

  test('update rewrites the markdown verbatim and re-derives the manifest title', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Old', body: 'first' });

    const result = await runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# New title\n\n- step\n- step two\n' });
    expect(result.plan.title).toBe('New title');
    expect(result.plan.file).toBe(plan.file);

    expect(await fsPromises.readFile(path.join(plansDir(), plan.file), 'utf8')).toBe('# New title\n\n- step\n- step two\n');
    expect((await runtime.readContext(PROJECT_ID)).plans[0].title).toBe('New title');
  });

  test('update keeps the file name when the title changes', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Original', body: 'x' });

    await runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# Totally different\n\nx' });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.plans[0].file).toBe(plan.file);
    expect(context.plans).toHaveLength(1);
  });

  test('update returns null for an unknown plan without writing anything', async () => {
    expect(await runtime.updatePlan(PROJECT_ID, 'missing', { raw: '# X' })).toBeNull();
    await expect(fsPromises.readdir(plansDir())).rejects.toThrow();
  });

  test('update refuses to recreate markdown deleted underneath it', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Gone', body: 'x' });
    await fsPromises.rm(path.join(plansDir(), plan.file));

    expect(await runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# Resurrected' })).toBeNull();
    await expect(fsPromises.access(path.join(plansDir(), plan.file))).rejects.toThrow();
  });

  test('update rejects a non-string payload', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'A', body: 'x' });
    await expect(runtime.updatePlan(PROJECT_ID, plan.id, {})).rejects.toThrow('raw is required');
  });

  test('update does not disturb notes or todos', async () => {
    await runtime.createNote(PROJECT_ID, { body: 'keep me' });
    await runtime.saveTodos(PROJECT_ID, [{ id: 't1', text: 'keep', completed: false, createdAt: 1 }]);
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'A', body: 'x' });

    await runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# B\n\ny' });

    const context = await runtime.readContext(PROJECT_ID);
    expect(context.notes.map((note) => note.body)).toEqual(['keep me']);
    expect(context.todos).toHaveLength(1);
  });

  test('pinning a plan leaves its title and file alone', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Pin me', body: 'x' });

    const result = await runtime.setPlanPinned(PROJECT_ID, plan.id, true);
    expect(result.plan).toEqual({ ...plan, pinned: true });
    expect((await runtime.readContext(PROJECT_ID)).plans[0].pinned).toBe(true);
  });

  test('pinning an unknown plan returns null', async () => {
    expect(await runtime.setPlanPinned(PROJECT_ID, 'missing', true)).toBeNull();
  });

  test('editing a plan preserves its pin state', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'A', body: 'x' });
    await runtime.setPlanPinned(PROJECT_ID, plan.id, true);

    const result = await runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# B\n\ny' });
    expect(result.plan.pinned).toBe(true);
  });

  test('an untitled body still produces a titled markdown file', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: '', body: '' });
    const read = await runtime.readPlan(PROJECT_ID, plan.id);
    expect(read.title).toBe('Plan');
    expect(read.body).toBe('');
  });
});

describe('parsePlanMarkdown', () => {
  test('reads the leading heading as the title', () => {
    expect(parsePlanMarkdown('# Title\n\nbody')).toEqual({ title: 'Title', body: 'body' });
  });

  test('falls back to the first non-empty line', () => {
    expect(parsePlanMarkdown('\n\njust text\nmore')).toEqual({ title: 'just text', body: 'just text\nmore' });
  });

  test('normalizes CRLF input', () => {
    expect(parsePlanMarkdown('# Title\r\n\r\nbody')).toEqual({ title: 'Title', body: 'body' });
  });

  test('empty input yields the default title', () => {
    expect(parsePlanMarkdown('')).toEqual({ title: 'Plan', body: '' });
  });
});
