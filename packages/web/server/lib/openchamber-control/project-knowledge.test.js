import { describe, expect, it, vi } from 'vitest';
import { createOpenChamberControlService } from './service.js';
import { OpenChamberControlError } from './error.js';
import { createMemoryProjectResolver } from '../agent-memory/project-resolution.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

const setup = (overrides = {}) => {
  const context = { notes: [{ id: 'note-1', body: 'Note' }], todos: [{ id: 'todo-1', text: 'Task', completed: false }], plans: [{ id: 'plan-1', title: 'Plan', file: 'plan.md', source: 'personal', createdAt: 1 }] };
  const runtime = {
    readContext: vi.fn(async () => context),
    createNote: vi.fn(async (projectId, note) => ({ note: { id: 'note-2', ...note }, context })),
    updateNote: vi.fn(async () => ({ note: context.notes[0], context })),
    deleteNote: vi.fn(async () => ({ deleted: true, context })),
    createTodo: vi.fn(async () => ({ todo: context.todos[0], context })),
    updateTodo: vi.fn(async () => context),
    deleteTodo: vi.fn(async () => context),
    readPlan: vi.fn(async () => ({ ...context.plans[0], raw: '# Plan\n', path: '/data/plans/plan.md' })),
    createPlan: vi.fn(async () => ({ plan: context.plans[0], context })),
    updatePlan: vi.fn(async () => ({ plan: context.plans[0], context })),
    deletePlan: vi.fn(async () => ({ deleted: true, context })),
    plansDirFor: vi.fn(() => '/data/plans'),
  };
  const resolveProjectContextId = createMemoryProjectResolver({
    listProjectPaths: async () => ['/repo', '/registered-worktree'],
    resolvePrimaryWorktreeRoot: async () => ({ root: '/repo' }),
    managedProjectRoots: ['/chats'],
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
  it('warns when a saved plan has no Steps checklist, so the agent adds one', async () => {
    const { service } = setup();
    const bare = await service.execute('knowledge.save', { kind: 'plan', body: '# Release\n\nShip it' }, '/repo');
    expect(bare.warning).toContain('## Steps');
    const stepped = await service.execute('knowledge.save', { kind: 'plan', id: 'plan-1', body: '# Release\n\n## Steps\n- [ ] ship' }, '/repo');
    expect(stepped).not.toHaveProperty('warning');
  });

  it('lists a plan with its progress', async () => {
    const { service, context } = setup();
    context.plans[0].progress = { done: 1, total: 3 };
    expect((await service.execute('knowledge.list', {}, '/repo')).plans[0].progress).toEqual({ done: 1, total: 3 });
  });

  it.each([
    [{}, '/worktree', '/repo'],
    [{ projectId: 'configured-repo' }, '/other', '/repo'],
    [{ directory: '/registered-worktree' }, '/other', '/registered-worktree'],
    [{ projectId: 'configured-worktree' }, '/other', '/registered-worktree'],
    [{}, '/chats/2026-10-08/ses_1', '/chats'],
  ])('resolves configured scope and calling directories to the storage owner', async (input, callingDirectory, ownerDirectory) => {
    const { service, runtime } = setup();
    const result = await service.execute('knowledge.list', input, callingDirectory);
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
    [{}, undefined, 400],
  ])('rejects invalid scope before storage access', async (input, directory, statusCode) => {
    const { service, runtime } = setup();
    await expect(service.execute('knowledge.list', input, directory)).rejects.toMatchObject({ statusCode });
    expect(runtime.readContext).not.toHaveBeenCalled();
  });

  it('rejects unresolved owners and unavailable dependencies', async () => {
    await expect(setup({ resolveProjectContextId: async () => '' }).service.execute('knowledge.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 404 });
    await expect(setup({ projectContextRuntime: null }).service.execute('knowledge.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('refuses every action once the tool is switched off, before storage access', async () => {
    const { service, runtime } = setup({ isKnowledgeToolEnabled: async () => false });
    await expect(service.execute('knowledge.save', { kind: 'note', body: 'Note' }, '/repo', { contextSessionId: 'ses_1' }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.execute('knowledge.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 403 });
    expect(runtime.createNote).not.toHaveBeenCalled();
    expect(runtime.readContext).not.toHaveBeenCalled();
  });

  it('lists everything at once, plans by title and file path', async () => {
    const { service, runtime, context } = setup();
    runtime.readContext.mockResolvedValue({
      ...context,
      sharedPlansDir: '/repo/plans',
      plans: [...context.plans, { id: 'shared:team.md', title: 'Team', file: 'team.md', source: 'shared', createdAt: 0 }],
    });
    expect(await service.execute('knowledge.list', {}, '/repo')).toEqual({
      projectId: createProjectIdFromPath('/repo'),
      notes: context.notes,
      todos: context.todos,
      plans: [
        { id: 'plan-1', title: 'Plan', source: 'personal', createdAt: 1, path: '/data/plans/plan.md' },
        { id: 'shared:team.md', title: 'Team', source: 'shared', createdAt: 0, path: '/repo/plans/team.md' },
      ],
    });
  });

  it('dispatches every kind through save and delete', async () => {
    const { service, runtime, context } = setup();
    const owner = createProjectIdFromPath('/repo');
    const call = (action, input = {}) => service.execute(action, input, '/repo', { contextSessionId: 'ses_caller' });

    await call('knowledge.save', { kind: 'note', body: 'New', source: 'manual', origin: { sessionId: 'spoof' }, sessionId: 'spoof' });
    expect(runtime.createNote).toHaveBeenCalledWith(owner, { body: 'New', source: 'agent', origin: { sessionId: 'ses_caller' } });
    await call('knowledge.save', { kind: 'note', id: 'note-1', body: 'Edit', expected: 'Note' });
    expect(runtime.updateNote).toHaveBeenCalledWith(owner, 'note-1', { body: 'Edit' }, { expectedBody: 'Note' });

    expect((await call('knowledge.save', { kind: 'todo', body: 'New', completed: true })).todo).toEqual(context.todos[0]);
    expect(runtime.createTodo).toHaveBeenCalledWith(owner, { text: 'New', completed: true });
    await call('knowledge.save', { kind: 'todo', id: 'todo-1', completed: true });
    expect(runtime.updateTodo).toHaveBeenLastCalledWith(owner, 'todo-1', { completed: true });
    await call('knowledge.save', { kind: 'todo', id: 'todo-1', body: 'Edited' });
    expect(runtime.updateTodo).toHaveBeenLastCalledWith(owner, 'todo-1', { text: 'Edited' });

    expect((await call('knowledge.save', { kind: 'plan', body: '# Release\n\nShip it' })).plan)
      .toEqual({ id: 'plan-1', title: 'Plan', source: 'personal', createdAt: 1, path: '/data/plans/plan.md' });
    expect(runtime.createPlan).toHaveBeenCalledWith(owner, { title: 'Release', body: 'Ship it' });
    await call('knowledge.save', { kind: 'plan', id: 'shared:team.md', body: '# Edited\r\n', expected: '# Plan\n' });
    expect(runtime.updatePlan).toHaveBeenCalledWith(owner, 'shared:team.md', { raw: '# Edited\r\n' }, { expectedRaw: '# Plan\n' });

    for (const [kind, method] of [['note', 'deleteNote'], ['todo', 'deleteTodo'], ['plan', 'deletePlan']]) {
      expect(await call('knowledge.delete', { kind, id: 'x' })).toEqual({ projectId: owner, deleted: true });
      expect(runtime[method]).toHaveBeenCalledWith(owner, 'x');
    }
  });

  it.each([
    ['note', { kind: 'note', body: 'New note', expected: 'Old note' }, 'createNote'],
    ['plan', { kind: 'plan', body: '# Release\n\nShip it', expected: '# Release\n' }, 'createPlan'],
  ])('refuses expected on a %s create before any storage access', async (kind, input, createMethod) => {
    const { service, runtime } = setup();
    await expect(service.execute('knowledge.save', input, '/repo', { contextSessionId: 'ses_1' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('requires an id') });
    expect(runtime[createMethod]).not.toHaveBeenCalled();
    expect(runtime.updateNote).not.toHaveBeenCalled();
    expect(runtime.updatePlan).not.toHaveBeenCalled();
    expect(runtime.readContext).not.toHaveBeenCalled();
  });

  it.each([
    ['knowledge.delete', { kind: 'memo', id: 'x' }],
    ['knowledge.save', { body: 'No kind' }], ['knowledge.save', { kind: 'note', body: '' }],
    ['knowledge.save', { kind: 'note', body: 'a'.repeat(3001) }],
    ['knowledge.save', { kind: 'note', id: 'note-1', body: 'New', expected: false }],
    ['knowledge.save', { kind: 'todo', body: 'a'.repeat(1001) }], ['knowledge.save', { kind: 'todo', id: 'todo-1' }],
    ['knowledge.save', { kind: 'todo', id: 'todo-1', completed: 'false' }],
    ['knowledge.save', { kind: 'todo', id: 'todo-1', completed: true, expected: 'x' }],
    ['knowledge.save', { kind: 'plan', body: 'a'.repeat(200001) }], ['knowledge.save', { kind: 'plan', body: 'Release\n\nShip it' }],
    ['knowledge.save', { kind: 'todo', body: 'Done', completed: 'yes' }], ['knowledge.delete', { kind: 'note' }],
    ['knowledge.show', { kind: 'note', id: 'note-1' }], ['knowledge.show', { kind: 'plan' }],
  ])('returns validation errors for %s %j', async (action, input) => {
    await expect(setup().service.execute(action, input, '/repo', { contextSessionId: 'ses_1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires callback provenance to create notes', async () => {
    const { service, runtime } = setup();
    await expect(service.execute('knowledge.save', { kind: 'note', body: 'Note', sessionId: 'spoof' }, '/repo')).rejects.toMatchObject({ statusCode: 400 });
    expect(runtime.createNote).not.toHaveBeenCalled();
  });

  it('shows an existing plan to every connected window and says when nobody is there', async () => {
    const showPlan = vi.fn(() => 2);
    const { service, runtime } = setup({ showPlan });
    expect(await service.execute('knowledge.show', { kind: 'plan', id: 'plan-1' }, '/repo/sub', { contextSessionId: 'ses_1' }))
      .toEqual({ projectId: createProjectIdFromPath('/repo'), planId: 'plan-1', shown: true });
    expect(showPlan).toHaveBeenCalledWith({ projectId: createProjectIdFromPath('/repo'), planId: 'plan-1', title: 'Plan', directory: '/repo/sub', sessionId: 'ses_1' });
    showPlan.mockReturnValue(0);
    await expect(service.execute('knowledge.show', { kind: 'plan', id: 'plan-1' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
    runtime.readPlan.mockResolvedValue(null);
    await expect(service.execute('knowledge.show', { kind: 'plan', id: 'gone' }, '/repo')).rejects.toMatchObject({ statusCode: 404 });
    await expect(setup().service.execute('knowledge.show', { kind: 'plan', id: 'plan-1' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('reports missing entries and passes conflicts through', async () => {
    const { service, runtime } = setup();
    runtime.updateNote.mockResolvedValue(null);
    runtime.readPlan.mockResolvedValue(null);
    runtime.deleteNote.mockResolvedValue({ deleted: false });
    runtime.deletePlan.mockResolvedValue({ deleted: false });
    runtime.updateTodo.mockRejectedValue(Object.assign(new Error('Todo not found'), { status: 404 }));
    runtime.deleteTodo.mockRejectedValue(Object.assign(new Error('Todo not found'), { status: 404 }));
    for (const [action, input] of [
      ['knowledge.save', { kind: 'note', id: 'missing', body: 'New' }],
      ['knowledge.delete', { kind: 'note', id: 'missing' }], ['knowledge.delete', { kind: 'plan', id: 'missing' }],
      ['knowledge.save', { kind: 'todo', id: 'missing', completed: true }], ['knowledge.delete', { kind: 'todo', id: 'missing' }],
    ]) await expect(service.execute(action, input, '/repo')).rejects.toMatchObject({ statusCode: 404 });
    runtime.updatePlan.mockRejectedValue(new OpenChamberControlError('Plan changed', 409));
    await expect(service.execute('knowledge.save', { kind: 'plan', id: 'plan-1', body: '# P', expected: '' }, '/repo')).rejects.toMatchObject({ statusCode: 409 });
    runtime.updateNote.mockRejectedValue(Object.assign(new Error('Note changed'), { status: 409 }));
    await expect(service.execute('knowledge.save', { kind: 'note', id: 'note-1', body: 'New', expected: 'Note' }, '/repo')).rejects.toMatchObject({ statusCode: 409 });
    runtime.readContext.mockRejectedValue(new Error('Stored project context is malformed'));
    await expect(service.execute('knowledge.list', {}, '/repo')).rejects.toMatchObject({ statusCode: 500, message: 'Stored project context is malformed' });
  });
});
