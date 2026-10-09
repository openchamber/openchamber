import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createScheduledTaskService } from './service.js';
import { registerScheduledTaskRoutes } from './routes.js';
import { CHATS_SCOPE_PUBLIC_ID, createChatsScope } from './chats-scope.js';
import { createScheduledTasksRuntime } from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';

const createService = (overrides = {}) => {
  const projectConfigRuntime = {
    listScheduledTasks: vi.fn(async () => []),
    deleteScheduledTask: vi.fn(async () => ({ deleted: true, tasks: [] })),
    setLoopApproval: vi.fn(async () => {}),
    ...(overrides.projectConfigRuntime || {}),
  };
  const scheduledTasksRuntime = {
    syncProject: vi.fn(async () => []),
    ...(overrides.scheduledTasksRuntime || {}),
  };
  const service = createScheduledTaskService({
    readSettingsFromDiskMigrated: async () => ({
      projects: [{ id: 'project-test', path: '/repo' }],
    }),
    sanitizeProjects: (projects) => projects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    chatsScope: overrides.chatsScope ?? null,
  });
  return { service, projectConfigRuntime, scheduledTasksRuntime };
};

const loopTask = {
  id: 'loop:project:daily-digest',
  name: 'daily-digest',
  enabled: true,
  loopFile: '/repo/.agents/loops/daily-digest.md',
  schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
  execution: { prompt: 'digest', providerID: 'openai', modelID: 'gpt-4.1' },
};

