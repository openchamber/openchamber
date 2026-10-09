import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
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

describe('atomic todo mutations', () => {
  test('returns actual created items and matching snapshots for concurrent identical text', async () => {
    const changes = [];
    const announcing = createProjectContextRuntime({
      fsPromises, path, projectsDirPath, createId: () => `todo-${++idCounter}`,
      onChanged: (id) => changes.push(id),
    });
    await announcing.saveTodos(PROJECT_ID, [{ id: 'completed', text: 'same', completed: true, createdAt: 1 }]);
    changes.length = 0;
    const [first, legacy, third] = await Promise.all([
      announcing.createTodoWithResult(PROJECT_ID, { text: ' same ' }),
      announcing.createTodo(PROJECT_ID, { text: 'same' }),
      announcing.createTodoWithResult(PROJECT_ID, { text: 'same' }),
    ]);
    expect(first.todo.id).toBe('todo-1');
    expect(third.todo.id).toBe('todo-3');
    expect(first.todo).toEqual({ id: 'todo-1', text: 'same', completed: false, createdAt: expect.any(Number) });
    expect(first.context.todos).toEqual([first.todo, { id: 'completed', text: 'same', completed: true, createdAt: 1 }]);
    expect(legacy.todos.map((todo) => todo.id)).toEqual(['todo-1', 'todo-2', 'completed']);
    expect(legacy.todo).toBeUndefined();
    expect(legacy.context).toBeUndefined();
    expect(third.context.todos.map((todo) => todo.id)).toEqual(['todo-1', 'todo-2', 'todo-3', 'completed']);
    expect(third.context.todos.find((todo) => todo.id === third.todo.id)).toEqual(third.todo);
    expect((await announcing.readContext(PROJECT_ID)).todos).toEqual(third.context.todos);
    expect(changes).toEqual([PROJECT_ID, PROJECT_ID, PROJECT_ID]);
  });

  test('both create result contracts reject failed writes without returning or notifying', async () => {
    const changes = [];
    const guarded = createProjectContextRuntime({
      fsPromises: { ...fsPromises, rename: async () => { throw new Error('commit failed'); } },
      path, projectsDirPath, createId: () => `todo-${++idCounter}`, onChanged: (id) => changes.push(id),
    });
    await expect(guarded.createTodoWithResult(PROJECT_ID, { text: 'new' })).rejects.toThrow('commit failed');
    await expect(guarded.createTodo(PROJECT_ID, { text: 'legacy' })).rejects.toThrow('commit failed');
    expect((await guarded.readContext(PROJECT_ID)).todos).toEqual([]);
    expect(changes).toEqual([]);
    await expect(guarded.createTodoWithResult(PROJECT_ID, { text: '' })).rejects.toMatchObject({ status: 400 });
    await runtime.saveTodos(PROJECT_ID, Array.from({ length: 500 }, (_, index) => ({ id: `t${index}`, text: 'todo', createdAt: 1 })));
    await expect(guarded.createTodoWithResult(PROJECT_ID, { text: 'overflow' })).rejects.toMatchObject({ status: 400 });
  });

  test('stores original completion, reopening and creation order while preserving peers', async () => {
    const initial = await runtime.saveTodos(PROJECT_ID, [
      { id: 'a', text: 'A', completed: false, createdAt: 1 },
      { id: 'b', text: 'B', completed: false, createdAt: 2 },
      { id: 'c', text: 'C', completed: true, createdAt: 3 },
      { id: 'd', text: 'D', completed: true, createdAt: 4 },
    ]);
    const completed = await runtime.updateTodo(PROJECT_ID, 'a', { completed: true });
    expect(completed.todos.map((todo) => todo.id)).toEqual(['b', 'c', 'd', 'a']);
    expect((await runtime.updateTodo(PROJECT_ID, 'c', { completed: true })).todos).toEqual(completed.todos);
    const edited = await runtime.updateTodo(PROJECT_ID, 'c', { text: 'edited' });
    expect(edited.todos.map((todo) => todo.id)).toEqual(['b', 'c', 'd', 'a']);
    const reopened = await runtime.updateTodo(PROJECT_ID, 'a', { text: 'reopened', completed: false });
    expect(reopened.todos.map((todo) => todo.id)).toEqual(['b', 'a', 'c', 'd']);
    await Promise.all([
      runtime.createTodo(PROJECT_ID, { text: 'peer' }),
      runtime.updateTodo(PROJECT_ID, 'd', { completed: false }),
    ]);
    const current = (await runtime.readContext(PROJECT_ID)).todos;
    expect(current.map((todo) => todo.text)).toEqual(['B', 'reopened', 'peer', 'D', 'edited']);
    expect(current.find((todo) => todo.id === 'a')).toEqual({ ...initial.todos[0], text: 'reopened' });
    await runtime.updateTodo(PROJECT_ID, 'c', { completed: false });
    const allOpen = await runtime.updateTodo(PROJECT_ID, 'b', { completed: true });
    expect(allOpen.todos.at(-1).id).toBe('b');
    expect((await runtime.updateTodo(PROJECT_ID, 'b', { completed: false })).todos.at(-1).id).toBe('b');
  });
  test('creates stable server ids, patches fields, reopens and deletes one item', async () => {
    const first = await runtime.createTodo(PROJECT_ID, { text: ' one ' });
    const item = first.todos[0];
    await runtime.createTodo(PROJECT_ID, { text: 'two' });
    await runtime.updateTodo(PROJECT_ID, item.id, { completed: true });
    const edited = await runtime.updateTodo(PROJECT_ID, item.id, { text: 'edited' });
    expect(edited.todos.at(-1)).toEqual({ ...item, text: 'edited', completed: true });
    await runtime.updateTodo(PROJECT_ID, item.id, { completed: false });
    const deleted = await runtime.deleteTodo(PROJECT_ID, item.id);
    expect(deleted.todos.map((todo) => todo.text)).toEqual(['two']);
    expect((await runtime.readContext(PROJECT_ID)).todos).toEqual(deleted.todos);
    await expect(runtime.updateTodo(PROJECT_ID, item.id, { completed: true })).rejects.toMatchObject({ status: 404 });
    await expect(runtime.deleteTodo(PROJECT_ID, item.id)).rejects.toMatchObject({ status: 404 });
  });

  test('serializes parallel creates and field patches without losing unrelated data', async () => {
    await runtime.createNote(PROJECT_ID, { body: 'keep note', source: 'agent', origin: { sessionId: 'ses_1' } });
    await Promise.all(Array.from({ length: 20 }, (_, index) => runtime.createTodo(PROJECT_ID, { text: `todo ${index}` })));
    const before = await runtime.readContext(PROJECT_ID);
    const id = before.todos[0].id;
    await Promise.all([
      runtime.updateTodo(PROJECT_ID, id, { text: 'edited' }),
      runtime.updateTodo(PROJECT_ID, id, { completed: true }),
      runtime.deleteTodo(PROJECT_ID, before.todos[1].id),
    ]);
    const after = await runtime.readContext(PROJECT_ID);
    expect(after.todos).toHaveLength(19);
    expect(after.todos.at(-1)).toEqual({ ...before.todos[0], text: 'edited', completed: true });
    expect(after.notes).toEqual(before.notes);
  });

  test('rejects stale bulk writes in either ordering and preserves legacy replacement', async () => {
    const initial = await runtime.createTodo(PROJECT_ID, { text: 'one' });
    const id = initial.todos[0].id;
    const results = await Promise.allSettled([
      runtime.createTodo(PROJECT_ID, { text: 'agent' }),
      runtime.saveTodos(PROJECT_ID, [], { expectedTodos: initial.todos }),
    ]);
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect((await runtime.readContext(PROJECT_ID)).todos).toHaveLength(2);
    const confirmed = (await runtime.readContext(PROJECT_ID)).todos;
    await Promise.all([
      runtime.saveTodos(PROJECT_ID, [...confirmed].reverse(), { expectedTodos: confirmed }),
      runtime.updateTodo(PROJECT_ID, id, { completed: true }),
    ]);
    expect((await runtime.readContext(PROJECT_ID)).todos.find((todo) => todo.id === id).completed).toBe(true);
    await runtime.saveTodos(PROJECT_ID, []);
    expect((await runtime.readContext(PROJECT_ID)).todos).toEqual([]);
  });

  test('rejects invalid items and capacity overflow', async () => {
    for (const text of ['', '   ', 12, 'x'.repeat(1001)]) {
      await expect(runtime.createTodo(PROJECT_ID, { text })).rejects.toMatchObject({ status: 400 });
    }
    await expect(runtime.updateTodo(PROJECT_ID, 'x', {})).rejects.toMatchObject({ status: 400 });
    await expect(runtime.updateTodo(PROJECT_ID, 'x', { completed: 'yes' })).rejects.toMatchObject({ status: 400 });
    await runtime.saveTodos(PROJECT_ID, Array.from({ length: 500 }, (_, index) => ({ id: `t${index}`, text: 'todo', createdAt: 1 })));
    await expect(runtime.createTodo(PROJECT_ID, { text: 'overflow' })).rejects.toMatchObject({ status: 400 });
    expect((await runtime.readContext(PROJECT_ID)).todos).toHaveLength(500);
  });

  test('failed commits, malformed reads and stale writes emit no change', async () => {
    const changes = [];
    let failRename = false;
    const guarded = createProjectContextRuntime({
      fsPromises: { ...fsPromises, rename: async (...args) => {
        if (failRename) throw new Error('commit failed');
        return fsPromises.rename(...args);
      } },
      path, projectsDirPath, createId: () => 'todo-1', onChanged: (id) => changes.push(id),
    });
    const initial = await guarded.createTodo(PROJECT_ID, { text: 'keep' });
    changes.length = 0;
    failRename = true;
    await expect(guarded.updateTodo(PROJECT_ID, 'todo-1', { completed: true })).rejects.toThrow('commit failed');
    expect((await guarded.readContext(PROJECT_ID)).todos).toEqual(initial.todos);
    await expect(guarded.saveTodos(PROJECT_ID, [], { expectedTodos: [] })).rejects.toMatchObject({ status: 409 });
    await fsPromises.writeFile(contextPath(), '{ malformed', 'utf8');
    await expect(guarded.createTodo(PROJECT_ID, { text: 'new' })).rejects.toThrow('malformed');
    expect(changes).toEqual([]);
  });
});

