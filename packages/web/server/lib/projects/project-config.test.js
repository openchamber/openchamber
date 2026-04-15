import { describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { createProjectConfigRuntime } from './project-config.js';

const createRuntime = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-scheduled-project-config-'));
  const runtime = createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: tempRoot,
    createTaskID: () => 'task-fixed-id',
  });
  return {
    runtime,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('project-config runtime', () => {
  it('creates and persists a scheduled task', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const result = await runtime.upsertScheduledTask('project-test', {
        name: 'Nightly digest',
        enabled: true,
        schedule: {
          kind: 'daily',
          time: '09:30',
          timezone: 'UTC',
        },
        execution: {
          prompt: 'Summarize repository changes',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      });

      expect(result.created).toBe(true);
      expect(result.task.id).toBe('task-fixed-id');
      const reloaded = await runtime.listScheduledTasks('project-test');
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].name).toBe('Nightly digest');
      expect(reloaded[0].schedule.timezone).toBe('UTC');
      expect(reloaded[0].schedule.times).toEqual(['09:30']);
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid cron expressions', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.upsertScheduledTask('project-test', {
        name: 'Invalid cron task',
        enabled: true,
        schedule: {
          kind: 'cron',
          cron: 'invalid cron',
          timezone: 'UTC',
        },
        execution: {
          prompt: 'Run checks',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      })).rejects.toThrow('schedule.cron is invalid');
    } finally {
      await cleanup();
    }
  });

  it('accepts one-time schedule with date and time', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const result = await runtime.upsertScheduledTask('project-test', {
        name: 'One-time review',
        enabled: true,
        schedule: {
          kind: 'once',
          date: '2026-04-20',
          time: '13:45',
          timezone: 'Europe/Kyiv',
        },
        execution: {
          prompt: 'Create a release summary',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      });

      expect(result.task.schedule.kind).toBe('once');
      expect(result.task.schedule.date).toBe('2026-04-20');
      expect(result.task.schedule.time).toBe('13:45');
      expect(result.task.schedule.timezone).toBe('Europe/Kyiv');
    } finally {
      await cleanup();
    }
  });
});
