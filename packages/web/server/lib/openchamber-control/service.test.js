import { describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createOpenChamberControlService } from './service.js';

const createService = (overrides = {}) => {
  const client = {
    session: {
      list: vi.fn(async () => ({ data: [] })),
      active: vi.fn(async () => ({})),
    },
    message: {
      list: vi.fn(async () => ({ data: [] })),
    },
  };
  const sessionService = {
    create: vi.fn(async () => ({ sessionId: 'ses_1', directory: '/repo', promptDispatched: false })),
    send: vi.fn(),
    fork: vi.fn(),
  };
  const scheduledTaskService = {
    status: vi.fn(async () => ({ enabledScheduledTasksCount: 0 })),
    resolveProjectID: vi.fn(async () => 'project-1'),
    list: vi.fn(async () => []),
    upsert: vi.fn(),
    run: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
  };
  const service = createOpenChamberControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => ({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
      defaultModel: 'provider/model',
      favoriteModels: [],
      recentModels: [],
    })),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
    waitForOpenCodeReady: vi.fn(),
    createClient: vi.fn(() => client),
    sessionService,
    scheduledTaskService,
    ...overrides,
  });
  return { service, client, sessionService, scheduledTaskService };
};

describe('OpenChamber control service', () => {
  it('serves project and model projections without an HTTP or CLI round trip', async () => {
    const { service } = createService();
    await expect(service.execute('projects.list')).resolves.toEqual({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
    });
    await expect(service.execute('models.list')).resolves.toEqual(expect.objectContaining({
      defaultModel: 'provider/model',
      favoriteModels: [],
    }));
  });

  it('maps schedule creation into the shared scheduled-task service', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.upsert.mockResolvedValue({ task: { id: 'task-1' }, created: true });
    await expect(service.execute('schedule.create', {
      directory: '/repo',
      name: 'Daily',
      prompt: 'Run checks',
      model: 'provider/model',
      daily: ' 09:00 ',
      goal: true,
      goalTokenBudget: 5000,
    })).resolves.toEqual({ task: { id: 'task-1' }, created: true });
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: undefined, directory: '/repo' });
    expect(scheduledTaskService.upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      name: 'Daily',
      schedule: { kind: 'daily', times: ['09:00'] },
      execution: expect.objectContaining({ providerID: 'provider', modelID: 'model', goalEnabled: true, goalTokenBudget: 5000 }),
    }));
  });

  it('does not combine an explicit schedule project with the tool context directory', async () => {
    const { service, scheduledTaskService } = createService();
    await service.execute('schedule.list', { projectId: ' project-1 ' }, '/current-session');
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: 'project-1', directory: undefined });
  });

  it('includes scheduler status alongside listed tasks', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.list.mockResolvedValue([{ id: 'task-1' }]);
    await expect(service.execute('schedule.list', {}, '/repo')).resolves.toEqual({
      scheduler: { enabledScheduledTasksCount: 0 },
      tasks: [{ id: 'task-1' }],
    });
  });

  it('toggles a scheduled task through the required disabled boolean', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.setEnabled.mockResolvedValue({ id: 'task-1', enabled: false });
    await expect(service.execute('schedule.toggle', { taskId: 'task-1' }, '/repo')).rejects.toThrow('disabled is required for schedule.toggle');
    await expect(service.execute('schedule.toggle', { taskId: 'task-1', disabled: true }, '/repo')).resolves.toEqual({
      task: { id: 'task-1', enabled: false },
      enabled: false,
    });
    expect(scheduledTaskService.setEnabled).toHaveBeenCalledWith('project-1', 'task-1', false);
  });

  it('returns an actionable taskId error before resolving schedule scope', async () => {
    const { service, scheduledTaskService } = createService();
    await expect(service.execute('schedule.run', {}, '/repo')).rejects.toThrow('taskId is required');
    expect(scheduledTaskService.resolveProjectID).not.toHaveBeenCalled();
    expect(scheduledTaskService.run).not.toHaveBeenCalled();
  });

  it('validates wait modifiers before creating a session', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.create', { directory: '/repo', timeout: 30 })).rejects.toThrow('timeout requires wait');
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('uses the tool context directory for session actions', async () => {
    const { service, sessionService } = createService();
    await service.execute('session.create', { title: 'From tool' }, '/repo');
    expect(sessionService.create).toHaveBeenCalledWith({ directory: '/repo', title: 'From tool' });
  });

  it.each([
    ['session.send', 'send'],
    ['session.fork', 'fork'],
  ])('delegates %s directly to the session service', async (action, method) => {
    const { service, sessionService } = createService();
    sessionService[method].mockResolvedValue({ sessionId: 'ses_1', directory: '/repo' });

    await service.execute(action, { sessionId: 'ses_1', directory: '/repo', prompt: 'Continue' });

    expect(sessionService[method]).toHaveBeenCalledWith('ses_1', { directory: '/repo', prompt: 'Continue' });
  });

  it('resolves the target session directory from the global session list when send omits it', async () => {
    const { service, sessionService, client } = createService();
    client.session.list.mockResolvedValue({
      data: [
        { id: 'ses_other', location: { directory: '/repo/worktrees/other' } },
        { id: 'ses_target', location: { directory: '/repo/worktrees/target' } },
      ],
    });
    sessionService.send.mockResolvedValue({ sessionId: 'ses_target', directory: '/repo/worktrees/target', promptDispatched: true });

    await service.execute('session.send', { sessionId: 'ses_target', prompt: 'Continue' }, '/repo');

    expect(sessionService.send).toHaveBeenCalledWith('ses_target', { directory: '/repo/worktrees/target', prompt: 'Continue' });
  });

  it('falls back to the context directory when the session is not in the global list', async () => {
    const { service, sessionService } = createService();
    sessionService.send.mockResolvedValue({ sessionId: 'ses_unknown', directory: '/repo', promptDispatched: true });

    await service.execute('session.send', { sessionId: 'ses_unknown', prompt: 'Continue' }, '/repo');

    expect(sessionService.send).toHaveBeenCalledWith('ses_unknown', { directory: '/repo', prompt: 'Continue' });
  });

  it('waits past initial idle until a completed assistant result appears', async () => {
    let timestamp = 1000;
    const { service, client, sessionService } = createService({
      now: () => timestamp,
      sleep: async (duration) => { timestamp += duration; },
    });
    sessionService.create.mockResolvedValue({
      sessionId: 'ses_1',
      directory: '/repo',
      promptDispatched: true,
      baselineAssistantMessageId: 'msg_old',
    });
    client.session.active.mockResolvedValue({});
    client.message.list
      .mockResolvedValueOnce({ data: [{ id: 'msg_old', type: 'assistant', time: { completed: 900 }, content: [{ type: 'text', text: 'old' }] }] })
      .mockResolvedValueOnce({ data: [{ id: 'msg_new', type: 'assistant', time: { completed: 1500 }, content: [{ type: 'text', text: 'done' }] }] })
      .mockResolvedValueOnce({ data: [{ id: 'msg_new', type: 'assistant', time: { completed: 1500 }, content: [{ type: 'text', text: 'done' }] }] });

    await expect(service.execute('session.create', {
      directory: '/repo',
      prompt: 'work',
      wait: true,
      lastAssistant: true,
      timeout: 2,
    })).resolves.toEqual(expect.objectContaining({
      sessionStatus: { type: 'idle' },
      lastAssistantMessage: expect.objectContaining({ id: 'msg_new', text: 'done' }),
    }));
    expect(client.session.active).toHaveBeenCalledTimes(2);
  });

  it('filters sessions archived in OpenChamber state and adds global statuses', async () => {
    const { service, client } = createService({
      archiveStore: { isArchived: (id) => (id === 'ses_archived' ? 100 : null) },
    });
    client.session.list.mockResolvedValue({ data: [
      { id: 'ses_active', location: { directory: '/repo' }, time: {} },
      { id: 'ses_archived', location: { directory: '/repo' }, time: {} },
      { id: 'ses_other', location: { directory: '/other' }, time: {} },
    ] });
    client.session.active.mockResolvedValue({ ses_active: { type: 'running' } });

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [
        { id: 'ses_active', location: { directory: '/repo' }, time: {}, status: { type: 'busy' } },
        { id: 'ses_other', location: { directory: '/other' }, time: {}, status: { type: 'idle' } },
      ],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('reports unknown status when the active-session read fails', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({ data: [{ id: 'ses_active', location: { directory: '/repo' }, time: {} }] });
    client.session.active.mockRejectedValue(new Error('unavailable'));

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [{ id: 'ses_active', location: { directory: '/repo' }, time: {}, status: { type: 'unknown' } }],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('names limit in positive-integer validation errors', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.list', { limit: 0 })).rejects.toThrow('limit must be a positive integer');
    expect(client.session.list).not.toHaveBeenCalled();
  });

  it('projects only ordered text content from session messages', async () => {
    const { service, client } = createService();
    client.message.list.mockResolvedValue({ data: [
      {
        id: 'msg_assistant', type: 'assistant', model: { providerID: 'openai', id: 'gpt-5.4-mini' }, time: { created: 20, completed: 30 },
        content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'First ' }, { type: 'tool' }, { type: 'text', text: 'answer' }],
      },
      { id: 'msg_user', type: 'user', time: { created: 10 }, text: 'Question' },
      { id: 'msg_tool', type: 'assistant', time: { created: 15 }, content: [{ type: 'tool' }] },
    ] });

    await expect(service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      all: true,
    })).resolves.toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      sessionStatus: { type: 'idle' },
      messages: [
        { id: 'msg_user', role: 'user', createdAt: 10, completedAt: null, model: null, text: 'Question' },
        { id: 'msg_assistant', role: 'assistant', createdAt: 20, completedAt: 30, model: 'openai/gpt-5.4-mini', text: 'First answer' },
      ],
    });
  });

  it('rejects actions outside the fixed contract', async () => {
    const { service } = createService();
    await expect(service.execute('session.delete')).rejects.toThrow('Unsupported OpenChamber action');
  });
});