describe('scheduled-task service list', () => {
  it('reconciles loop files before returning tasks', async () => {
    const syncedTasks = [loopTask];
    const { service, projectConfigRuntime, scheduledTasksRuntime } = createService({
      scheduledTasksRuntime: {
        syncProject: vi.fn(async () => syncedTasks),
      },
    });

    await expect(service.list('project-test')).resolves.toBe(syncedTasks);
    expect(scheduledTasksRuntime.syncProject).toHaveBeenCalledOnce();
    expect(scheduledTasksRuntime.syncProject).toHaveBeenCalledWith('project-test');
    expect(projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();
  });

  it('surfaces reconciliation failure instead of returning a stale list', async () => {
    const syncError = new Error('loop reconciliation failed');
    const { service, projectConfigRuntime } = createService({
      scheduledTasksRuntime: {
        syncProject: vi.fn(async () => {
          throw syncError;
        }),
      },
    });

    await expect(service.list('project-test')).rejects.toBe(syncError);
    expect(projectConfigRuntime.listScheduledTasks).not.toHaveBeenCalled();
  });
});

describe('scheduled-task loop-file mutations', () => {
  it('updates only enabled in loop frontmatter and reconciles the task', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-toggle-'));
    try {
      const loopFilePath = path.join(tempRoot, 'daily.md');
      await writeFile(loopFilePath, `---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
custom: keep-me
---

Run the digest.
`, 'utf8');
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const updatedTask = { ...currentTask, enabled: false };
      const syncProject = vi.fn()
        .mockResolvedValueOnce([currentTask])
        .mockResolvedValueOnce([updatedTask]);
      const { service, projectConfigRuntime } = createService({ scheduledTasksRuntime: { syncProject } });

      await expect(service.setLoopEnabled('project-test', currentTask.id, false)).resolves.toEqual(updatedTask);
      // Turning a loop off withdraws this machine's approval of it.
      expect(projectConfigRuntime.setLoopApproval).toHaveBeenCalledWith('project-test', loopFilePath, null);

      const content = await readFile(loopFilePath, 'utf8');
      expect(content).toContain('enabled: false');
      expect(content).toContain('custom: keep-me');
      expect(content).toContain('Run the digest.');
      expect(syncProject).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('deletes the authoritative loop file and reconciles the task away', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-remove-'));
    try {
      const loopFilePath = path.join(tempRoot, 'daily.md');
      await writeFile(loopFilePath, 'loop', 'utf8');
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const syncProject = vi.fn()
        .mockResolvedValueOnce([currentTask])
        .mockResolvedValueOnce([]);
      const { service } = createService({ scheduledTasksRuntime: { syncProject } });

      await expect(service.removeLoopFile('project-test', currentTask.id)).resolves.toEqual([]);
      await expect(readFile(loopFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(syncProject).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not rewrite a malformed loop when toggling', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-invalid-'));
    try {
      const loopFilePath = path.join(tempRoot, 'daily.md');
      const malformed = '---\nname: daily-digest\n---\nRun.\n';
      await writeFile(loopFilePath, malformed, 'utf8');
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const syncProject = vi.fn(async () => [currentTask]);
      const { service } = createService({ scheduledTasksRuntime: { syncProject } });

      await expect(service.setLoopEnabled('project-test', currentTask.id, false)).rejects.toMatchObject({ statusCode: 400 });
      await expect(readFile(loopFilePath, 'utf8')).resolves.toBe(malformed);
      expect(syncProject).toHaveBeenCalledOnce();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('scheduled-task loop-file routes', () => {
  const createResponse = () => ({
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  });

  const captureHandlers = (scheduledTaskService) => {
    const handlers = new Map();
    const app = {
      get: vi.fn(),
      put: vi.fn(),
      post: vi.fn(),
      patch: vi.fn((route, handler) => handlers.set(`PATCH ${route}`, handler)),
      delete: vi.fn((route, handler) => handlers.set(`DELETE ${route}`, handler)),
    };
    registerScheduledTaskRoutes(app, {
      scheduledTaskService,
      readSettingsFromDiskMigrated: vi.fn(),
      sanitizeProjects: vi.fn(),
      projectConfigRuntime: {},
      scheduledTasksRuntime: {},
      getOpenChamberEventClients: () => new Set(),
      writeSseEvent: vi.fn(),
    });
    return handlers;
  };

  it('routes loop enabled changes through the loop-file service', async () => {
    const setLoopEnabled = vi.fn(async () => ({ ...loopTask, enabled: false }));
    const handlers = captureHandlers({ setLoopEnabled });
    const handler = handlers.get('PATCH /api/projects/:projectId/scheduled-tasks/:taskId/loop-file');
    const res = createResponse();

    await handler({ params: { projectId: 'project-test', taskId: loopTask.id }, body: { enabled: false } }, res);

    expect(setLoopEnabled).toHaveBeenCalledWith('project-test', loopTask.id, false);
    expect(res.statusCode).toBe(200);
    expect(res.payload.task.enabled).toBe(false);
  });

  it('routes loop deletion through the loop-file service', async () => {
    const removeLoopFile = vi.fn(async () => []);
    const handlers = captureHandlers({ removeLoopFile });
    const handler = handlers.get('DELETE /api/projects/:projectId/scheduled-tasks/:taskId/loop-file');
    const res = createResponse();

    await handler({ params: { projectId: 'project-test', taskId: loopTask.id } }, res);

    expect(removeLoopFile).toHaveBeenCalledWith('project-test', loopTask.id);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ tasks: [] });
  });
});

describe('scheduled-task service remove', () => {
  it('rejects deleting a loop-sourced task while its loop file still exists', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-delete-'));
    try {
      const loopFilePath = path.join(tempRoot, 'daily.md');
      await writeFile(loopFilePath, '---\nname: daily-digest\n---\nRun.\n', 'utf8');

      const { service, projectConfigRuntime, scheduledTasksRuntime } = createService({
        projectConfigRuntime: {
          listScheduledTasks: vi.fn(async () => [{ ...loopTask, loopFile: loopFilePath }]),
        },
      });

      await expect(service.remove('project-test', loopTask.id)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('delete the file to remove the task'),
      });
      expect(projectConfigRuntime.deleteScheduledTask).not.toHaveBeenCalled();
      expect(scheduledTasksRuntime.syncProject).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows deleting a loop-sourced task once its loop file is gone', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-delete-'));
    try {
      // The loop file was removed from disk; the orphan task is allowed to be
      // deleted directly instead of waiting for the next reconcile.
      const loopFilePath = path.join(tempRoot, 'gone.md');

      const { service, projectConfigRuntime, scheduledTasksRuntime } = createService({
        projectConfigRuntime: {
          listScheduledTasks: vi.fn(async () => [{ ...loopTask, loopFile: loopFilePath }]),
        },
      });

      const tasks = await service.remove('project-test', loopTask.id);

      expect(projectConfigRuntime.deleteScheduledTask).toHaveBeenCalledWith('project-test', loopTask.id);
      expect(scheduledTasksRuntime.syncProject).toHaveBeenCalled();
      expect(Array.isArray(tasks)).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('deletes JSON-configured tasks normally', async () => {
    const jsonTask = { ...loopTask, id: 'json-task', loopFile: undefined };
    const { service, projectConfigRuntime, scheduledTasksRuntime } = createService({
      projectConfigRuntime: {
        listScheduledTasks: vi.fn(async () => [jsonTask]),
        deleteScheduledTask: vi.fn(async () => ({ deleted: true, tasks: [] })),
      },
    });

    const tasks = await service.remove('project-test', jsonTask.id);

    expect(projectConfigRuntime.deleteScheduledTask).toHaveBeenCalledWith('project-test', jsonTask.id);
    expect(scheduledTasksRuntime.syncProject).toHaveBeenCalled();
    expect(Array.isArray(tasks)).toBe(true);
  });
});

describe('scheduled-task service run', () => {
  it('forwards persistError when the runtime reports a completion persist failure', async () => {
    const { service } = createService({
      scheduledTasksRuntime: {
        runNow: vi.fn(async () => ({
          ok: true,
          sessionID: 'sess-1',
          task: { id: 'task-1', state: { lastStatus: 'success' } },
          persistError: 'timeout acquiring project config lock for project-test',
          reason: 'completion-state-failed',
        })),
      },
    });

    const result = await service.run('project-test', 'task-1');
    expect(result.sessionId).toBe('sess-1');
    expect(result.persistError).toMatch(/timeout acquiring project config lock/);
  });
});

describe('scheduled-task service chats scope', () => {
  const chatsScope = createChatsScope('/home/user/.config/openchamber/chats');

  it('keys the chats id the UI sends by the chats root storage id', async () => {
    const { service, scheduledTasksRuntime } = createService({
      chatsScope,
      scheduledTasksRuntime: {
        syncProject: vi.fn(async () => []),
        runNow: vi.fn(async () => ({ ok: true, sessionID: 'ses_chat', directory: '/chat/dir' })),
      },
    });

    await service.list(CHATS_SCOPE_PUBLIC_ID);
    expect(scheduledTasksRuntime.syncProject).toHaveBeenCalledWith(chatsScope.id);
    await expect(service.run(CHATS_SCOPE_PUBLIC_ID, 'task-1')).resolves.toMatchObject({
      sessionId: 'ses_chat',
      directory: '/chat/dir',
    });
    expect(scheduledTasksRuntime.runNow).toHaveBeenCalledWith(chatsScope.id, 'task-1');
    expect(chatsScope.id).not.toContain(':');
  });

  it('resolves a directory inside a chat to the chats scope, and projects first', async () => {
    const { service } = createService({ chatsScope });

    await expect(service.resolveProjectID({ directory: `${chatsScope.root}/2026-09-30/session-a` })).resolves.toBe(chatsScope.id);
    await expect(service.resolveProjectID({ directory: '/repo' })).resolves.toBe('project-test');
    await expect(service.resolveProjectID({ directory: `${chatsScope.root}-other/session-a` })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects the chats id when the server has no chats scope', async () => {
    const { service } = createService();

    await expect(service.list(CHATS_SCOPE_PUBLIC_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records approval of the exact loop version when the user enables it', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-approve-'));
    try {
      const loopFilePath = path.join(tempRoot, 'daily.md');
      await writeFile(loopFilePath, `---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---

Run the digest.
`, 'utf8');
      const currentTask = { ...loopTask, loopFile: loopFilePath };
      const syncProject = vi.fn(async () => [currentTask]);
      const { service, projectConfigRuntime } = createService({ scheduledTasksRuntime: { syncProject } });

      await service.setLoopEnabled('project-test', currentTask.id, true);

      expect(projectConfigRuntime.setLoopApproval).toHaveBeenCalledWith('project-test', loopFilePath, expect.stringMatching(/^[0-9a-f]{64}$/));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

// The agent tool and the CLI enable and disable through setEnabled; these run
// it against the real project config and scheduler, as the server does.
describe('scheduled-task service setEnabled on loop tasks', () => {
  const loopFileContent = (name, enabled, prompt = `Run ${name}.`) => `---
name: ${name}
schedule: "0 9 * * *"
enabled: ${enabled}
model: openai/gpt-5
---
${prompt}
`;

  let tempRoot;
  let repoPath;
  let repoLoop;
  let userLoop;
  let service;
  let projectConfigRuntime;
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-loop-set-enabled-'));
    // User-scope loops live under the home directory.
    const home = path.join(tempRoot, 'home');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    await mkdir(path.join(home, '.agents', 'loops'), { recursive: true });
    repoLoop = path.join(repoPath, '.agents', 'loops', 'repo.md');
    userLoop = path.join(home, '.agents', 'loops', 'mine.md');
    await writeFile(repoLoop, loopFileContent('repo-loop', true), 'utf8');
    await writeFile(userLoop, loopFileContent('my-loop', false), 'utf8');

    projectConfigRuntime = createProjectConfigRuntime({
      fsPromises: await import('fs/promises'),
      path,
      projectsDirPath: path.join(tempRoot, 'config'),
      createTaskID: () => 'task-fixed-id',
    });
    const listProjects = async () => [{ id: 'proj', path: repoPath }];
    const scheduledTasksRuntime = createScheduledTasksRuntime({
      buildOpenCodeUrl: () => 'http://localhost',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      projectConfigRuntime,
      listProjects,
    });
    service = createScheduledTaskService({
      readSettingsFromDiskMigrated: async () => ({ projects: await listProjects() }),
      sanitizeProjects: (projects) => projects,
      projectConfigRuntime,
      scheduledTasksRuntime,
    });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedHome)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  const stored = async (taskID) => (await projectConfigRuntime.listScheduledTasks('proj')).find((task) => task.id === taskID);
  const listed = async (taskID) => (await service.list('proj')).find((task) => task.id === taskID);

  it('refuses to enable a repository loop and changes nothing', async () => {
    expect(await listed('loop:project:repo-loop')).toMatchObject({ enabled: false, loopApproval: 'required' });

    await expect(service.setEnabled('proj', 'loop:project:repo-loop', true)).rejects.toMatchObject({
      statusCode: 409,
      message: '"repo-loop" comes from this repository. Enable it in Scheduled tasks.',
    });

    expect((await stored('loop:project:repo-loop')).enabled).toBe(false);
    expect(await readFile(repoLoop, 'utf8')).toBe(loopFileContent('repo-loop', true));
    expect(await listed('loop:project:repo-loop')).toMatchObject({ enabled: false, loopApproval: 'required' });
  });

  it('leaves a held-back repository loop file alone when asked to disable it', async () => {
    await expect(service.setEnabled('proj', 'loop:project:repo-loop', false)).resolves.toMatchObject({ enabled: false });

    expect(await readFile(repoLoop, 'utf8')).toBe(loopFileContent('repo-loop', true));
    expect(await listed('loop:project:repo-loop')).toMatchObject({ enabled: false, loopApproval: 'required' });
  });

  it('disables a repository loop the user enabled, and it stays disabled', async () => {
    await service.setLoopEnabled('proj', 'loop:project:repo-loop', true);
    const enabled = await listed('loop:project:repo-loop');
    expect(enabled.enabled).toBe(true);
    expect(enabled.loopApproval).toBeUndefined();

    await expect(service.setEnabled('proj', 'loop:project:repo-loop', false)).resolves.toMatchObject({ enabled: false });

    const disabled = await listed('loop:project:repo-loop');
    expect(disabled.enabled).toBe(false);
    // Paused by the user: nothing to explain on the card.
    expect(disabled.loopApproval).toBeUndefined();
    expect(await readFile(repoLoop, 'utf8')).toContain('enabled: false');
    // And the agent cannot turn it back on.
    await expect(service.setEnabled('proj', 'loop:project:repo-loop', true)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('says a repository loop changed since the user enabled it', async () => {
    await service.setLoopEnabled('proj', 'loop:project:repo-loop', true);
    await writeFile(repoLoop, loopFileContent('repo-loop', true, 'Run something else.'), 'utf8');

    expect(await listed('loop:project:repo-loop')).toMatchObject({ enabled: false, loopApproval: 'outdated' });
    expect((await stored('loop:project:repo-loop')).loopApproval).toBeUndefined();
    await expect(service.setEnabled('proj', 'loop:project:repo-loop', true)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('enables and disables a loop from the user folder', async () => {
    await expect(service.setEnabled('proj', 'loop:user:my-loop', true)).resolves.toMatchObject({ enabled: true });
    expect((await stored('loop:user:my-loop')).enabled).toBe(true);
    expect(await readFile(userLoop, 'utf8')).toContain('enabled: true');

    await expect(service.setEnabled('proj', 'loop:user:my-loop', false)).resolves.toMatchObject({ enabled: false });
    expect((await stored('loop:user:my-loop')).enabled).toBe(false);
    expect(await readFile(userLoop, 'utf8')).toContain('enabled: false');
  });
});
