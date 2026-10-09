import { describe, expect, it, vi } from 'vitest';
import { createOpenChamberControlService } from './service.js';
import { OpenChamberControlError } from './error.js';
import { createKnowledgeOwnerResolver } from './knowledge-owner.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

const setup = (overrides = {}) => {
  const context = { notes: [{ id: 'note-1', body: 'Note' }], todos: [{ id: 'todo-1', text: 'Task', completed: false }], plans: [{ id: 'plan-1', title: 'Plan' }] };
  const runtime = {
    readContext: vi.fn(async () => context),
    createNote: vi.fn(async (projectId, note) => ({ note: { id: 'note-2', ...note }, context })),
    updateNote: vi.fn(async () => ({ note: context.notes[0], context })),
    deleteNote: vi.fn(async () => ({ deleted: true, context })),
    createTodo: vi.fn(async () => context),
    updateTodo: vi.fn(async () => context),
    deleteTodo: vi.fn(async () => context),
    readPlan: vi.fn(async () => ({ ...context.plans[0], raw: '# Plan\n' })),
    createPlan: vi.fn(async () => ({ plan: context.plans[0], context })),
    updatePlan: vi.fn(async () => ({ plan: context.plans[0], context })),
    deletePlan: vi.fn(async () => ({ deleted: true, context })),
  };
  const resolveProjectContextId = createKnowledgeOwnerResolver({
    listProjectPaths: async () => ['/repo', '/registered-worktree'],
    getWorktrees: async () => [{ path: '/worktree' }],
    resolvePrimaryWorktreeRoot: async () => ({ root: '/repo' }),
    isGitRepository: async () => true,
    managedProjectRoots: ['/chats'],
    realpath: async (root) => root,
  });
  const service = createOpenChamberControlService({
    projectContextRuntime: runtime,
    resolveProjectContextId,
    sessionService: { resolveDirectory: async ({ projectId }) => {
      if (projectId === 'configured-repo') return '/repo';
      if (projectId === 'configured-worktree') return '/registered-worktree';
      if (projectId === 'missing-folder') throw new OpenChamberControlError('Project folder missing', 400);
      throw new OpenChamberControlError('Project not found', 404);
    } },
    ...overrides,
  });
  return { service, runtime, context };
};

