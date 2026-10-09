import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectRef } from '@/lib/projectContextApi';

interface NotePayload {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: 'manual' | 'selection' | 'agent';
  pinned: boolean;
}

interface ContextPayload {
  notes: NotePayload[];
  todos: { id: string; text: string; completed: boolean; createdAt: number }[];
  plans: { id: string; file: string; title: string; createdAt: number; pinned: boolean }[];
}

const emptyPayload = (): ContextPayload => ({ notes: [], todos: [], plans: [] });

const note = (overrides: Partial<NotePayload> = {}): NotePayload => ({
  id: 'n1',
  body: 'body',
  createdAt: 1,
  updatedAt: 1,
  source: 'manual',
  pinned: false,
  ...overrides,
});

const planLink = (overrides: Partial<ContextPayload['plans'][number]> = {}) => ({
  id: 'p1',
  file: 'a.md',
  title: 'A',
  createdAt: 1,
  pinned: false,
  ...overrides,
});

// The UI tsconfig does not load bun's test globals, so these tests follow the
// local precedent of swapping plain handlers instead of using mock helpers.
const handlers = {
  fetch: async (): Promise<ContextPayload> => emptyPayload(),
  saveTodos: async (todos: ContextPayload['todos'], expectedTodos?: ContextPayload['todos']): Promise<ContextPayload> => {
    void expectedTodos;
    return { notes: [], todos, plans: [] };
  },
  todo: async (method?: string, id?: string, patch?: { completed?: boolean; text?: string }): Promise<ContextPayload> => {
    void method;
    void id;
    void patch;
    return emptyPayload();
  },
  createTodo: async (): Promise<{ todo: ContextPayload['todos'][number]; context: ContextPayload }> => ({
    todo: { id: 'created', text: 'created', completed: false, createdAt: 1 },
    context: emptyPayload(),
  }),
  createNote: async (): Promise<{ note: NotePayload; context: ContextPayload }> => ({
    note: note(),
    context: { notes: [note()], todos: [], plans: [] },
  }),
  updateNote: async (body?: string, expectedBody?: string): Promise<NotePayload | null> => {
    void body;
    void expectedBody;
    return note();
  },
  deleteNote: async (): Promise<ContextPayload> => emptyPayload(),
  create: async (): Promise<{ plan: ContextPayload['plans'][number]; context: ContextPayload }> => ({
    plan: planLink(),
    context: { notes: [], todos: [], plans: [planLink()] },
  }),
  update: async (): Promise<{ plan: ContextPayload['plans'][number]; raw: string } | null> => ({
    plan: planLink(),
    raw: '# A',
  }),
  pinPlan: async (): Promise<ContextPayload['plans'][number] | null> => planLink({ pinned: true }),
  remove: async (): Promise<ContextPayload> => emptyPayload(),
};

const calls = { fetch: 0, saveTodos: 0, createNote: 0, updateNote: 0, deleteNote: 0, create: 0, update: 0, pinPlan: 0, remove: 0 };

mock.module('@/lib/projectContextApi', () => ({
  fetchProjectContext: () => {
    calls.fetch += 1;
    return handlers.fetch();
  },
  saveProjectTodos: (_project: ProjectRef, todos: ContextPayload['todos'], expectedTodos: ContextPayload['todos']) => {
    calls.saveTodos += 1;
    return handlers.saveTodos(todos, expectedTodos);
  },
  createProjectTodo: () => handlers.createTodo(),
  updateProjectTodo: (_project: ProjectRef, id: string, patch: { completed?: boolean; text?: string }) => handlers.todo('PATCH', id, patch),
  deleteProjectTodo: (_project: ProjectRef, id: string) => handlers.todo('DELETE', id),
  createProjectNote: () => {
    calls.createNote += 1;
    return handlers.createNote();
  },
  updateProjectNote: (_project: ProjectRef, _id: string, patch: { body?: string }, options?: { expectedBody?: string }) => {
    calls.updateNote += 1;
    return handlers.updateNote(patch.body, options?.expectedBody);
  },
  deleteProjectNote: () => {
    calls.deleteNote += 1;
    return handlers.deleteNote();
  },
  shareProjectPlan: async () => null,
  unshareProjectPlan: async () => null,
  setProjectPlanPinned: () => {
    calls.pinPlan += 1;
    return handlers.pinPlan();
  },
  createProjectPlan: () => {
    calls.create += 1;
    return handlers.create();
  },
  updateProjectPlan: () => {
    calls.update += 1;
    return handlers.update();
  },
  deleteProjectPlan: () => {
    calls.remove += 1;
    return handlers.remove();
  },
  resolveProjectContextId: (project: { path?: string } | null | undefined) => (
    project?.path ? `path_${project.path}` : ''
  ),
}));

const { useProjectContextStore } = await import('./useProjectContextStore');

const PROJECT = { id: 'ignored', path: '/repo' };
const store = () => useProjectContextStore.getState();
const entry = () => store().getEntry(PROJECT);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const failWith = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

