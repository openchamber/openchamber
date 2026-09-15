import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PreflightDeniedError } from './preflight.js';
import { createScheduledTasksRuntime } from './runtime.js';

const UTC = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo, d, h, mi, s);
const HOUR = 3_600_000;

const makeTask = (schedule) => ({
  id: 'task-1',
  name: 'Daily Sync',
  enabled: true,
  schedule: { timezone: 'UTC', ...schedule },
  execution: { prompt: 'Summarize open issues', providerID: 'openai', modelID: 'gpt-4o' },
  state: { createdAt: UTC(2026, 0, 1, 0, 0, 0), updatedAt: UTC(2026, 0, 1, 0, 0, 0) },
});

const createProjectConfigRuntime = (initialTask) => {
  let currentTask = structuredClone(initialTask);

  const applyPatch = (patch) => {
    const nextState = {
      ...(currentTask.state || {}),
      ...patch,
      updatedAt: Date.now(),
    };
    for (const key of ['nextRunAt', 'lastRunAt', 'lastDurationMs', 'lastScheduledFor', 'lastError', 'lastSessionId']) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) {
        delete nextState[key];
      }
    }
    currentTask = { ...currentTask, state: nextState };
    return currentTask;
  };

  return {
    listScheduledTasks: vi.fn(async () => [structuredClone(currentTask)]),
    reconcileLoopTasks: vi.fn(async () => [structuredClone(currentTask)]),
    updateScheduledTaskState: vi.fn(async (_pid, _tid, patch) => {
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    updateScheduledTaskStateIf: vi.fn(async (_pid, _tid, predicate, patch) => {
      if (!predicate(currentTask)) {
        return { task: structuredClone(currentTask), updated: false };
      }
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    upsertScheduledTask: vi.fn(async (_pid, input) => {
      currentTask = structuredClone(input);
      return { task: structuredClone(currentTask) };
    }),
  };
};

const createRuntimeDeps = (projectConfigRuntime, preflight) => ({
  projectConfigRuntime,
  listProjects: vi.fn(async () => [{ id: 'p1', path: '/repo' }]),
  buildOpenCodeUrl: () => 'http://127.0.0.1:9999/',
  getOpenCodeAuthHeaders: () => ({}),
  waitForOpenCodeReady: async () => {},
  emitTaskRunEvent: vi.fn(),
  setSessionAutoAccept: async () => {},
  preflight,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

const denyingPreflight = (reason = 'blocked by policy') => ({
  evaluate: vi.fn(async () => {
    throw new PreflightDeniedError(reason);
  }),
});

describe('scheduled task preflight denial', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records a denied status, never creates a session, and re-arms a recurring task', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    const preflight = denyingPreflight('org policy blocked this task');
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime, preflight));
    await runtime.start();

    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(preflight.evaluate).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const [task] = await projectConfigRuntime.listScheduledTasks('p1');
    expect(task.state.lastStatus).toBe('denied');
    expect(task.state.lastError).toBe('org policy blocked this task');
    expect(task.state.lastSessionId).toBeUndefined();
    // The next daily occurrence is still armed even though this one was denied.
    expect(task.state.nextRunAt).toBe(UTC(2026, 0, 2, 15, 0, 0));

    runtime.stop();
  });

  it('leaves a denied once task enabled with no nextRunAt instead of consuming it', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 8, 0, 0));
    const projectConfigRuntime = createProjectConfigRuntime(
      makeTask({ kind: 'once', date: '2026-01-01', time: '09:00' }),
    );
    const preflight = denyingPreflight();
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime, preflight));
    await runtime.start();

    await vi.advanceTimersByTimeAsync(HOUR + 3_000);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    const [task] = await projectConfigRuntime.listScheduledTasks('p1');
    expect(task.state.lastStatus).toBe('denied');
    // A denied once task is not disabled/consumed: it stays enabled, inert
    // until a manual re-run, with no future occurrence armed.
    expect(task.enabled).toBe(true);
    expect(task.state.nextRunAt).toBeUndefined();

    runtime.stop();
  });

  it('denies a manual run without creating a session', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    const preflight = denyingPreflight('manual runs are blocked');
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime, preflight));
    await runtime.start();

    const result = await runtime.runNow('p1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.error).toBe('manual runs are blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    runtime.stop();
  });

  it('surfaces the denial reason and persistError together when the completion-state write also fails', async () => {
    vi.setSystemTime(UTC(2026, 0, 1, 14, 0, 0));
    const projectConfigRuntime = createProjectConfigRuntime(
      makeTask({ kind: 'daily', times: ['15:00'] }),
    );
    const originalUpdate = projectConfigRuntime.updateScheduledTaskState;
    projectConfigRuntime.updateScheduledTaskState = vi.fn(async (pid, tid, patch) => {
      if (patch?.lastStatus === 'denied') {
        throw new Error('timeout acquiring project config lock for p1');
      }
      return originalUpdate(pid, tid, patch);
    });
    const preflight = denyingPreflight('manual runs are blocked');
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime, preflight));
    await runtime.start();

    const result = await runtime.runNow('p1', 'task-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.reason).toBe('completion-state-failed');
    expect(result.error).toBe('manual runs are blocked');
    expect(result.persistError).toMatch(/timeout acquiring project config lock/);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    runtime.stop();
  });
});
