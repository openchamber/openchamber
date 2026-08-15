import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import {
  computeNextRunAt,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
  createScheduledTasksRuntime,
} from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });
});

describe('scheduled-tasks runtime syncProject wiring', () => {
  const createTempProject = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-loop-'));
    const repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    return {
      tempRoot,
      repoPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  };

  const createProjectConfig = async (tempRoot) => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'config'),
    createTaskID: () => 'task-fixed-id',
  });

  const createRuntimeDeps = (overrides = {}) => ({
    buildOpenCodeUrl: () => 'http://localhost',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    ...overrides,
  });

  it('reconciles discovered loops when the project path is known', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    try {
      await writeFile(path.join(repoPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
      });

      await runtime.syncProject('proj');

      const tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('loop:project:daily');
      expect(tasks[0].loopFile).toBe(path.join(repoPath, '.agents', 'loops', 'daily.md'));
      // syncTaskSchedule computed and persisted the next run for the enabled task.
      expect(tasks[0].state.nextRunAt).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('falls back to plain listing when the project path cannot be resolved', async () => {
    const { tempRoot, cleanup } = await createTempProject();
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const reconcileSpy = vi.spyOn(projectConfigRuntime, 'reconcileLoopTasks');
      const listSpy = vi.spyOn(projectConfigRuntime, 'listScheduledTasks');

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        // Project not registered -> ensureProjectPath cannot resolve a path.
        listProjects: async () => [],
      });

      await runtime.syncProject('proj');

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledWith('proj');
      expect(await projectConfigRuntime.listScheduledTasks('proj')).toEqual([]);
      reconcileSpy.mockRestore();
      listSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  const createArchiveFixture = async ({
    goalEnabled = false,
    archiveUpdate,
    archiveQuietMs = 0,
    archiveMaxWaitMs,
  } = {}) => {
    const project = await createTempProject();
    const projectConfigRuntime = await createProjectConfig(project.tempRoot);
    const created = await projectConfigRuntime.upsertScheduledTask('proj', {
      name: 'daily archive',
      enabled: true,
      schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
      execution: {
        prompt: '/test',
        providerID: 'openai',
        modelID: 'gpt-5',
        archiveOnSuccess: true,
        ...(goalEnabled ? { goalEnabled: true } : {}),
      },
    });
    const update = vi.fn(archiveUpdate ?? (async ({ time }) => ({
      data: { id: 'ses_scheduled', time },
    })));
    const client = {
      command: {
        list: vi.fn(async () => ({ data: [{ name: 'test', template: 'Run test.' }] })),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: 'ses_scheduled' } })),
        command: vi.fn(async () => ({})),
        children: vi.fn(async () => ({ data: [] })),
        get: vi.fn(async () => ({ data: null })),
        messages: vi.fn(async () => ({
          data: [{ info: { role: 'assistant', time: { completed: 1 } }, parts: [] }],
        })),
        status: vi.fn(async () => ({ data: {} })),
        update,
      },
    };
    const runtime = createScheduledTasksRuntime({
      ...createRuntimeDeps(),
      projectConfigRuntime,
      listProjects: async () => [{ id: 'proj', path: project.repoPath }],
      createClient: () => client,
      createGoal: vi.fn(async () => ({})),
      archiveQuietMs,
      archiveRetryBaseMs: 5,
      ...(Number.isFinite(archiveMaxWaitMs) ? { archiveMaxWaitMs } : {}),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await runtime.syncProject('proj');
    return {
      ...project,
      runtime,
      projectConfigRuntime,
      task: created.task,
      client,
      update,
      cleanup: async () => {
        runtime.stop();
        await project.cleanup();
      },
    };
  };

  it('archives an opted-in run after its session transitions from busy to idle', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      expect(fixture.update).not.toHaveBeenCalled();

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(() => {
        expect(fixture.update).toHaveBeenCalledWith({
          sessionID: 'ses_scheduled',
          directory: fixture.repoPath,
          time: { archived: expect.any(Number) },
        });
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('archives a completed run when lifecycle events are missed', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps archival progress across task-list synchronization', async () => {
    const fixture = await createArchiveFixture({ archiveQuietMs: 20 });
    let keepSyncing = true;
    let syncLoop;
    try {
      fixture.client.session.get.mockResolvedValue({
        data: { id: 'ses_scheduled', time: {}, metadata: {} },
      });
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      syncLoop = (async () => {
        while (keepSyncing) {
          await fixture.runtime.syncProject('proj');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce(), { timeout: 500 });
    } finally {
      keepSyncing = false;
      await syncLoop;
      await fixture.cleanup();
    }
  });

  it('keeps a new archive tracker when synchronization races with prompt dispatch', async () => {
    const fixture = await createArchiveFixture();
    let releaseCommand;
    try {
      fixture.client.session.command.mockImplementation(() => new Promise((resolve) => {
        releaseCommand = resolve;
      }));
      const runPromise = fixture.runtime.runNow('proj', fixture.task.id);
      await vi.waitFor(() => expect(fixture.client.session.command).toHaveBeenCalledOnce());

      await fixture.runtime.syncProject('proj');
      releaseCommand({});
      const result = await runPromise;
      expect(result.ok).toBe(true);

      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      releaseCommand?.({});
      await fixture.cleanup();
    }
  });

  it('keeps the run successful and records a separate warning when archival fails', async () => {
    const fixture = await createArchiveFixture({
      archiveUpdate: async () => {
        throw new Error('archive unavailable');
      },
    });
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(async () => {
        const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.lastStatus).toBe('success');
        expect(task.state.lastError).toBeUndefined();
        expect(task.state.lastArchiveError).toContain('archive unavailable');
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('retries a transient archive failure until the session is archived', async () => {
    const archiveUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('archive unavailable'))
      .mockResolvedValue({ data: { id: 'ses_scheduled', time: { archived: 1 } } });
    const fixture = await createArchiveFixture({ archiveUpdate });
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(() => expect(archiveUpdate).toHaveBeenCalledTimes(2));
      const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
      expect(task.state.pendingArchives).toBeUndefined();
      expect(task.state.lastArchiveError).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('waits for goal completion instead of archiving on an intermediate idle event', async () => {
    const fixture = await createArchiveFixture({ goalEnabled: true });
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      fixture.client.session.get.mockResolvedValue({
        data: { metadata: { openchamber: { goal: { status: 'complete' } } } },
      });

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });
      expect(fixture.update).not.toHaveBeenCalled();

      fixture.runtime.processPayload({
        type: 'session.updated',
        properties: {
          info: {
            id: 'ses_scheduled',
            metadata: { openchamber: { goal: { status: 'complete' } } },
          },
        },
      });
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves a goal run visible when its goal metadata is cleared', async () => {
    const fixture = await createArchiveFixture({ goalEnabled: true });
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      fixture.client.session.get.mockResolvedValue({ data: { metadata: {} } });

      await vi.waitFor(async () => {
        const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.pendingArchives).toBeUndefined();
      });
      expect(fixture.update).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not archive a completed goal that resumes during verification', async () => {
    const fixture = await createArchiveFixture({ goalEnabled: true });
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      let goalFetches = 0;
      let goalResumed = true;
      fixture.client.session.get.mockImplementation(async () => {
        goalFetches += 1;
        const status = goalFetches === 1 || !goalResumed ? 'complete' : 'active';
        return { data: { metadata: { openchamber: { goal: { status } } } } };
      });

      fixture.runtime.processGoalSettled({ sessionId: 'ses_scheduled', status: 'complete' });
      await vi.waitFor(() => expect(fixture.client.session.get.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(fixture.update).not.toHaveBeenCalled();

      goalResumed = false;
      fixture.runtime.processGoalSettled({ sessionId: 'ses_scheduled', status: 'complete' });
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves failed assistant runs visible instead of archiving them', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      fixture.runtime.processPayload({
        type: 'session.error',
        properties: { sessionID: 'ses_scheduled' },
      });

      await vi.waitFor(async () => {
        const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.lastStatus).toBe('error');
        expect(task.state.pendingArchives).toBeUndefined();
      });
      expect(fixture.update).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('waits for background child sessions to finish before archiving the parent', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      fixture.client.session.status.mockResolvedValue({
        data: { ses_child: { type: 'busy' } },
      });
      fixture.client.session.children.mockResolvedValue({ data: [{ id: 'ses_child' }] });

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fixture.update).not.toHaveBeenCalled();

      fixture.client.session.status.mockResolvedValue({ data: {} });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      await fixture.cleanup();
    }
  });

  it('rechecks status after reading messages before archiving', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      let resumed = true;
      let statusCalls = 0;
      fixture.client.session.status
        .mockImplementation(async () => {
          statusCalls += 1;
          return {
            data: resumed && statusCalls > 1
              ? { ses_scheduled: { type: 'busy' } }
              : {},
          };
        });

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(() => {
        expect(fixture.client.session.status.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      expect(fixture.update).not.toHaveBeenCalled();

      resumed = false;
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
      expect(fixture.client.session.status.mock.calls.length).toBeGreaterThanOrEqual(6);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps retrying completion verification after transient failures', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      fixture.client.session.status
        .mockRejectedValueOnce(new Error('status unavailable'))
        .mockRejectedValueOnce(new Error('status unavailable'))
        .mockRejectedValueOnce(new Error('status unavailable'))
        .mockResolvedValue({ data: {} });

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(async () => {
        expect(fixture.update).toHaveBeenCalledOnce();
        const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.pendingArchives).toBeUndefined();
        expect(task.state.lastArchiveError).toBeUndefined();
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps an older archive warning visible while another run succeeds', async () => {
    const fixture = await createArchiveFixture();
    try {
      await fixture.projectConfigRuntime.updateScheduledTaskState('proj', fixture.task.id, {
        lastArchiveError: 'Failed to archive an older run session',
        pendingArchives: [{
          sessionId: 'ses_older',
          directory: fixture.repoPath,
          goalEnabled: false,
        }],
      });
      fixture.client.session.status.mockResolvedValue({
        data: { ses_older: { type: 'busy' } },
      });
      await fixture.runtime.syncProject('proj');

      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      let [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
      expect(task.state.lastArchiveError).toBe('Failed to archive an older run session');

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'busy' } },
      });
      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(async () => {
        [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.pendingArchives).toEqual([{
          sessionId: 'ses_older',
          directory: fixture.repoPath,
          goalEnabled: false,
        }]);
      });
      expect(task.state.lastArchiveError).toBe('Failed to archive an older run session');
    } finally {
      await fixture.cleanup();
    }
  });

  it('resumes archival for a completed unarchived run after a server restart', async () => {
    const fixture = await createArchiveFixture({ archiveQuietMs: 1_000 });
    let restarted;
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      expect(fixture.update).not.toHaveBeenCalled();
      fixture.runtime.stop();

      fixture.client.session.get.mockResolvedValue({
        data: { id: 'ses_scheduled', time: {}, metadata: {} },
      });
      fixture.client.session.status.mockResolvedValue({ data: {} });
      restarted = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime: fixture.projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: fixture.repoPath }],
        createClient: () => fixture.client,
        archiveQuietMs: 0,
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      await restarted.syncProject('proj');
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      restarted?.stop();
      await fixture.cleanup();
    }
  });

  it('retries restart recovery after a transient pending-session fetch failure', async () => {
    const fixture = await createArchiveFixture({ archiveQuietMs: 1_000 });
    let restarted;
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      fixture.runtime.stop();
      fixture.client.session.get.mockRejectedValueOnce(new Error('session unavailable'));
      fixture.client.session.status.mockResolvedValue({ data: {} });
      restarted = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime: fixture.projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: fixture.repoPath }],
        createClient: () => fixture.client,
        archiveQuietMs: 0,
        archiveRetryBaseMs: 5,
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      await restarted.syncProject('proj');
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      restarted?.stop();
      await fixture.cleanup();
    }
  });

  it('cleans up a deleted run session instead of retrying archival', async () => {
    const fixture = await createArchiveFixture();
    try {
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);
      fixture.client.session.status.mockResolvedValue({
        error: { status: 404, message: 'session not found' },
      });

      fixture.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses_scheduled', status: { type: 'idle' } },
      });

      await vi.waitFor(async () => {
        const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.pendingArchives).toBeUndefined();
        expect(task.state.lastStatus).toBe('success');
        expect(task.state.lastArchiveError).toBeUndefined();
      });
      expect(fixture.update).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps waiting while a goal stays active past the archive wait cap', async () => {
    const fixture = await createArchiveFixture({
      goalEnabled: true,
      archiveQuietMs: 5,
      archiveMaxWaitMs: 20,
    });
    try {
      fixture.client.session.get.mockResolvedValue({
        data: { metadata: { openchamber: { goal: { status: 'active' } } } },
      });
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 60));
      const [waiting] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
      expect(waiting.state.pendingArchives?.some((record) => record.sessionId === 'ses_scheduled')).toBe(true);
      expect(waiting.state.lastArchiveError).toBeUndefined();
      expect(fixture.update).not.toHaveBeenCalled();

      fixture.client.session.get.mockResolvedValue({
        data: { metadata: { openchamber: { goal: { status: 'complete' } } } },
      });
      fixture.runtime.processGoalSettled({ sessionId: 'ses_scheduled', status: 'complete' });
      await vi.waitFor(() => expect(fixture.update).toHaveBeenCalledOnce());
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops polling a session that never becomes quiescent', async () => {
    const fixture = await createArchiveFixture({ archiveQuietMs: 5, archiveMaxWaitMs: 20 });
    try {
      fixture.client.session.messages.mockResolvedValue({
        data: [{ info: { role: 'user' }, parts: [] }],
      });
      const result = await fixture.runtime.runNow('proj', fixture.task.id);
      expect(result.ok).toBe(true);

      await vi.waitFor(async () => {
        const [task] = await fixture.projectConfigRuntime.listScheduledTasks('proj');
        expect(task.state.pendingArchives).toBeUndefined();
        expect(task.state.lastStatus).toBe('success');
        expect(task.state.lastArchiveError).toContain('did not become idle');
      });
      expect(fixture.update).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});