beforeEach(() => {
  store().reset();
  calls.fetch = 0;
  calls.saveTodos = 0;
  calls.createNote = 0;
  calls.updateNote = 0;
  calls.deleteNote = 0;
  calls.create = 0;
  calls.update = 0;
  calls.pinPlan = 0;
  calls.remove = 0;

  handlers.fetch = async () => emptyPayload();
  handlers.saveTodos = async (todos) => ({ notes: [], todos, plans: [] });
  handlers.todo = async () => emptyPayload();
  handlers.createTodo = async () => ({ todo: { id: 'created', text: 'created', completed: false, createdAt: 1 }, context: emptyPayload() });
  handlers.createNote = async () => ({ note: note(), context: { notes: [note()], todos: [], plans: [] } });
  handlers.updateNote = async () => note();
  handlers.deleteNote = async () => emptyPayload();
  handlers.create = async () => ({ plan: planLink(), context: { notes: [], todos: [], plans: [planLink()] } });
  handlers.update = async () => ({ plan: planLink(), raw: '# A' });
  handlers.pinPlan = async () => planLink({ pinned: true });
  handlers.remove = async () => emptyPayload();
});

describe('getEntry', () => {
  test('returns a stable empty entry for an unknown project', () => {
    expect(entry()).toEqual({ notes: [], todos: [], plans: [], sharedPlansDir: null, loaded: false, loading: false, error: null });
  });

  test('returns the empty entry for a project without a path', () => {
    expect(store().getEntry({ id: 'x', path: '' }).loaded).toBe(false);
  });
});

describe('load', () => {
  test('populates from the server', async () => {
    handlers.fetch = async () => ({
      notes: [note({ body: 'server note' })],
      todos: [{ id: 't1', text: 'a', completed: false, createdAt: 1 }],
      plans: [planLink()],
    });

    await store().load(PROJECT);

    expect(entry().notes.map((entryNote) => entryNote.body)).toEqual(['server note']);
    expect(entry().todos).toHaveLength(1);
    expect(entry().plans).toHaveLength(1);
    expect(entry().loaded).toBe(true);
    expect(entry().error).toBeNull();
  });

  test('does not refetch once loaded', async () => {
    await store().load(PROJECT);
    await store().load(PROJECT);
    expect(calls.fetch).toBe(1);
  });

  test('refetches when forced', async () => {
    await store().load(PROJECT);
    await store().load(PROJECT, { force: true });
    expect(calls.fetch).toBe(2);
  });

  test('a failed load preserves previously loaded data instead of clearing it', async () => {
    handlers.fetch = async () => ({ notes: [note({ body: 'kept' })], todos: [], plans: [] });
    await store().load(PROJECT);

    handlers.fetch = failWith('offline');
    await store().load(PROJECT, { force: true });

    expect(entry().notes.map((entryNote) => entryNote.body)).toEqual(['kept']);
    expect(entry().loaded).toBe(true);
    expect(entry().error).toBe('offline');
  });

  test('a first-load failure reports the error and stays unloaded', async () => {
    handlers.fetch = failWith('boom');

    await store().load(PROJECT);

    expect(entry().loaded).toBe(false);
    expect(entry().notes).toEqual([]);
    expect(entry().error).toBe('boom');
  });

  test('concurrent loads issue a single request', async () => {
    await Promise.all([store().load(PROJECT), store().load(PROJECT), store().load(PROJECT)]);
    expect(calls.fetch).toBe(1);
  });

  test('coalesces refreshes requested during a load into one authoritative trailing read', async () => {
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => calls.fetch === 1
      ? gate.promise
      : Promise.resolve({ notes: [note({ body: 'peer change' })], todos: [], plans: [] });

    const initial = store().load(PROJECT);
    await Promise.resolve();
    const firstRefresh = store().load(PROJECT, { force: true });
    const secondRefresh = store().load(PROJECT, { force: true });
    gate.resolve(emptyPayload());
    await Promise.all([initial, firstRefresh, secondRefresh]);

    expect(entry().notes.map((item) => item.body)).toEqual(['peer change']);
    expect(calls.fetch).toBe(2);
  });

  test('a refresh cannot undo a local write that completed after the read began', async () => {
    handlers.fetch = async () => ({ notes: [note()], todos: [], plans: [] });
    await store().load(PROJECT);
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => gate.promise;
    const refresh = store().load(PROJECT, { force: true });
    await Promise.resolve();
    handlers.updateNote = async () => note({ body: 'new local body', updatedAt: 2 });
    await store().saveNoteBody(PROJECT, 'n1', 'new local body');
    gate.resolve({ notes: [note()], todos: [], plans: [] });
    await refresh;

    expect(entry().notes[0].body).toBe('new local body');
  });

  test('a peer change during a local note save is read after that save settles', async () => {
    handlers.fetch = async () => ({ notes: [note()], todos: [], plans: [] });
    await store().load(PROJECT);
    const gate = deferred<NotePayload | null>();
    handlers.updateNote = () => gate.promise;
    const saving = store().saveNoteBody(PROJECT, 'n1', 'local edit');
    handlers.fetch = async () => ({
      notes: [note({ body: 'local edit' }), note({ id: 'peer', body: 'peer note' })],
      todos: [],
      plans: [],
    });
    const refresh = store().load(PROJECT, { force: true });
    await Promise.resolve();
    gate.resolve(note({ body: 'local edit' }));
    await Promise.all([saving, refresh]);

    expect(entry().notes.map((item) => item.body)).toEqual(['local edit', 'peer note']);
  });

  for (const failureOrder of ['before the read', 'after the read']) {
    test(`a local write failing ${failureOrder} cannot hide the peer snapshot`, async () => {
      handlers.fetch = async () => ({ notes: [note()], todos: [], plans: [] });
      await store().load(PROJECT);
      const reading = deferred<ContextPayload>();
      handlers.fetch = () => reading.promise;
      const refresh = store().load(PROJECT, { force: true });
      await Promise.resolve();
      const writing = deferred<NotePayload | null>();
      handlers.updateNote = () => writing.promise;
      const saving = store().saveNoteBody(PROJECT, 'n1', 'rejected local edit');
      await Promise.resolve();
      const peer = { notes: [note(), note({ id: 'peer', body: 'peer note' })], todos: [], plans: [] };
      handlers.fetch = async () => peer;
      if (failureOrder === 'after the read') {
        reading.resolve(peer);
        await Promise.resolve();
        await Promise.resolve();
      }
      writing.reject(new Error('save failed'));
      expect(await saving).toBe(false);
      if (failureOrder === 'before the read') reading.resolve(peer);
      await refresh;

      expect(entry().notes.map((item) => item.body)).toEqual(['body', 'peer note']);
    });
  }

  test('reset rejects an old runtime read even when the project id is reused', async () => {
    const gate = deferred<ContextPayload>();
    handlers.fetch = () => gate.promise;
    const obsolete = store().load(PROJECT);
    await Promise.resolve();
    store().reset();
    handlers.fetch = async () => ({ notes: [note({ body: 'new runtime' })], todos: [], plans: [] });
    await store().load(PROJECT);
    gate.resolve({ notes: [note({ body: 'old runtime' })], todos: [], plans: [] });
    await obsolete;

    expect(entry().notes[0].body).toBe('new runtime');
  });
});

