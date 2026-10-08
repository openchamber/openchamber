import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCode } from '@opencode/client';
import { createExistingSessionTasks } from './existing-session.js';
import { createScheduledTaskService } from './service.js';
import { registerScheduledTaskRoutes } from './routes.js';
import { createScheduledTasksRuntime } from './runtime.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const task = {
  id: 'task-1', name: 'Repeat', enabled: true, targetSessionId: 'ses_target',
  schedule: { kind: 'daily', time: '09:00' }, execution: { prompt: 'Follow up', useDefaults: true }, state: {},
};

const setup = (overrides = {}) => {
  let stored = structuredClone(task);
  const projectConfigRuntime = {
    listScheduledTasks: async () => [stored],
    updateScheduledTaskState: async (_project, _task, patch) => {
      stored = { ...stored, state: { ...stored.state, ...patch } };
      return { task: stored };
    },
    updateScheduledTaskStateIf: async (_project, _task, predicate, patch) => {
      if (!predicate(stored)) return { task: stored, updated: false };
      stored = { ...stored, state: { ...stored.state, ...patch } };
      return { task: stored, updated: true };
    },
    upsertScheduledTask: async (_project, input) => {
      stored = { ...stored, ...input };
      return { task: stored };
    },
    deleteScheduledTask: async () => ({ deleted: true }),
  };
  const messageQueueRuntime = { enqueue: vi.fn(async () => {}), cancelScheduledTask: vi.fn(async () => {}) };
  const runtime = createExistingSessionTasks({
    projectConfigRuntime, messageQueueRuntime,
    createClient: () => ({ session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: '/repo' } }) } }),
    listProjects: async () => [{ id: 'project-1', path: '/repo' }],
    ...overrides,
  });
  return { runtime, projectConfigRuntime, messageQueueRuntime, stored: () => stored };
};

