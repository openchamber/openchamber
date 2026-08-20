import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createScheduledTaskService } from './service.js';
import { registerScheduledTaskRoutes } from './routes.js';

const createService = (overrides = {}) => {
  const projectConfigRuntime = {
    listScheduledTasks: vi.fn(async () => []),
    deleteScheduledTask: vi.fn(async () => ({ deleted: true, tasks: [] })),
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
      const { service } = createService({ scheduledTasksRuntime: { syncProject } });

      await expect(service.setLoopEnabled('project-test', currentTask.id, false)).resolves.toEqual(updatedTask);

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
