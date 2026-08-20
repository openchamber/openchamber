import { beforeEach, describe, expect, mock, test } from 'bun:test';

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
  saveTodos: async (todos: ContextPayload['todos']): Promise<ContextPayload> => ({
    notes: [],
    todos,
    plans: [],
  }),
  createNote: async (): Promise<{ note: NotePayload; context: ContextPayload }> => ({
    note: note(),
    context: { notes: [note()], todos: [], plans: [] },
  }),
  updateNote: async (): Promise<NotePayload | null> => note(),
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
  saveProjectTodos: (_project: unknown, todos: ContextPayload['todos']) => {
    calls.saveTodos += 1;
    return handlers.saveTodos(todos);
  },
  createProjectNote: () => {
    calls.createNote += 1;
    return handlers.createNote();
  },
  updateProjectNote: () => {
    calls.updateNote += 1;
    return handlers.updateNote();
  },
  deleteProjectNote: () => {
    calls.deleteNote += 1;
    return handlers.deleteNote();
  },
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
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
    expect(entry()).toEqual({ notes: [], todos: [], plans: [], loaded: false, loading: false, error: null });
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
});

describe('saveTodos', () => {
  test('applies optimistically before the request resolves', async () => {
    const gate = deferred<ContextPayload>();
    handlers.saveTodos = () => gate.promise;

    const pending = store().saveTodos(PROJECT, [{ id: 't1', text: 'typed', completed: false, createdAt: 1 }]);
    expect(entry().todos).toHaveLength(1);

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
    await store().load(PROJECT);

    expect(entry().todos.map((todo) => todo.id)).toEqual(['local']);
    // The same snapshot still delivers the fields the write did not touch.
    expect(entry().notes.map((entryNote) => entryNote.body)).toEqual(['from server']);

    gate.resolve({ notes: [], todos: [{ id: 'local', text: 'local', completed: false, createdAt: 1 }], plans: [] });
    await pending;
  });

  test('ignores a project without a resolvable path', async () => {
    expect(await store().saveTodos({ id: 'x', path: '' }, [])).toBe(false);
    expect(calls.saveTodos).toBe(0);
  });
});

describe('notes', () => {
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

  test('saveNoteBody applies optimistically and commits the server copy', async () => {
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