describe('file.open', () => {
  it('hands the path, the session directory and the session to the file viewer', async () => {
    const request = vi.fn(async () => ({ path: '/repo/out.csv', size: 3, opened: true }));
    const { service } = createService({ fileOpen: { request } });

    const result = await service.execute('file.open', { path: 'out.csv' }, '/repo', { contextSessionId: 'ses_1' });

    expect(request).toHaveBeenCalledWith({ path: 'out.csv', directory: '/repo', sessionId: 'ses_1' });
    expect(result).toEqual({ path: '/repo/out.csv', size: 3, opened: true });
  });

  it('lets an explicit directory win over the session directory', async () => {
    const request = vi.fn(async () => ({ path: '/other/out.csv', size: 3, opened: true }));
    const { service } = createService({ fileOpen: { request } });

    await service.execute('file.open', { path: 'out.csv', directory: '/other' }, '/repo');

    expect(request).toHaveBeenCalledWith({ path: 'out.csv', directory: '/other', sessionId: null });
  });

  it('answers 503 when this server has no file viewer wired', async () => {
    const { service } = createService({});
    await expect(service.execute('file.open', { path: 'out.csv' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('notify.send', () => {
  it('sends the notice for the calling session and returns what was delivered', async () => {
    const notifyUser = vi.fn(async () => ({ status: 200, body: { delivered: true } }));
    const { service } = createService({ notifyUser });

    const result = await service.execute('notify.send', { title: 'Done', body: 'All green', showWhenFocused: true }, '/repo', { contextSessionId: 'ses_1' });

    expect(notifyUser).toHaveBeenCalledWith({ title: 'Done', body: 'All green', showWhenFocused: true, sessionId: 'ses_1', directory: '/repo' });
    expect(result).toEqual({ delivered: true });
  });

  it('turns a refused notice into an error the agent can read', async () => {
    const notifyUser = vi.fn(async () => ({ status: 429, retryAfter: 4, body: { error: 'too many notifications' } }));
    const { service } = createService({ notifyUser });

    await expect(service.execute('notify.send', { title: 'Done' }, '/repo'))
      .rejects.toMatchObject({ statusCode: 429, message: 'too many notifications' });
  });

  it('answers 503 when this server has no notifier wired', async () => {
    const { service } = createService({});
    await expect(service.execute('notify.send', { title: 'Done' }, '/repo')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('browser capture', () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const createBrowserService = async (capture) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-capture-'));
    const request = vi.fn(async () => capture);
    const { service } = createService({ browserControl: { request } });
    return { service, directory, request };
  };

  it('saves the image beside the code and hands back a path the answer can use', async () => {
    const { service, directory } = await createBrowserService({
      base64: pixel,
      mime: 'image/png',
      url: 'http://localhost:3000/',
      title: 'App',
      viewport: { mode: 'mobile', width: 390, height: 844 },
      width: 390,
      height: 844,
    });

    const result = await service.execute('browser.capture', { label: 'After fix' }, directory);

    expect(result.path.startsWith('.openchamber/screenshots/after-fix-')).toBe(true);
    expect(result.path.endsWith('.png')).toBe(true);
    expect(result.url).toBe('http://localhost:3000/');
    expect(result.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    // The bytes stay on disk; a tool result is not a place to carry an image.
    expect('base64' in result).toBe(false);
    const written = await fs.readFile(path.join(directory, result.path));
    expect(written.length > 0).toBe(true);
  });

  it('tells the agent how to actually show the image', async () => {
    const { service, directory } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    const result = await service.execute('browser.capture', {}, directory);
    expect(result.hint).toContain(`![](${result.path})`);
  });

  it('refuses to capture with no project to save into', async () => {
    const { service } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await expect(service.execute('browser.capture', {})).rejects.toThrow(/directory is required/);
  });

  it('passes the tab the agent named to the browser', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { tabId: ' tab-2 ' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { tabId: 'tab-2' }, expect.anything());
  });

  it('passes a label through to the browser and leaves other actions untouched', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { label: 'before' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { label: 'before' }, expect.anything());
  });

  it('tells the browser which project and chat the action came from', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', {}, directory, { contextSessionId: 'ses_1' });
    expect(request).toHaveBeenCalledWith('browser.capture', {}, expect.objectContaining({
      context: { directory, sessionId: 'ses_1' },
    }));
    await service.execute('browser.capture', {}, directory);
    expect(request).toHaveBeenLastCalledWith('browser.capture', {}, expect.objectContaining({
      context: { directory, sessionId: null },
    }));
  });
});