describe('saveTodos', () => {
  beforeEach(async () => { await store().load(PROJECT); });

  test('uses the rendered snapshot even after a newer confirmed load', async () => {
    const rendered = entry().todos;
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [{ id: 'peer', text: 'peer', completed: false, createdAt: 1 }] });
    await store().load(PROJECT, { force: true });
    let supplied: ContextPayload['todos'] | undefined;
    handlers.saveTodos = async (_todos, expectedTodos) => {
      void _todos;
      supplied = expectedTodos;
      throw new Error('Todos changed');
    };
    expect(await store().saveTodos(PROJECT, [], rendered)).toBe(false);
    expect(supplied).toEqual([]);
    expect(entry().todos.map(todo => todo.id)).toEqual(['peer']);
  });

  test('keeps the confirmed list until the request resolves', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;

    const pending = store().saveTodos(PROJECT, [{ id: 't1', text: 'typed', completed: false, createdAt: 1 }]);
    expect(entry().todos).toHaveLength(0);

    gate.resolve({ notes: [], todos: [{ id: 't1', text: 'typed', completed: false, createdAt: 1 }], plans: [] });
    expect(await pending).toBe(true);
    expect(entry().todos).toHaveLength(1);
  });

  test('rolls back and reports the error on failure', async () => {
    await store().saveTodos(PROJECT, [{ id: 't1', text: 'original', completed: false, createdAt: 1 }]);
    handlers.saveTodos = failWith('disk full');

    expect(await store().saveTodos(PROJECT, [])).toBe(false);
    expect(entry().todos.map((todo) => todo.text)).toEqual(['original']);
    expect(entry().error).toBe('disk full');
  });

  test('serializes concurrent writes in call order', async () => {
    const order: string[] = [];
    handlers.saveTodos = async (todos) => {
      const label = todos[0]?.text ?? 'empty';
      order.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${label}`);
      return { notes: [], todos, plans: [] };
    };

    await Promise.all([
      store().saveTodos(PROJECT, [{ id: '1', text: 'first', completed: false, createdAt: 1 }]),
      store().saveTodos(PROJECT, [{ id: '2', text: 'second', completed: false, createdAt: 2 }]),
    ]);

    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  test('a load resolving during an in-flight write does not clobber it', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;
    handlers.fetch = async () => ({
      notes: [note({ body: 'from server' })],
      todos: [{ id: 'stale', text: 'stale', completed: false, createdAt: 0 }],
      plans: [],
    });

    const pending = store().saveTodos(PROJECT, [{ id: 'local', text: 'local', completed: false, createdAt: 1 }]);
    await store().load(PROJECT, { force: false });

    expect(entry().todos).toEqual([]);

    gate.resolve({ notes: [], todos: [{ id: 'local', text: 'local', completed: false, createdAt: 1 }], plans: [] });
    await pending;
  });

  test('ignores a project without a resolvable path', async () => {
    expect(await store().saveTodos({ id: 'x', path: '' }, [])).toBe(false);
    expect(calls.saveTodos).toBe(0);
  });
});

describe('item todos', () => {
  const item = (id: string, completed = false) => ({ id, text: id, completed, createdAt: 1 });

  test('completion and reopen project the original ordering before responses', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [item('a'), item('b'), item('c', true)] });
    await store().load(PROJECT);
    const completing = deferred<ContextPayload>();
    const reopening = deferred<ContextPayload>();
    handlers.todo = (_method, _id, patch) => patch?.completed ? completing.promise : reopening.promise;
    const complete = store().updateTodo(PROJECT, 'a', { completed: true });
    expect(entry().todos.map(todo => todo.id)).toEqual(['b', 'c', 'a']);
    const reopen = store().updateTodo(PROJECT, 'a', { completed: false });
    expect(entry().todos.map(todo => todo.id)).toEqual(['b', 'a', 'c']);
    completing.resolve({ ...emptyPayload(), todos: [item('b'), item('peer'), item('c', true), item('a', true)] });
    expect(await complete).toBe(true);
    expect(entry().todos.map(todo => todo.id)).toEqual(['b', 'peer', 'a', 'c']);
    reopening.resolve({ ...emptyPayload(), todos: [item('b'), item('peer'), item('a'), item('c', true)] });
    expect(await reopen).toBe(true);
  });

  test('failed completion removes only its shadow and keeps a later deletion', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [item('a'), item('b')] });
    await store().load(PROJECT);
    const completing = deferred<ContextPayload>();
    const deleting = deferred<ContextPayload>();
    handlers.todo = method => method === 'PATCH' ? completing.promise : deleting.promise;
    const complete = store().updateTodo(PROJECT, 'a', { completed: true });
    const remove = store().deleteTodo(PROJECT, 'b');
    expect(entry().todos).toEqual([item('a', true)]);
    completing.reject(new Error('Write rejected'));
    expect(await complete).toBe(false);
    expect(entry().todos).toEqual([item('a')]);
    deleting.resolve({ ...emptyPayload(), todos: [item('a'), item('peer')] });
    expect(await remove).toBe(true);
    expect(entry().todos).toEqual([item('a'), item('peer')]);
  });

  test('failed deletion preserves a peer addition from the previous committed response', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [item('a'), item('b')] });
    await store().load(PROJECT);
    const completing = deferred<ContextPayload>();
    const deleting = deferred<ContextPayload>();
    handlers.todo = method => method === 'PATCH' ? completing.promise : deleting.promise;
    const complete = store().updateTodo(PROJECT, 'a', { completed: true });
    const remove = store().deleteTodo(PROJECT, 'b');
    completing.resolve({ ...emptyPayload(), todos: [item('b'), item('peer'), item('a', true)] });
    expect(await complete).toBe(true);
    expect(entry().todos.map(todo => todo.id)).toEqual(['peer', 'a']);
    deleting.reject(new Error('Write rejected'));
    expect(await remove).toBe(false);
    expect(entry().todos.map(todo => todo.id)).toEqual(['b', 'peer', 'a']);
  });

  test('adopts peer items in the committed response to an ordinary edit', async () => {
    handlers.todo = async () => ({ notes: [], plans: [], todos: [
      { id: 'local', text: 'local', completed: true, createdAt: 1 },
      { id: 'peer', text: 'peer', completed: false, createdAt: 2 },
    ] });
    expect(await store().updateTodo(PROJECT, 'local', { completed: true })).toBe(true);
    expect(entry().todos.map((todo) => todo.id)).toEqual(['local', 'peer']);
  });

  test('failed item writes preserve the last confirmed list', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [{ id: 'kept', text: 'kept', completed: false, createdAt: 1 }] });
    await store().load(PROJECT);
    handlers.todo = failWith('missing todo');
    expect(await store().deleteTodo(PROJECT, 'kept')).toBe(false);
    expect(entry().todos.map((todo) => todo.id)).toEqual(['kept']);
    expect(entry().error).toBe('missing todo');
  });

  test('reset rejects an old runtime item response', async () => {
    const gate = deferred<Awaited<ReturnType<typeof handlers.createTodo>>>();
    handlers.createTodo = () => gate.promise;
    const pending = store().createTodo(PROJECT, 'old');
    await Promise.resolve();
    store().reset();
    await store().load(PROJECT);
    gate.resolve({ todo: item('old'), context: { ...emptyPayload(), todos: [item('old')] } });
    expect(await pending).toBe(false);
    expect(entry().todos).toEqual([]);
  });

  test('optimistic create reconciles queued edits and deletes by the explicit ID', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [item('finished', true)] });
    await store().load(PROJECT);
    const creating = deferred<Awaited<ReturnType<typeof handlers.createTodo>>>();
    const updating = deferred<ContextPayload>();
    const deleting = deferred<ContextPayload>();
    handlers.createTodo = () => creating.promise;
    const targets: string[] = [];
    handlers.todo = (method, id) => {
      targets.push(`${method}:${id}`);
      return method === 'PATCH' ? updating.promise : deleting.promise;
    };
    const create = store().createTodo(PROJECT, 'same text');
    const temporaryId = entry().todos[0].id;
    expect(temporaryId.startsWith('pending:')).toBe(true);
    expect(entry().todos.map(todo => todo.text)).toEqual(['same text', 'finished']);
    const update = store().updateTodo(PROJECT, temporaryId, { completed: true });
    const remove = store().deleteTodo(PROJECT, temporaryId);
    expect(entry().todos.map(todo => todo.id)).toEqual(['finished']);
    const created = { ...item('local-id'), text: 'same text', createdAt: 50 };
    const peer = { ...item('peer-id'), text: 'same text', createdAt: 50 };
    creating.resolve({ todo: created, context: { ...emptyPayload(), todos: [peer, created, item('finished', true)] } });
    expect(await create).toBe(true);
    expect(entry().todos.map(todo => todo.id)).toEqual(['peer-id', 'finished']);
    updating.resolve({ ...emptyPayload(), todos: [peer, item('finished', true), { ...created, completed: true }] });
    expect(await update).toBe(true);
    deleting.resolve({ ...emptyPayload(), todos: [peer, item('finished', true)] });
    expect(await remove).toBe(true);
    expect(targets).toEqual(['PATCH:local-id', 'DELETE:local-id']);
  });

  test('failed create drops its row and never sends queued temporary IDs', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [item('peer')] });
    await store().load(PROJECT);
    const creating = deferred<Awaited<ReturnType<typeof handlers.createTodo>>>();
    handlers.createTodo = () => creating.promise;
    let requests = 0;
    handlers.todo = async () => { requests += 1; return emptyPayload(); };
    const create = store().createTodo(PROJECT, 'local');
    const temporaryId = entry().todos[1].id;
    const remove = store().deleteTodo(PROJECT, temporaryId);
    creating.reject(new Error('Write rejected'));
    expect(await create).toBe(false);
    expect(await remove).toBe(false);
    expect(entry().todos).toEqual([item('peer')]);
    expect(requests).toBe(0);
  });

  test('an initial authoritative load survives a later failed optimistic creation', async () => {
    const reading = deferred<ContextPayload>();
    const creating = deferred<Awaited<ReturnType<typeof handlers.createTodo>>>();
    handlers.fetch = () => reading.promise;
    handlers.createTodo = () => creating.promise;
    const load = store().load(PROJECT);
    const create = store().createTodo(PROJECT, 'local');
    await Promise.resolve();
    reading.resolve({ ...emptyPayload(), todos: [item('peer')] });
    await load;
    expect(entry().todos.map(todo => todo.text)).toEqual(['peer', 'local']);
    creating.reject(new Error('Write rejected'));
    expect(await create).toBe(false);
    expect(entry().todos).toEqual([item('peer')]);
  });

  test('a failed optimistic creation cannot establish a bulk-write baseline', async () => {
    handlers.createTodo = failWith('Write rejected');
    expect(await store().createTodo(PROJECT, 'local')).toBe(false);
    expect(await store().saveTodos(PROJECT, [])).toBe(false);
    expect(calls.saveTodos).toBe(0);
  });

  test('bulk queued behind creation sends reconciled confirmed IDs and timestamps', async () => {
    await store().load(PROJECT);
    const creating = deferred<Awaited<ReturnType<typeof handlers.createTodo>>>();
    handlers.createTodo = () => creating.promise;
    const create = store().createTodo(PROJECT, 'local');
    const rendered = entry().todos;
    let expected: ContextPayload['todos'] | undefined;
    handlers.saveTodos = async (todos, expectedTodos) => { expected = expectedTodos; return { ...emptyPayload(), todos }; };
    const bulk = store().saveTodos(PROJECT, rendered, rendered);
    const created = { createdAt: 99, completed: false, text: 'local', id: 'authoritative' };
    creating.resolve({ todo: created, context: { ...emptyPayload(), todos: [created] } });
    expect(await create).toBe(true);
    expect(await bulk).toBe(true);
    expect(expected).toEqual([created]);
    expect(entry().todos).toEqual([created]);
  });

  test('bulk queued behind an item rejects an unread peer without sending a replacement', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), todos: [item('a')] });
    await store().load(PROJECT);
    const completing = deferred<ContextPayload>();
    handlers.todo = () => completing.promise;
    const complete = store().updateTodo(PROJECT, 'a', { completed: true });
    const rendered = entry().todos;
    const clear = store().saveTodos(PROJECT, [], rendered);
    completing.resolve({ ...emptyPayload(), todos: [item('peer'), item('a', true)] });
    expect(await complete).toBe(true);
    expect(await clear).toBe(false);
    expect(calls.saveTodos).toBe(0);
    expect(entry().todos.map(todo => todo.id)).toEqual(['peer', 'a']);
  });
});

describe('notes', () => {
  for (const operation of ['pin', 'delete'] as const) {
    test(`failed ${operation} keeps a body committed after optimistic admission`, async () => {
      handlers.fetch = async () => ({ ...emptyPayload(), notes: [note(), note({ id: 'peer', body: 'Peer body' })] });
      await store().load(PROJECT);
      const body = deferred<NotePayload | null>();
      const pin = deferred<NotePayload | null>();
      const deletion = deferred<ContextPayload>();
      handlers.updateNote = value => value === 'Saved body' ? body.promise : pin.promise;
      handlers.deleteNote = () => deletion.promise;
      const saving = store().saveNoteBody(PROJECT, 'n1', 'Saved body', 'body');
      const changing = operation === 'pin'
        ? store().setNotePinned(PROJECT, 'n1', true)
        : store().deleteNote(PROJECT, 'n1');
      expect(entry().notes.find(item => item.id === 'n1')?.body).toBe(operation === 'pin' ? 'body' : undefined);
      body.resolve(note({ body: 'Saved body', updatedAt: 5 }));
      expect(await saving).toBe(true);
      expect(entry().notes.find(item => item.id === 'n1')?.body).toBe(operation === 'pin' ? 'Saved body' : undefined);
      if (operation === 'pin') pin.reject(new Error('Pin rejected'));
      else deletion.reject(new Error('Delete rejected'));
      expect(await changing).toBe(false);
      expect(entry().notes).toEqual([note({ body: 'Saved body', updatedAt: 5 }), note({ id: 'peer', body: 'Peer body' })]);
    });
  }

  test('body success never publishes a pending-deleted row, and later failures cannot resurrect it', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), notes: [note(), note({ id: 'peer' })] });
    await store().load(PROJECT);
    const body = deferred<NotePayload | null>();
    const deletion = deferred<ContextPayload>();
    handlers.updateNote = value => value ? body.promise : Promise.reject(new Error('Pin rejected'));
    handlers.deleteNote = () => deletion.promise;
    const saving = store().saveNoteBody(PROJECT, 'n1', 'Saved body');
    const removing = store().deleteNote(PROJECT, 'n1');
    const visible: string[][] = [];
    const unsubscribe = useProjectContextStore.subscribe(state => visible.push(state.getEntry(PROJECT).notes.map(item => item.id)));
    try {
      body.resolve(note({ body: 'Saved body' }));
      expect(await saving).toBe(true);
      deletion.resolve({ ...emptyPayload(), notes: [note({ id: 'peer' }), note({ id: 'unread' })] });
      expect(await removing).toBe(true);
      expect(await store().setNotePinned(PROJECT, 'n1', true)).toBe(false);
      handlers.deleteNote = failWith('Delete rejected');
      expect(await store().deleteNote(PROJECT, 'n1')).toBe(false);
      expect(visible.every(ids => !ids.includes('n1'))).toBe(true);
      expect(entry().notes.map(item => item.id)).toEqual(['peer', 'unread']);
    } finally {
      unsubscribe();
    }
  });

  test('failed deletion keeps peer notes from an earlier queued creation and a later deletion hidden', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), notes: [note(), note({ id: 'other' })] });
    await store().load(PROJECT);
    const creation = deferred<Awaited<ReturnType<typeof handlers.createNote>>>();
    const first = deferred<ContextPayload>();
    const later = deferred<ContextPayload>();
    handlers.createNote = () => creation.promise;
    handlers.deleteNote = () => calls.deleteNote === 1 ? first.promise : later.promise;
    const creating = store().createNote(PROJECT, { body: 'Peer body' });
    const deleting = store().deleteNote(PROJECT, 'n1');
    const deletingOther = store().deleteNote(PROJECT, 'other');
    const peer = note({ id: 'peer', body: 'Peer body' });
    creation.resolve({ note: peer, context: { ...emptyPayload(), notes: [note(), note({ id: 'other' }), peer] } });
    await creating;
    expect(entry().notes.map(item => item.id)).toEqual(['peer']);
    first.reject(new Error('Delete rejected'));
    expect(await deleting).toBe(false);
    expect(entry().notes.map(item => item.id)).toEqual(['n1', 'peer']);
    later.resolve({ ...emptyPayload(), notes: [note(), peer] });
    expect(await deletingOther).toBe(true);
  });

  test('a failed later pin returns to the earlier committed flag', async () => {
    await store().createNote(PROJECT, { body: 'body' });
    const first = deferred<NotePayload | null>();
    const later = deferred<NotePayload | null>();
    handlers.updateNote = () => calls.updateNote === 1 ? first.promise : later.promise;
    const pinning = store().setNotePinned(PROJECT, 'n1', true);
    const unpinning = store().setNotePinned(PROJECT, 'n1', false);
    expect(entry().notes[0].pinned).toBe(false);
    first.resolve(note({ pinned: true, body: 'Committed body' }));
    expect(await pinning).toBe(true);
    expect(entry().notes[0].pinned).toBe(false);
    later.reject(new Error('Pin rejected'));
    expect(await unpinning).toBe(false);
    expect(entry().notes[0]).toEqual(note({ pinned: true, body: 'Committed body' }));
  });

  test('a missing body response followed by a failed delete leaves the entity absent', async () => {
    await store().createNote(PROJECT, { body: 'body' });
    const body = deferred<NotePayload | null>();
    handlers.updateNote = () => body.promise;
    handlers.deleteNote = failWith('Delete rejected');
    const saving = store().saveNoteBody(PROJECT, 'n1', 'Saved body');
    const deleting = store().deleteNote(PROJECT, 'n1');
    body.resolve(null);
    expect(await saving).toBe(false);
    expect(await deleting).toBe(false);
    expect(entry().notes).toEqual([]);
  });

  for (const operation of ['pin', 'delete'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`reset rejects in-flight ${operation} ${outcome} and its queued follower`, async () => {
        handlers.fetch = async () => ({ ...emptyPayload(), notes: [note()] });
        await store().load(PROJECT);
        const pin = deferred<NotePayload | null>();
        const deletion = deferred<ContextPayload>();
        handlers.updateNote = () => pin.promise;
        handlers.deleteNote = () => deletion.promise;
        const changing = operation === 'pin' ? store().setNotePinned(PROJECT, 'n1', true) : store().deleteNote(PROJECT, 'n1');
        await Promise.resolve();
        const follower = store().setNotePinned(PROJECT, 'n1', false);
        store().reset();
        handlers.fetch = async () => ({ ...emptyPayload(), notes: [note({ body: 'New runtime' })] });
        await store().load(PROJECT);
        if (outcome === 'failure') {
          if (operation === 'pin') pin.reject(new Error('Old failure'));
          else deletion.reject(new Error('Old failure'));
        } else if (operation === 'pin') pin.resolve(note({ body: 'Old runtime', pinned: true }));
        else deletion.resolve(emptyPayload());
        expect(await changing).toBe(false);
        expect(await follower).toBe(false);
        expect(entry().notes).toEqual([note({ body: 'New runtime' })]);
        expect(entry().error).toBeNull();
        expect(calls.updateNote).toBe(operation === 'pin' ? 1 : 0);
      });
    }
  }

  test('createNote adopts the committed list', async () => {
    handlers.createNote = async () => ({
      note: note({ id: 'n9', body: 'fresh' }),
      context: { notes: [note({ id: 'n9', body: 'fresh' })], todos: [], plans: [] },
    });

    const created = await store().createNote(PROJECT, { body: 'fresh' });
    expect(created?.id).toBe('n9');
    expect(entry().notes.map((entryNote) => entryNote.id)).toEqual(['n9']);
  });

  test('createNote refuses a whitespace-only body without calling the server', async () => {
    expect(await store().createNote(PROJECT, { body: '   ' })).toBeNull();
    expect(calls.createNote).toBe(0);
  });

  test('createNote reports failure without inserting a placeholder row', async () => {
    handlers.createNote = failWith('no space');

    expect(await store().createNote(PROJECT, { body: 'x' })).toBeNull();
    expect(entry().notes).toEqual([]);
    expect(entry().error).toBe('no space');
  });

  test('saveNoteBody commits the server copy', async () => {
    await store().createNote(PROJECT, { body: 'before' });
    handlers.updateNote = async () => note({ body: 'after', updatedAt: 9 });

    expect(await store().saveNoteBody(PROJECT, 'n1', 'after')).toBe(true);
    expect(entry().notes[0].body).toBe('after');
    expect(entry().notes[0].updatedAt).toBe(9);
  });

  test('saveNoteBody rolls back on failure', async () => {
    await store().createNote(PROJECT, { body: 'before' });
    handlers.updateNote = failWith('read only');

    expect(await store().saveNoteBody(PROJECT, 'n1', 'after')).toBe(false);
    expect(entry().notes[0].body).toBe('body');
    expect(entry().error).toBe('read only');
  });

  test('a conflict sends the editor baseline and keeps confirmed peer notes', async () => {
    handlers.fetch = async () => ({ ...emptyPayload(), notes: [note({ body: 'Peer body' }), note({ id: 'peer' })] });
    await store().load(PROJECT);
    const requests: Array<{ body?: string; expectedBody?: string }> = [];
    handlers.updateNote = async (body, expectedBody) => {
      requests.push({ body, expectedBody });
      throw new Error('Note changed');
    };
    expect(await store().saveNoteBody(PROJECT, 'n1', 'Dirty draft', 'Old body')).toBe(false);
    expect(requests).toEqual([{ body: 'Dirty draft', expectedBody: 'Old body' }]);
    expect(entry().notes.map(item => item.body)).toEqual(['Peer body', 'body']);
  });

  test('a failed queued text save cannot roll back an earlier success', async () => {
    await store().createNote(PROJECT, { body: 'before' });
    const gate = deferred<NotePayload | null>();
    handlers.updateNote = body => body === 'first' ? gate.promise : Promise.reject(new Error('Note changed'));
    const first = store().saveNoteBody(PROJECT, 'n1', 'first', 'body');
    const later = store().saveNoteBody(PROJECT, 'n1', 'later', 'body');
    gate.resolve(note({ body: 'first' }));
    expect(await first).toBe(true);
    expect(await later).toBe(false);
    expect(entry().notes[0].body).toBe('first');
  });

  test('saveNoteBody drops a note the server reports as gone', async () => {
    await store().createNote(PROJECT, { body: 'before' });
    handlers.updateNote = async () => null;

    expect(await store().saveNoteBody(PROJECT, 'n1', 'after')).toBe(false);
    expect(entry().notes).toEqual([]);
  });

  test('setNotePinned applies optimistically', async () => {
    await store().createNote(PROJECT, { body: 'x' });
    const gate = deferred<NotePayload | null>();
    handlers.updateNote = () => gate.promise;

    const pending = store().setNotePinned(PROJECT, 'n1', true);
    expect(entry().notes[0].pinned).toBe(true);

    gate.resolve(note({ pinned: true }));
    expect(await pending).toBe(true);
  });

  test('setNotePinned rolls back on failure', async () => {
    await store().createNote(PROJECT, { body: 'x' });
    handlers.updateNote = failWith('locked');

    expect(await store().setNotePinned(PROJECT, 'n1', true)).toBe(false);
    expect(entry().notes[0].pinned).toBe(false);
  });

  test('deleteNote removes optimistically and restores on failure', async () => {
    await store().createNote(PROJECT, { body: 'x' });
    handlers.deleteNote = failWith('busy');

    expect(await store().deleteNote(PROJECT, 'n1')).toBe(false);
    expect(entry().notes.map((entryNote) => entryNote.id)).toEqual(['n1']);
    expect(entry().error).toBe('busy');
  });

  test('deleteNote commits the server list on success', async () => {
    await store().createNote(PROJECT, { body: 'x' });

    expect(await store().deleteNote(PROJECT, 'n1')).toBe(true);
    expect(entry().notes).toEqual([]);
  });
});

describe('plans', () => {
  test('createPlan commits the server context', async () => {
    const plan = await store().createPlan(PROJECT, { title: 'A', body: 'x' });

    expect(plan?.id).toBe('p1');
    expect(entry().plans.map((item) => item.id)).toEqual(['p1']);
  });

  test('createPlan reports failure without inserting a placeholder row', async () => {
    handlers.create = failWith('no space');

    expect(await store().createPlan(PROJECT, { title: 'A', body: 'x' })).toBeNull();
    expect(entry().plans).toEqual([]);
    expect(entry().error).toBe('no space');
  });

  test('deletePlan removes optimistically', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });

    const gate = deferred<ContextPayload>();
    handlers.remove = () => gate.promise;

    const pending = store().deletePlan(PROJECT, 'p1');
    expect(entry().plans).toEqual([]);

    gate.resolve(emptyPayload());
    expect(await pending).toBe(true);
  });

  test('savePlan folds the refreshed title back into the list', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.update = async () => ({ plan: planLink({ title: 'Renamed' }), raw: '# Renamed' });

    expect(await store().savePlan(PROJECT, 'p1', '# Renamed')).toBe(true);
    expect(entry().plans[0].title).toBe('Renamed');
  });

  test('savePlan drops a plan the server reports as gone', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.update = async () => null;

    expect(await store().savePlan(PROJECT, 'p1', '# X')).toBe(false);
    expect(entry().plans).toEqual([]);
  });

  test('savePlan keeps the row and reports the error when the request fails', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.update = failWith('read only');

    expect(await store().savePlan(PROJECT, 'p1', '# X')).toBe(false);
    expect(entry().plans.map((item) => item.id)).toEqual(['p1']);
    expect(entry().error).toBe('read only');
  });

  test('setPlanPinned applies optimistically and rolls back on failure', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.pinPlan = failWith('locked');

    expect(await store().setPlanPinned(PROJECT, 'p1', true)).toBe(false);
    expect(entry().plans[0].pinned).toBe(false);
    expect(entry().error).toBe('locked');
  });

  test('setPlanPinned commits the server copy', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });

    expect(await store().setPlanPinned(PROJECT, 'p1', true)).toBe(true);
    expect(entry().plans[0].pinned).toBe(true);
  });

  test('deletePlan restores the row when the request fails', async () => {
    await store().createPlan(PROJECT, { title: 'A', body: 'x' });
    handlers.remove = failWith('locked');

    expect(await store().deletePlan(PROJECT, 'p1')).toBe(false);
    expect(entry().plans.map((item) => item.id)).toEqual(['p1']);
    expect(entry().error).toBe('locked');
  });
});

describe('reset', () => {
  test('drops every cached project', async () => {
    await store().load(PROJECT);
    expect(entry().loaded).toBe(true);

    store().reset();
    expect(entry().loaded).toBe(false);
  });
});