describe('conditional plan updates', () => {
  test('refuses capacity overflow before creating a file', async () => {
    await writeJson(contextPath(), { version: 2, notes: [], todos: [],
      plans: Array.from({ length: 500 }, (_, index) => ({ id: `p${index}`, file: `${index}.md`, title: 'Plan', createdAt: 1 })) });
    await expect(runtime.createPlan(PROJECT_ID, { title: 'overflow', body: 'new' })).rejects.toMatchObject({ status: 400 });
    expect((await readJson(contextPath())).plans).toHaveLength(500);
    await expect(fsPromises.access(plansDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('preserves raw markdown and legacy calls; rejects stale replacement', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'A', body: 'original' });
    const original = await runtime.readPlan(PROJECT_ID, plan.id);
    const raw = '# B\r\n\r\n  keep formatting\n';
    await runtime.updatePlan(PROJECT_ID, plan.id, { raw }, { expectedRaw: original.raw });
    await expect(runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# stale' }, { expectedRaw: original.raw })).rejects.toMatchObject({ status: 409 });
    expect((await runtime.readPlan(PROJECT_ID, plan.id)).raw).toBe(raw);
    await runtime.updatePlan(PROJECT_ID, plan.id, { raw: '# Legacy\n' });
    expect((await runtime.readPlan(PROJECT_ID, plan.id)).raw).toBe('# Legacy\n');
  });

  test('checks raw shared plans under the lock and does not announce conflicts', async () => {
    const sharedDir = path.join(projectsDirPath, 'shared');
    await fsPromises.mkdir(sharedDir);
    await fsPromises.writeFile(path.join(sharedDir, 'team.md'), '# Team\n');
    const changes = [];
    const shared = createProjectContextRuntime({ fsPromises, path, projectsDirPath,
      resolveSharedPlansDir: async () => sharedDir, onChanged: (id) => changes.push(id) });
    const results = await Promise.allSettled([
      shared.updatePlan(PROJECT_ID, 'shared:team.md', { raw: '# First\n' }, { expectedRaw: '# Team\n' }),
      shared.updatePlan(PROJECT_ID, 'shared:team.md', { raw: '# Second\n' }, { expectedRaw: '# Team\n' }),
    ]);
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect((await shared.readPlan(PROJECT_ID, 'shared:team.md')).raw).toBe('# First\n');
    expect(changes).toEqual([PROJECT_ID]);
  });
});

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
      sharedPlansDir: null,
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
    expect(context.plans).toEqual([{ id: 'p1', file: '10-old.md', title: 'Old plan', createdAt: 10, pinned: false, source: 'personal' }]);

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
    expect(context.plans).toEqual([{ id: 'p1', file: 'stray.md', title: 'Stray', createdAt: 10, pinned: false, source: 'personal' }]);
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

    expect(await runtime.readContext(PROJECT_ID)).toEqual({ version: 2, notes: [], todos: [], plans: [], sharedPlansDir: null });
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

describe('long project ids', () => {
  // A checkout nested deep enough that its `path_<base64url>` id is longer
  // than a file or folder name may be; the storage lands under the bounded
  // stem instead of failing with ENAMETOOLONG.
  const longProjectId = createProjectIdFromPath(`/private/tmp/claude-501/${'segment-'.repeat(18)}/scratchpad/evidence/demo-repo`);
  const stem = projectConfigFileStemOf(longProjectId);

  test('the id maps to a bounded folder name', () => {
    expect(longProjectId.length).toBeGreaterThan(240);
    expect(stem.startsWith('path_sha256_')).toBe(true);
    expect(stem.length).toBeLessThan(100);
    expect(runtime.contextPathFor(longProjectId)).toBe(path.join(projectsDirPath, stem, 'context.json'));
    expect(runtime.plansDirFor(longProjectId)).toBe(path.join(projectsDirPath, stem, 'plans'));
    // A short id keeps naming its folder itself.
    expect(runtime.contextPathFor(PROJECT_ID)).toBe(contextPath());
  });

  test('a missing context reads as empty instead of failing on the legacy config lookup', async () => {
    expect(await runtime.readContext(longProjectId)).toEqual({ version: 2, notes: [], todos: [], plans: [], sharedPlansDir: null });
  });

  test('context and plans round-trip through the bounded folder', async () => {
    await runtime.saveTodos(longProjectId, [{ id: 't1', text: 'do it', completed: false, createdAt: 1 }]);
    const { note } = await runtime.createNote(longProjectId, { body: 'kept' });
    const { plan } = await runtime.createPlan(longProjectId, { title: 'Deep plan', body: 'step one' });

    const context = await runtime.readContext(longProjectId);
    expect(context.todos).toEqual([{ id: 't1', text: 'do it', completed: false, createdAt: 1 }]);
    expect(context.notes.map((entry) => entry.id)).toEqual([note.id]);
    expect(context.plans.map((entry) => entry.id)).toEqual([plan.id]);
    expect((await runtime.readPlan(longProjectId, plan.id)).body).toBe('step one');

    expect((await readJson(path.join(projectsDirPath, stem, 'context.json'))).todos).toHaveLength(1);
    await fsPromises.access(path.join(projectsDirPath, stem, 'plans', plan.file));
    expect(await fsPromises.readdir(projectsDirPath)).toEqual([stem]);
  });

  test('legacy keys are migrated out of the bounded config file', async () => {
    const boundedConfigPath = path.join(projectsDirPath, `${stem}.json`);
    await writeJson(boundedConfigPath, {
      'setup-worktree': ['bun install'],
      projectNotes: 'legacy notes',
      projectTodos: [{ id: 't1', text: 'legacy todo', completed: true, createdAt: 5 }],
    });

    const context = await runtime.readContext(longProjectId);
    expect(context.notes.map((entry) => entry.body)).toEqual(['legacy notes']);
    expect(context.todos).toEqual([{ id: 't1', text: 'legacy todo', completed: true, createdAt: 5 }]);
    expect(await readJson(boundedConfigPath)).toEqual({ 'setup-worktree': ['bun install'] });
    expect((await readJson(path.join(projectsDirPath, stem, 'context.json'))).notes[0].body).toBe('legacy notes');
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
    await runtime.saveTodos(PROJECT_ID, [{ id: 't1', text: 'z'.repeat(1500), createdAt: 1 }]);
    expect((await runtime.readContext(PROJECT_ID)).todos[0].text).toHaveLength(1000);
  });
});

describe('committed changes', () => {
  test('announces the owner only after note and todo changes reach disk', async () => {
    const changes = [];
    const announcing = createProjectContextRuntime({
      fsPromises,
      path,
      projectsDirPath,
      createId: () => `note-${++idCounter}`,
      onChanged: (projectId) => {
        changes.push({ projectId, context: JSON.parse(readFileSync(announcing.contextPathFor(projectId), 'utf8')) });
      },
    });
    await announcing.readContext(PROJECT_ID);
    expect(changes).toEqual([]);
    const { note } = await announcing.createNote(PROJECT_ID, { body: 'peer note' });
    expect(changes.map(change => change.projectId)).toEqual([PROJECT_ID]);
    expect(changes[0].context.notes[0].body).toBe('peer note');

    await announcing.updateNote(PROJECT_ID, note.id, { body: 'peer edit' });
    await announcing.saveTodos(PROJECT_ID, [{ id: 't1', text: 'peer todo', completed: true, createdAt: 1 }]);
    expect(changes.map(change => change.projectId)).toEqual([PROJECT_ID, PROJECT_ID, PROJECT_ID]);
    expect(changes[1].context.notes[0].body).toBe('peer edit');
    expect(changes[2].context.todos[0].completed).toBe(true);

    await announcing.deleteNote(PROJECT_ID, note.id);
    expect(changes.at(-1).context.notes).toEqual([]);
    const count = changes.length;
    await announcing.deleteNote(PROJECT_ID, 'missing');
    await expect(announcing.createNote(PROJECT_ID, { body: ' ' })).rejects.toThrow('body is required');
    expect(changes).toHaveLength(count);
  });

  test('a failed atomic write does not announce or replace the last committed context', async () => {
    await runtime.createNote(PROJECT_ID, { body: 'kept' });
    const changes = [];
    const failing = createProjectContextRuntime({
      fsPromises: { ...fsPromises, rename: async () => { throw new Error('disk full'); } },
      path,
      projectsDirPath,
      onChanged: (projectId) => changes.push(projectId),
    });
    await expect(failing.saveTodos(PROJECT_ID, [{ id: 't1', text: 'not saved' }])).rejects.toThrow('disk full');
    expect(changes).toEqual([]);
    const context = await runtime.readContext(PROJECT_ID);
    expect(context.notes[0].body).toBe('kept');
    expect(context.todos).toEqual([]);
  });
});

describe('notes', () => {
  test('serializes conditional writers in both directions without stale writes or events', async () => {
    const changes = [];
    const announcing = createProjectContextRuntime({
      fsPromises, path, projectsDirPath, createId: () => `note-${++idCounter}`,
      onChanged: (id) => changes.push(id),
    });
    for (const [first, second] of [['agent', 'ui'], ['ui', 'agent']]) {
      const { note } = await announcing.createNote(PROJECT_ID, { body: 'original' });
      const peer = await announcing.createNote(PROJECT_ID, { body: 'peer' });
      await announcing.createTodo(PROJECT_ID, { text: 'peer todo' });
      changes.length = 0;
      const results = await Promise.allSettled([
        announcing.updateNote(PROJECT_ID, note.id, { body: first }, { expectedBody: note.body }),
        announcing.updateNote(PROJECT_ID, note.id, { body: second }, { expectedBody: note.body }),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
      expect(changes).toEqual([PROJECT_ID]);
      const committed = await fsPromises.readFile(contextPath(), 'utf8');
      await expect(announcing.updateNote(PROJECT_ID, note.id, { pinned: true }, { expectedBody: 'original' }))
        .rejects.toMatchObject({ status: 409 });
      expect(await fsPromises.readFile(contextPath(), 'utf8')).toBe(committed);
      expect(changes).toEqual([PROJECT_ID]);
      const current = await announcing.readContext(PROJECT_ID);
      expect(current.notes.find((entry) => entry.id === note.id).body).toBe(first);
      expect(current.notes.find((entry) => entry.id === peer.note.id)).toEqual(peer.note);
      expect(current.todos.some((todo) => todo.text === 'peer todo')).toBe(true);
    }
  });

  test('checks exact bodies and preserves matching, legacy, missing and invalid patch behavior', async () => {
    const { note } = await runtime.createNote(PROJECT_ID, { body: 'original' });
    await expect(runtime.updateNote(PROJECT_ID, note.id, { body: 'new' }, { expectedBody: ' original ' }))
      .rejects.toMatchObject({ status: 409 });
    for (const expectedBody of [null, 1, false, {}]) {
      await expect(runtime.updateNote(PROJECT_ID, note.id, { body: 'new' }, { expectedBody }))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(runtime.updateNote(PROJECT_ID, '', { body: 'new' }, { expectedBody: note.body }))
      .rejects.toThrow('noteId is required');
    await expect(runtime.updateNote(PROJECT_ID, note.id, {}, { expectedBody: note.body }))
      .rejects.toThrow('body or pinned is required');
    await expect(runtime.updateNote(PROJECT_ID, note.id, { body: ' ' }, { expectedBody: note.body }))
      .rejects.toThrow('body is required');
    expect(await runtime.updateNote(PROJECT_ID, 'gone', { body: 'new' }, { expectedBody: note.body })).toBeNull();
    const pinned = await runtime.updateNote(PROJECT_ID, note.id, { pinned: true }, { expectedBody: note.body });
    expect(pinned.note.updatedAt).toBe(note.updatedAt);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const same = await runtime.updateNote(PROJECT_ID, note.id, { body: note.body }, { expectedBody: note.body });
    expect(same.note.body).toBe(note.body);
    expect(same.note.updatedAt).toBeGreaterThan(note.updatedAt);
    expect(same.note.pinned).toBe(true);
    const clamped = await runtime.updateNote(PROJECT_ID, note.id, { body: 'x'.repeat(4000) }, { expectedBody: note.body });
    expect(clamped.note.body).toHaveLength(3000);
    expect((await runtime.updateNote(PROJECT_ID, note.id, { body: 'legacy' })).note.body).toBe('legacy');
  });

  test('conditional same-body writes announce but missing, malformed and failed writes do not', async () => {
    const changes = [];
    let failRename = false;
    const guarded = createProjectContextRuntime({
      fsPromises: { ...fsPromises, rename: async (...args) => {
        if (failRename) throw new Error('commit failed');
        return fsPromises.rename(...args);
      } },
      path, projectsDirPath, createId: () => 'n1', onChanged: (id) => changes.push(id),
    });
    const { note } = await guarded.createNote(PROJECT_ID, { body: 'keep' });
    changes.length = 0;
    await guarded.updateNote(PROJECT_ID, note.id, { body: 'keep' }, { expectedBody: 'keep' });
    expect(changes).toEqual([PROJECT_ID]);
    changes.length = 0;
    expect(await guarded.updateNote(PROJECT_ID, 'gone', { body: 'new' }, { expectedBody: 'keep' })).toBeNull();
    const committed = await fsPromises.readFile(contextPath(), 'utf8');
    failRename = true;
    await expect(guarded.updateNote(PROJECT_ID, note.id, { body: 'new' }, { expectedBody: 'keep' }))
      .rejects.toThrow('commit failed');
    expect(await fsPromises.readFile(contextPath(), 'utf8')).toBe(committed);
    await fsPromises.writeFile(contextPath(), '{ malformed', 'utf8');
    await expect(guarded.updateNote(PROJECT_ID, note.id, { body: 'new' }, { expectedBody: 'keep' }))
      .rejects.toThrow('malformed');
    expect(changes).toEqual([]);
  });

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
    // Where the file lives, so a comment on the plan can point an agent at it.
    expect(read.path).toBe(path.join(plansDir(), plan.file));
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

describe('shared plans', () => {
  let sharedDir;
  let sharedRuntime;

  beforeEach(async () => {
    sharedDir = path.join(projectsDirPath, 'repo', 'docs', 'plans');
    sharedRuntime = createProjectContextRuntime({
      fsPromises,
      path,
      projectsDirPath,
      createId: () => `plan-${++idCounter}`,
      resolveSharedPlansDir: async () => sharedDir,
    });
  });

  test('lists the shared folder\'s markdown files after the personal plans, marked shared, and reads them by file', async () => {
    await fsPromises.mkdir(sharedDir, { recursive: true });
    await fsPromises.writeFile(path.join(sharedDir, 'roadmap.md'), '# Roadmap\n\n- ship it\n');
    await fsPromises.writeFile(path.join(sharedDir, 'notes.txt'), 'not a plan');
    await fsPromises.writeFile(path.join(sharedDir, 'untitled.md'), 'first line only');
    const mine = await sharedRuntime.createPlan(PROJECT_ID, { title: 'Mine', body: 'x' });

    const context = await sharedRuntime.readContext(PROJECT_ID);
    expect(context.sharedPlansDir).toBe(sharedDir);
    expect(context.plans.map((plan) => `${plan.id}:${plan.source}`)).toEqual(expect.arrayContaining([
      `${mine.plan.id}:personal`, 'shared:roadmap.md:shared', 'shared:untitled.md:shared',
    ]));
    expect(context.plans[0].id).toBe(mine.plan.id);
    expect(context.plans.find((plan) => plan.id === 'shared:untitled.md').title).toBe('first line only');

    const read = await sharedRuntime.readPlan(PROJECT_ID, 'shared:roadmap.md');
    expect(read.title).toBe('Roadmap');
    expect(read.raw).toBe('# Roadmap\n\n- ship it\n');
    expect(read.path).toBe(path.join(sharedDir, 'roadmap.md'));
    expect(await sharedRuntime.readPlan(PROJECT_ID, 'shared:missing.md')).toBeNull();
    expect(await sharedRuntime.readPlan(PROJECT_ID, 'shared:../escape.md')).toBeNull();
  });

  test('a missing shared folder lists nothing; no folder configured lists nothing', async () => {
    expect((await sharedRuntime.readContext(PROJECT_ID)).plans).toEqual([]);
    expect((await runtime.readContext(PROJECT_ID)).sharedPlansDir).toBeNull();
  });

  test('updates and deletes a shared plan in place, verbatim', async () => {
    await fsPromises.mkdir(sharedDir, { recursive: true });
    await fsPromises.writeFile(path.join(sharedDir, 'a.md'), '# A\n');
    const updated = await sharedRuntime.updatePlan(PROJECT_ID, 'shared:a.md', { raw: '# Renamed\n\nbody\n' });
    expect(updated.plan.title).toBe('Renamed');
    expect(updated.plan.source).toBe('shared');
    expect(await fsPromises.readFile(path.join(sharedDir, 'a.md'), 'utf8')).toBe('# Renamed\n\nbody\n');
    expect(await sharedRuntime.updatePlan(PROJECT_ID, 'shared:gone.md', { raw: 'x' })).toBeNull();
    expect(await sharedRuntime.setPlanPinned(PROJECT_ID, 'shared:a.md', true)).toBeNull();

    const deleted = await sharedRuntime.deletePlan(PROJECT_ID, 'shared:a.md');
    expect(deleted.deleted).toBe(true);
    await expect(fsPromises.access(path.join(sharedDir, 'a.md'))).rejects.toThrow();
    expect((await sharedRuntime.deletePlan(PROJECT_ID, 'shared:a.md')).deleted).toBe(false);
  });

  test('announces shared plan updates and deletes, and stays quiet for missing files', async () => {
    const changes = [];
    const notifyingRuntime = createProjectContextRuntime({
      fsPromises,
      path,
      projectsDirPath,
      createId: () => `plan-${++idCounter}`,
      resolveSharedPlansDir: async () => sharedDir,
      onChanged: (projectId) => changes.push(projectId),
    });
    await fsPromises.mkdir(sharedDir, { recursive: true });
    await fsPromises.writeFile(path.join(sharedDir, 'a.md'), '# A\n');

    await notifyingRuntime.updatePlan(PROJECT_ID, 'shared:a.md', { raw: '# Renamed\n' });
    expect(changes).toEqual([PROJECT_ID]);
    await notifyingRuntime.deletePlan(PROJECT_ID, 'shared:a.md');
    expect(changes).toEqual([PROJECT_ID, PROJECT_ID]);

    await notifyingRuntime.updatePlan(PROJECT_ID, 'shared:a.md', { raw: 'x' });
    await notifyingRuntime.deletePlan(PROJECT_ID, 'shared:a.md');
    expect(changes).toEqual([PROJECT_ID, PROJECT_ID]);
  });

  test('share moves a personal plan into the shared folder and unshare brings it back, avoiding name collisions', async () => {
    const { plan } = await sharedRuntime.createPlan(PROJECT_ID, { title: 'Mine', body: 'body' });
    const shared = await sharedRuntime.sharePlan(PROJECT_ID, plan.id);
    // The id survives the move: a session that attached the plan still finds it.
    expect(shared.plan.id).toBe(plan.id);
    expect(shared.plan.source).toBe('shared');
    expect(shared.context.plans.map((entry) => `${entry.id}:${entry.source}`)).toEqual([`${plan.id}:shared`]);
    await expect(fsPromises.access(path.join(plansDir(), plan.file))).rejects.toThrow();
    expect(await fsPromises.readFile(path.join(sharedDir, plan.file), 'utf8')).toBe('# Mine\n\nbody');
    expect((await readJson(path.join(projectsDirPath, PROJECT_ID, 'context.json'))).plans[0]).toMatchObject({ id: plan.id, shared: true });
    const readMoved = await sharedRuntime.readPlan(PROJECT_ID, plan.id);
    expect(readMoved.source).toBe('shared');
    expect(readMoved.raw).toBe('# Mine\n\nbody');
    expect((await sharedRuntime.updatePlan(PROJECT_ID, plan.id, { raw: '# Mine v2\n' })).plan).toMatchObject({ id: plan.id, title: 'Mine v2', source: 'shared' });
    expect(await fsPromises.readFile(path.join(sharedDir, plan.file), 'utf8')).toBe('# Mine v2\n');

    // A personal file with the same name already exists: the returning plan gets a suffix, same id.
    await fsPromises.mkdir(plansDir(), { recursive: true });
    await fsPromises.writeFile(path.join(plansDir(), plan.file), 'squatter');
    const back = await sharedRuntime.unsharePlan(PROJECT_ID, plan.id);
    expect(back.plan.id).toBe(plan.id);
    expect(back.plan.source).toBe('personal');
    expect(back.plan.file).toBe(plan.file.replace(/\.md$/, '-1.md'));
    expect(back.plan.title).toBe('Mine v2');
    expect(back.context.plans.map((entry) => `${entry.id}:${entry.source}`)).toEqual([`${plan.id}:personal`]);
    await expect(fsPromises.access(path.join(sharedDir, plan.file))).rejects.toThrow();
    expect(await sharedRuntime.unsharePlan(PROJECT_ID, plan.id)).toBeNull();
    expect(await sharedRuntime.sharePlan(PROJECT_ID, 'nope')).toBeNull();

    // A plan that only ever lived in the team's folder gets an id of its own on the way in.
    await fsPromises.writeFile(path.join(sharedDir, 'foreign.md'), '# Foreign\n');
    const adopted = await sharedRuntime.unsharePlan(PROJECT_ID, 'shared:foreign.md');
    expect(adopted.plan.id).not.toMatch(/^shared:/);
    expect(adopted.plan.title).toBe('Foreign');
    expect(adopted.plan.source).toBe('personal');
  });

  test('share is refused without a shared plans folder', async () => {
    const { plan } = await runtime.createPlan(PROJECT_ID, { title: 'Mine', body: 'x' });
    await expect(runtime.sharePlan(PROJECT_ID, plan.id)).rejects.toThrow('shared plans folder is required');
    expect((await runtime.readContext(PROJECT_ID)).plans.map((entry) => entry.id)).toEqual([plan.id]);
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