describe('project knowledge control actions', () => {
  it.each([
    [{}, '/worktree', '/repo'],
    [{ projectId: 'configured-repo' }, '/other', '/repo'],
    [{ directory: '/registered-worktree' }, '/other', '/registered-worktree'],
    [{ projectId: 'configured-worktree' }, '/other', '/registered-worktree'],
    [{}, '/chats/2026-10-08/ses_1', '/chats'],
  ])('resolves configured scope and calling directories to the storage owner', async (input, callingDirectory, ownerDirectory) => {
    const { service, runtime } = setup();
    const result = await service.execute('notes.list', input, callingDirectory);
    const owner = createProjectIdFromPath(ownerDirectory);
    expect(result.projectId).toBe(owner);
    expect(runtime.readContext).toHaveBeenCalledWith(owner);
  });

  it.each([
    [{ projectId: 'missing' }, '/repo', 404],
    [{ projectId: 'missing-folder' }, '/repo', 400],
    [{ projectId: 'configured-repo', directory: '/repo' }, '/repo', 400],
    [{ projectId: '' }, '/repo', 400],
    [{ projectId: 3 }, '/repo', 400],
    [{ directory: ' ' }, '/repo', 400],
    [{ directory: 3 }, '/repo', 400],
    [{ directory: 'relative' }, '/repo', 400],
    [{ directory: '/unowned' }, '/repo', 404],
    [{}, undefined, 400],
  ])('rejects invalid scope before storage access', async (input, directory, statusCode) => {
    const { service, runtime } = setup();
    await expect(service.execute('todos.list', input, directory)).rejects.toMatchObject({ statusCode });
    expect(runtime.readContext).not.toHaveBeenCalled();
  });

  it('rejects unresolved owners and unavailable dependencies', async () => {
    await expect(setup({ resolveProjectContextId: async () => '' }).service.execute('plans.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 404 });
    await expect(setup({ projectContextRuntime: null }).service.execute('plans.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('rejects failed worktree discovery before a registered ancestor can receive a write', async () => {
    const getWorktrees = vi.fn(async () => { throw new Error('Worktree discovery failed'); });
    const resolveProjectContextId = createKnowledgeOwnerResolver({
      listProjectPaths: async () => ['/home', '/repo'], getWorktrees,
      resolvePrimaryWorktreeRoot: async () => ({ root: '/repo' }),
      isGitRepository: async () => true,
    });
    const { service, runtime } = setup({ resolveProjectContextId });
    await expect(service.execute('notes.create', { body: 'Must not reach ancestor' }, '/home/tree/src', { contextSessionId: 'ses_caller' }))
      .rejects.toMatchObject({ statusCode: 500, message: 'Worktree discovery failed' });
    expect(runtime.createNote).not.toHaveBeenCalled();
    expect(runtime.readContext).not.toHaveBeenCalled();
  });

  it('reads each knowledge type and dispatches all mutations directly', async () => {
    const { service, runtime, context } = setup();
    const owner = createProjectIdFromPath('/repo');
    const call = (action, input = {}) => service.execute(action, input, '/repo', { contextSessionId: 'ses_caller' });
    expect((await call('notes.read', { noteId: 'note-1' })).note).toEqual(context.notes[0]);
    expect((await call('todos.list')).todos).toEqual(context.todos);
    expect((await call('plans.list')).plans).toEqual(context.plans);
    expect((await call('plans.read', { planId: 'shared:team.md' })).plan.raw).toBe('# Plan\n');
    await call('notes.create', { body: 'New', source: 'manual', origin: { sessionId: 'spoof' }, sessionId: 'spoof', pinned: true });
    expect(runtime.createNote).toHaveBeenCalledWith(owner, { body: 'New', source: 'agent', origin: { sessionId: 'ses_caller' } });
    await call('notes.update', { noteId: 'note-1', body: 'Edit', pinned: true, origin: { sessionId: 'spoof' } });
    expect(runtime.updateNote).toHaveBeenCalledWith(owner, 'note-1', { body: 'Edit' }, {});
    await call('notes.delete', { noteId: 'note-1' });
    expect(runtime.deleteNote).toHaveBeenCalledWith(owner, 'note-1');
    await call('todos.create', { text: 'New', id: 'spoof', completed: true });
    expect(runtime.createTodo).toHaveBeenCalledWith(owner, { text: 'New' });
    for (const completed of [true, false]) {
      await call('todos.update', { todoId: 'todo-1', completed });
      expect(runtime.updateTodo).toHaveBeenLastCalledWith(owner, 'todo-1', { completed });
    }
    await call('todos.update', { todoId: 'todo-1', text: 'Edited' });
    expect(runtime.updateTodo).toHaveBeenLastCalledWith(owner, 'todo-1', { text: 'Edited' });
    await call('todos.delete', { todoId: 'todo-1' });
    expect(runtime.deleteTodo).toHaveBeenCalledWith(owner, 'todo-1');
    await call('plans.create', { title: 'New', body: '' });
    expect(runtime.createPlan).toHaveBeenCalledWith(owner, { title: 'New', body: '' });
    await call('plans.update', { planId: 'shared:team.md', raw: '# Edited\r\n', expectedRaw: '# Plan\n' });
    expect(runtime.updatePlan).toHaveBeenCalledWith(owner, 'shared:team.md', { raw: '# Edited\r\n' }, { expectedRaw: '# Plan\n' });
    await call('plans.delete', { planId: 'plan-1' });
    expect(runtime.deletePlan).toHaveBeenCalledWith(owner, 'plan-1');
  });

  it.each([
    ['notes.read', {}], ['notes.create', { body: '' }], ['notes.create', { body: 'a'.repeat(3001) }],
    ['notes.update', { noteId: 'note-1' }], ['notes.delete', {}],
    ['notes.update', { noteId: 'note-1', body: 'New', expectedBody: false }],
    ['todos.create', { text: 'a'.repeat(1001) }], ['todos.update', { todoId: 'todo-1' }],
    ['todos.update', { todoId: 'todo-1', completed: 'false' }], ['todos.delete', {}],
    ['plans.read', {}], ['plans.create', { title: 'a'.repeat(161), body: '' }],
    ['plans.update', { planId: 'plan-1', raw: 'a'.repeat(200001) }],
    ['plans.update', { planId: 'plan-1', raw: '', expectedRaw: false }], ['plans.delete', {}],
  ])('returns validation errors for %s', async (action, input) => {
    await expect(setup().service.execute(action, input, '/repo', { contextSessionId: 'ses_1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each(['Note', '', '  Note\r\n'])('forwards the exact optional last-read note body', async (expectedBody) => {
    const { service, runtime } = setup();
    await service.execute('notes.update', { noteId: 'note-1', body: 'New', expectedBody, source: 'manual', origin: { sessionId: 'spoof' } }, '/repo');
    expect(runtime.updateNote).toHaveBeenCalledWith(createProjectIdFromPath('/repo'), 'note-1', { body: 'New' }, { expectedBody });
  });

  it('requires callback provenance to create notes', async () => {
    const { service, runtime } = setup();
    await expect(service.execute('notes.create', { body: 'Note', sessionId: 'spoof' }, '/repo')).rejects.toMatchObject({ statusCode: 400 });
    expect(runtime.createNote).not.toHaveBeenCalled();
  });

  it('reports missing entries and propagates runtime failures', async () => {
    const { service, runtime } = setup();
    runtime.updateNote.mockResolvedValue(null);
    runtime.readPlan.mockResolvedValue(null);
    runtime.deleteNote.mockResolvedValue({ deleted: false });
    runtime.deletePlan.mockResolvedValue({ deleted: false });
    runtime.updateTodo.mockRejectedValue(Object.assign(new Error('Todo not found'), { status: 404 }));
    runtime.deleteTodo.mockRejectedValue(Object.assign(new Error('Todo not found'), { status: 404 }));
    for (const [action, input] of [
      ['notes.read', { noteId: 'missing' }], ['notes.update', { noteId: 'missing', body: 'New' }],
      ['notes.delete', { noteId: 'missing' }], ['plans.read', { planId: 'missing' }],
      ['plans.delete', { planId: 'missing' }], ['todos.update', { todoId: 'missing', completed: true }],
      ['todos.delete', { todoId: 'missing' }],
    ]) await expect(service.execute(action, input, '/repo')).rejects.toMatchObject({ statusCode: 404 });
    runtime.updatePlan.mockRejectedValue(new OpenChamberControlError('Plan changed', 409));
    await expect(service.execute('plans.update', { planId: 'plan-1', raw: '', expectedRaw: '' }, '/repo')).rejects.toMatchObject({ statusCode: 409 });
    runtime.updateNote.mockRejectedValue(Object.assign(new Error('Note changed'), { status: 409 }));
    await expect(service.execute('notes.update', { noteId: 'note-1', body: 'New', expectedBody: 'Note' }, '/repo')).rejects.toMatchObject({ statusCode: 409 });
    runtime.readContext.mockRejectedValue(new Error('Stored project context is malformed'));
    await expect(service.execute('notes.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 500, message: 'Stored project context is malformed' });
  });
});