describe('existing session scheduling', () => {
  it('the scheduler reuses a target without creating a chat or reading new-session defaults', async () => {
    const { projectConfigRuntime, messageQueueRuntime } = setup();
    const fetchImpl = vi.fn(async () => Response.json({ location: { directory: '/repo' }, data: { id: 'ses_target', location: { directory: '/repo' } } }));
    vi.stubGlobal('fetch', fetchImpl);
    const readSessionDefaults = vi.fn();
    const createChatDirectory = vi.fn();
    const scheduler = createScheduledTasksRuntime({
      projectConfigRuntime, messageQueueRuntime,
      listProjects: async () => [{ id: 'project-1', path: '/repo' }],
      chatsScope: { id: 'project-1', root: '/repo', contains: () => true, createChatDirectory },
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`, getOpenCodeAuthHeaders: () => ({}),
      readSessionDefaults,
    });
    await scheduler.syncProject('project-1');
    expect(await scheduler.runNow('project-1', 'task-1')).toMatchObject({ ok: true, sessionID: 'ses_target' });
    expect(createChatDirectory).not.toHaveBeenCalled();
    expect(readSessionDefaults).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe('/api/session/ses_target');
  });
  it('admits to the ordinary queue, records the target, then finishes at send', async () => {
    const { runtime, messageQueueRuntime, stored } = setup();
    const result = await runtime.run('project-1', { ...task, execution: { ...task.execution, providerID: 'old', modelID: 'old', agent: 'old' } }, 'manual');
    expect(result).toMatchObject({ ok: true, sessionID: 'ses_target', directory: '/repo' });
    expect(messageQueueRuntime.enqueue).toHaveBeenCalledWith('ses_target', '/repo', {
      content: 'Follow up', text: 'Follow up', sendConfig: {}, scheduledTask: { projectId: 'project-1', taskId: 'task-1' },
    });
    expect(stored().state).toMatchObject({ lastStatus: 'queued', lastSessionId: 'ses_target' });
    await runtime.result({ projectId: 'project-1', taskId: 'task-1' }, 'sent');
    expect(stored().state.lastStatus).toBe('sent');
  });

  it('records a duplicate Run now as skipped with queued busy status', async () => {
    const { runtime, messageQueueRuntime, stored } = setup();
    messageQueueRuntime.enqueue.mockRejectedValue(Object.assign(new Error('task is already queued'), { status: 409 }));
    expect(await runtime.run('project-1', task, 'manual')).toMatchObject({ ok: false, queued: true, statusCode: 409 });
    expect(stored().state.lastStatus).toBe('skipped');
    expect(messageQueueRuntime.cancelScheduledTask).not.toHaveBeenCalled();
  });

  it.each(['manual', 'scheduled'])('records a %s attempt that overlaps an admission before the final queued write', async (reason) => {
    let releaseTarget;
    const target = new Promise((resolve) => { releaseTarget = resolve; });
    const { runtime, projectConfigRuntime, stored, messageQueueRuntime } = setup({
      createClient: () => ({ session: { get: () => target } }),
    });
    const claim = vi.spyOn(projectConfigRuntime, 'updateScheduledTaskStateIf');
    const first = runtime.run('project-1', task, 'manual');
    expect(await runtime.run('project-1', task, reason, Date.now())).toMatchObject({ ok: false, queued: true });
    expect(stored().state).toMatchObject({ lastStatus: 'skipped', lastError: 'task is already queued' });
    expect(claim).not.toHaveBeenCalled();
    releaseTarget({ id: 'ses_target', location: { directory: '/repo' } });
    expect(await first).toMatchObject({ ok: true });
    expect(stored().state).toMatchObject({ lastStatus: 'queued', lastSessionId: 'ses_target' });
    expect(messageQueueRuntime.enqueue).toHaveBeenCalledOnce();
  });

  it.each(['manual', 'scheduled'])('returns queued busy when the %s overlap state write rejects', async (reason) => {
    let releaseTarget;
    const target = new Promise((resolve) => { releaseTarget = resolve; });
    const { runtime, projectConfigRuntime, messageQueueRuntime } = setup({
      createClient: () => ({ session: { get: () => target } }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = runtime.run('project-1', task, 'manual');
    const write = vi.spyOn(projectConfigRuntime, 'updateScheduledTaskState').mockRejectedValueOnce(new Error('project lock timeout'));
    try {
      await expect(runtime.run('project-1', task, reason, Date.now())).resolves.toMatchObject({
        ok: false, queued: true, error: 'task is already queued',
      });
      expect(write).toHaveBeenCalledWith('project-1', task.id, expect.objectContaining({ lastStatus: 'skipped' }));
      expect(warn).toHaveBeenCalledWith('[scheduled-tasks] admission failure state write failed:', 'project lock timeout');
    } finally {
      releaseTarget({ id: 'ses_target', location: { directory: '/repo' } });
      await first;
      warn.mockRestore();
    }
    expect(messageQueueRuntime.enqueue).toHaveBeenCalledOnce();
    expect(messageQueueRuntime.cancelScheduledTask).not.toHaveBeenCalled();
  });

  it('keeps manual busy 409 and re-arms the scheduled timer when overlap state writes reject', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T08:00:00Z'));
    const { projectConfigRuntime, messageQueueRuntime } = setup();
    await projectConfigRuntime.upsertScheduledTask('project-1', {
      ...task, schedule: { kind: 'daily', time: '08:01', timezone: 'UTC' },
    });
    let releaseAdmission;
    let enteredAdmission;
    const admission = new Promise((resolve) => { releaseAdmission = resolve; });
    const entered = new Promise((resolve) => { enteredAdmission = resolve; });
    messageQueueRuntime.enqueue.mockImplementationOnce(() => {
      enteredAdmission();
      return admission;
    });
    vi.stubGlobal('fetch', async () => Response.json({ data: { id: 'ses_target', location: { directory: '/repo' } } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schedulerWarn = vi.fn();
    const scheduler = createScheduledTasksRuntime({
      projectConfigRuntime, messageQueueRuntime, logger: { warn: schedulerWarn },
      listProjects: async () => [{ id: 'project-1', path: '/repo' }],
      chatsScope: { id: 'project-1', root: '/repo', contains: () => true },
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`, getOpenCodeAuthHeaders: () => ({}),
    });
    const service = createScheduledTaskService({
      projectConfigRuntime, scheduledTasksRuntime: scheduler,
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-1', path: '/repo' }] }), sanitizeProjects: (projects) => projects,
    });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'put', 'delete', 'patch', 'post'].map((method) => [method, (route, handler) => handlers.set(`${method}:${route}`, handler)]));
    registerScheduledTaskRoutes(app, { scheduledTaskService: service });
    let first;
    try {
      await scheduler.start();
      first = scheduler.runNow('project-1', task.id);
      await entered;
      vi.spyOn(projectConfigRuntime, 'updateScheduledTaskState')
        .mockRejectedValueOnce(new Error('disk write failed'))
        .mockRejectedValueOnce(new Error('project lock timeout'));
      const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handlers.get('post:/api/projects/:projectId/scheduled-tasks/:taskId/run')({ params: { projectId: 'project-1', taskId: task.id } }, response);
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ busy: 'queued', error: 'task is already queued' });
      await vi.advanceTimersByTimeAsync(65_000);
      expect(warn).toHaveBeenCalledWith('[scheduled-tasks] admission failure state write failed:', 'project lock timeout');
      expect(schedulerWarn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      expect(messageQueueRuntime.enqueue).toHaveBeenCalledOnce();
      releaseAdmission();
      await expect(first).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(messageQueueRuntime.enqueue).toHaveBeenCalledTimes(2);
      expect(schedulerWarn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      releaseAdmission();
      await first;
      scheduler.stop();
      warn.mockRestore();
    }
  });

  it('ignores task goal and auto-accept options when reusing a target', async () => {
    const { projectConfigRuntime, messageQueueRuntime } = setup();
    const execution = { ...task.execution, goalEnabled: true, goalTokenBudget: 5000, permissionAutoAccept: true };
    await projectConfigRuntime.upsertScheduledTask('project-1', { ...task, execution });
    const fetchImpl = vi.fn(async () => Response.json({ data: { id: 'ses_target', location: { directory: '/repo' } } }));
    vi.stubGlobal('fetch', fetchImpl);
    const setSessionAutoAccept = vi.fn();
    const persistSessionGoal = vi.fn();
    const scheduler = createScheduledTasksRuntime({
      projectConfigRuntime, messageQueueRuntime, setSessionAutoAccept, persistSessionGoal,
      listProjects: async () => [{ id: 'project-1', path: '/repo' }],
      chatsScope: { id: 'project-1', root: '/repo', contains: () => true },
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`, getOpenCodeAuthHeaders: () => ({}),
    });
    await scheduler.syncProject('project-1');
    await scheduler.runNow('project-1', task.id);
    const item = messageQueueRuntime.enqueue.mock.calls[0][2];
    expect(item.scheduledTask).toEqual({ projectId: 'project-1', taskId: 'task-1' });
    await scheduler.beforeScheduledTaskSend('ses_target', '/repo', item);
    expect(setSessionAutoAccept).not.toHaveBeenCalled();
    expect(persistSessionGoal).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(item.context).toBeUndefined();
  });

  it('Run now on a deleted target responds 404 with its message', async () => {
    const { runtime, projectConfigRuntime } = setup({ createClient: () => OpenCode.make({ baseUrl: 'http://opencode.test', fetch: async () => Response.json({ name: 'NotFoundError', message: 'Not found' }, { status: 404 }) }) });
    const scheduledTasksRuntime = { runNow: (project, id) => runtime.run(project, { ...task, id }, 'manual') };
    const service = createScheduledTaskService({
      projectConfigRuntime, scheduledTasksRuntime,
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-1', path: '/repo' }] }), sanitizeProjects: (projects) => projects,
    });
    const handlers = new Map();
    const app = Object.fromEntries(['get', 'put', 'delete', 'patch', 'post'].map((method) => [method, (route, handler) => handlers.set(`${method}:${route}`, handler)]));
    registerScheduledTaskRoutes(app, { scheduledTaskService: service });
    const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers.get('post:/api/projects/:projectId/scheduled-tasks/:taskId/run')({ params: { projectId: 'project-1', taskId: task.id } }, response);
    expect(response.statusCode).toBe(404);
    expect(response.body.error).toBe('Scheduled target not found');
  });

  it('refuses archived and foreign targets and admits linked worktrees', async () => {
    await expect(setup({ isSessionArchived: () => true }).runtime.validateTarget('project-1', 'ses_target')).rejects.toMatchObject({ statusCode: 409, message: 'Scheduled target is archived' });
    const foreign = () => ({ session: { get: async () => ({ id: 'ses_target', location: { directory: '/worktree' } }) } });
    await expect(setup({ createClient: foreign }).runtime.validateTarget('project-1', 'ses_target')).rejects.toMatchObject({ statusCode: 409 });
    await expect(setup({ createClient: foreign, resolvePrimaryWorktreeRoot: async () => ({ root: '/repo' }) }).runtime.validateTarget('project-1', 'ses_target')).resolves.toMatchObject({ directory: '/worktree' });
  });

  it.each(['removed', 'retargeted', 'moved'])('refuses a %s target/task before send with 409', async (change) => {
    let directory = '/repo';
    const { runtime, projectConfigRuntime, messageQueueRuntime } = setup({
      createClient: () => ({ session: { get: async () => ({ id: 'ses_target', location: { directory } }) } }),
      resolvePrimaryWorktreeRoot: async () => ({ root: '/repo' }),
    });
    await runtime.run('project-1', task, 'manual');
    if (change === 'removed') projectConfigRuntime.listScheduledTasks = async () => [];
    if (change === 'retargeted') await projectConfigRuntime.upsertScheduledTask('project-1', { ...task, targetSessionId: 'ses_another' });
    if (change === 'moved') directory = '/worktree';
    await expect(runtime.beforeSend('ses_target', '/repo', messageQueueRuntime.enqueue.mock.calls[0][2])).rejects.toMatchObject({
      statusCode: 409,
      message: change === 'moved' ? 'Scheduled target moved' : 'Scheduled task target changed or was removed',
    });
  });

  it('cancels waiting prompts on disable, retarget and delete', async () => {
    for (const input of [{ ...task, enabled: false }, { ...task, targetSessionId: 'ses_another' }]) {
      const { runtime, projectConfigRuntime, messageQueueRuntime } = setup();
      const service = createScheduledTaskService({
        projectConfigRuntime, scheduledTasksRuntime: { validateTarget: runtime.validateTarget, cancelWaitingPrompt: runtime.cancel, syncProject: async () => [] },
        readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-1', path: '/repo' }] }), sanitizeProjects: (projects) => projects,
      });
      await service.upsert('project-1', input);
      expect(messageQueueRuntime.cancelScheduledTask).toHaveBeenCalledWith('project-1', task.id);
      await service.remove('project-1', task.id);
      expect(messageQueueRuntime.cancelScheduledTask).toHaveBeenCalledTimes(2);
    }
  });

  it.each([404, 409])('allows pausing and editing an unchanged stale target with refusal %s', async (statusCode) => {
    const { projectConfigRuntime, stored } = setup();
    const validateTarget = vi.fn(async () => { throw Object.assign(new Error('stale target'), { statusCode }); });
    const service = createScheduledTaskService({
      projectConfigRuntime,
      scheduledTasksRuntime: { validateTarget, cancelWaitingPrompt: async () => {}, syncProject: () => projectConfigRuntime.listScheduledTasks() },
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-1', path: '/repo' }] }), sanitizeProjects: (projects) => projects,
    });
    expect(await service.setEnabled('project-1', task.id, false)).toMatchObject({ enabled: false });
    expect((await service.upsert('project-1', { ...stored(), name: 'Paused edit' })).task.name).toBe('Paused edit');
    expect(validateTarget).not.toHaveBeenCalled();
    await expect(service.setEnabled('project-1', task.id, true)).rejects.toMatchObject({ statusCode });
    await expect(service.upsert('project-1', { ...stored(), targetSessionId: 'ses_another' })).rejects.toMatchObject({ statusCode });
    expect(validateTarget).toHaveBeenCalledTimes(2);
  });

  it('keeps a waiting prompt when disabling or retargeting fails to save', async () => {
    for (const input of [{ ...task, enabled: false }, { ...task, targetSessionId: 'ses_another' }]) {
      const { runtime, projectConfigRuntime, messageQueueRuntime } = setup();
      projectConfigRuntime.upsertScheduledTask = async () => { throw new Error('disk write failed'); };
      const service = createScheduledTaskService({
        projectConfigRuntime, scheduledTasksRuntime: { validateTarget: runtime.validateTarget, cancelWaitingPrompt: runtime.cancel, syncProject: async () => [] },
        readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-1', path: '/repo' }] }), sanitizeProjects: (projects) => projects,
      });
      await expect(service.upsert('project-1', input)).rejects.toMatchObject({ statusCode: 500 });
      expect(messageQueueRuntime.cancelScheduledTask).not.toHaveBeenCalled();
    }
  });

  it('keeps a manually queued prompt when saving an already-paused task, but cancels on retarget', async () => {
    const { runtime, projectConfigRuntime, messageQueueRuntime, stored } = setup();
    await projectConfigRuntime.upsertScheduledTask('project-1', { ...task, enabled: false });
    await runtime.run('project-1', stored(), 'manual');
    const service = createScheduledTaskService({
      projectConfigRuntime, scheduledTasksRuntime: { validateTarget: runtime.validateTarget, cancelWaitingPrompt: runtime.cancel, syncProject: () => projectConfigRuntime.listScheduledTasks() },
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'project-1', path: '/repo' }] }), sanitizeProjects: (projects) => projects,
    });
    await service.upsert('project-1', { ...stored(), name: 'Paused edit' });
    expect(stored().enabled).toBe(false);
    expect(stored().state.lastStatus).toBe('queued');
    expect(messageQueueRuntime.cancelScheduledTask).not.toHaveBeenCalled();
    await service.upsert('project-1', { ...stored(), targetSessionId: 'ses_another' });
    expect(messageQueueRuntime.cancelScheduledTask).toHaveBeenCalledWith('project-1', task.id);
  });

  it.each([
    { missing: false, claimed: true, consumeFails: false },
    { missing: true, claimed: true, consumeFails: false },
    { missing: false, claimed: false, consumeFails: false },
    { missing: false, claimed: true, consumeFails: true },
  ])('consumes only a claimed once attempt, missing=$missing claimed=$claimed consumeFails=$consumeFails', async ({ missing, claimed, consumeFails }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T08:00:00Z'));
    const { projectConfigRuntime, messageQueueRuntime, stored } = setup();
    if (!claimed) projectConfigRuntime.updateScheduledTaskStateIf = async () => ({ task: stored(), updated: false });
    await projectConfigRuntime.upsertScheduledTask('project-1', { ...task, schedule: { kind: 'once', date: '2026-10-07', time: '08:01', timezone: 'UTC' } });
    if (consumeFails) projectConfigRuntime.upsertScheduledTask = async () => { throw new Error('disk write failed'); };
    const warn = vi.fn();
    vi.stubGlobal('fetch', async () => missing
      ? Response.json({ name: 'NotFoundError', message: 'Not found' }, { status: 404 })
      : Response.json({ data: { id: 'ses_target', location: { directory: '/repo' } } }));
    const scheduler = createScheduledTasksRuntime({
      projectConfigRuntime, messageQueueRuntime, logger: { warn },
      listProjects: async () => [{ id: 'project-1', path: '/repo' }],
      chatsScope: { id: 'project-1', root: '/repo', contains: () => true },
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`, getOpenCodeAuthHeaders: () => ({}),
    });
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(65_000);
      expect(stored().enabled).toBe(!claimed || consumeFails);
      expect(scheduler.getStatus().enabledScheduledTasksCount).toBe(claimed && !consumeFails ? 0 : 1);
      expect(stored().state.lastStatus).toBe(claimed ? (missing ? 'failed' : 'queued') : undefined);
      expect(messageQueueRuntime.enqueue).toHaveBeenCalledTimes(claimed && !missing ? 1 : 0);
      expect(messageQueueRuntime.cancelScheduledTask).not.toHaveBeenCalled();
      if (consumeFails) expect(warn).toHaveBeenCalledWith('[ScheduledTasks] failed to consume one-time task', { projectID: 'project-1', taskID: task.id, error: 'disk write failed' });
      else expect(warn).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });
});
