import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createScheduledTaskService } from './service.js';

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
