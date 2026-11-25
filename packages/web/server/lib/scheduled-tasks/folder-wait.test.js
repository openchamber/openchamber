import { afterEach, describe, expect, it, vi } from 'vitest';
import fsPromises, { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTasksRuntime } from './runtime.js';

const PAST = { kind: 'once', date: '2026-01-02', time: '03:04', timezone: 'UTC' };
const DUE = Date.UTC(2026, 0, 2, 3, 4);
const cleanups = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const setUp = async ({ offline = true, sessionFails = false, schedule = PAST, waiting = true } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-folder-wait-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const store = createProjectConfigRuntime({ fsPromises, path, projectsDirPath: root });
  const { task } = await store.upsertScheduledTask('proj', {
    name: 'Report', enabled: true, schedule, execution: { prompt: 'Write it', providerID: 'openai', modelID: 'gpt-5' },
  });
  if (waiting) await store.updateScheduledTaskState('proj', task.id, { waitingForFolder: DUE, lastStatus: 'queued', lastError: 'offline' });
  const state = { offline, sessionFails, checks: 0, flips: 0, prompts: 0, witnessed: 0, events: [] };
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    if (init.method === 'POST' && pathname === '/api/session') {
      if (state.onCreate) state.onCreate();
      if (state.sessionFails) return Response.json({ error: 'refused' }, { status: 500 });
    }
    if (pathname.endsWith('/prompt')) {
      const { text } = JSON.parse(input instanceof Request ? await input.text() : init.body);
      if (text === 'Witness') state.witnessed += 1;
      else state.prompts += 1;
    }
    const data = pathname === '/api/session' ? { id: 'ses_run' } : pathname === '/api/command' ? [] : {};
    return Response.json({ location: { directory: '/repo' }, data });
  }));
  const start = async () => {
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: store,
      listProjects: async () => [{ id: 'proj', path: root }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      readSessionMetadata: async () => ({}),
      isFolderUnreachable: async () => {
        state.checks += 1;
        await state.onCheck?.();
        if (state.flips > 0) {
          state.flips -= 1;
          return state.flips % 2 === 0;
        }
        return state.offline;
      },
      folderRecheckMs: 20,
      emitTaskRunEvent: (event) => state.events.push(event.status),
      logger: { info: () => {}, warn: () => {} },
    });
    cleanups.push(() => runtime.stop());
    await runtime.start();
    return runtime;
  };
  const stored = async () => (await store.listScheduledTasks('proj')).find((entry) => entry.id === task.id);
  const checksAgain = async () => {
    const before = state.checks;
    await expect.poll(() => state.checks).toBeGreaterThan(before + 2);
  };
  const witness = async () => {
    const { task: second } = await store.upsertScheduledTask('proj', {
      name: 'Witness', enabled: true, schedule: PAST, execution: { prompt: 'Witness', providerID: 'openai', modelID: 'gpt-5' },
    });
    await store.updateScheduledTaskState('proj', second.id, { waitingForFolder: DUE, lastStatus: 'queued' });
  };
  const witnessRan = () => expect.poll(() => state.witnessed).toBe(1);
  return { store, task, state, start, stored, checksAgain, witness, witnessRan };
};

describe('one-time tasks whose folder does not answer', () => {
  it('stays armed over a restart, then runs once', async () => {
    const { state, start, stored, checksAgain } = await setUp();
    const first = await start();
    await checksAgain();
    expect(await stored()).toMatchObject({ enabled: true, state: { lastStatus: 'queued', waitingForFolder: DUE } });
    first.stop();

    await start();
    await checksAgain();
    expect(state.prompts).toBe(0);
    state.offline = false;
    await expect.poll(async () => (await stored()).state.lastStatus).toBe('sent');
    expect(state.prompts).toBe(1);
    expect((await stored()).enabled).toBe(false);
    expect((await stored()).state.waitingForFolder).toBeUndefined();
    expect((await stored()).state.lastError).toBeUndefined();
  });

  it('runs once while the folder comes and goes, and not again after another restart', async () => {
    const { state, start, stored, witness, witnessRan } = await setUp({ offline: false });
    state.flips = 13;
    const runtime = await start();
    await expect.poll(async () => (await stored()).state.lastStatus).toBe('sent');
    runtime.stop();
    await witness();
    await start();
    await witnessRan();
    expect(state.prompts).toBe(1);
  });

  it('runs once when two servers share the task', async () => {
    const { state, start, stored, witness, witnessRan } = await setUp();
    const [first] = await Promise.all([start(), start()]);
    state.offline = false;
    await expect.poll(async () => (await stored()).state.lastStatus).toBe('sent');
    await witness();
    await first.syncProject('proj');
    await witnessRan();
    expect(state.prompts).toBe(1);
  });

  it('counts a manual run as the run it was waiting for', async () => {
    const { state, start, stored, checksAgain, task, witness, witnessRan } = await setUp();
    const runtime = await start();
    expect(await runtime.runNow('proj', task.id)).toMatchObject({ ok: false, statusCode: 503 });
    expect(await stored()).toMatchObject({ enabled: true, state: { lastStatus: 'queued', waitingForFolder: DUE } });
    await checksAgain();
    state.offline = false;
    await Promise.all([runtime.runNow('proj', task.id), runtime.runNow('proj', task.id)]);
    await expect.poll(async () => (await stored()).enabled).toBe(false);
    await witness();
    await runtime.syncProject('proj');
    await witnessRan();
    expect(state.prompts).toBe(1);
  });

  it.each([
    ['moved to another time', { schedule: { ...PAST, date: '2099-01-02' } }],
    ['made recurring', { schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' } }],
    ['paused', { enabled: false }],
  ])('stops waiting when it is %s', async (_name, change) => {
    const { store, state, start, stored, checksAgain, witness, witnessRan } = await setUp();
    const runtime = await start();
    await checksAgain();
    await witness();
    await store.upsertScheduledTask('proj', { ...await stored(), ...change });
    await runtime.syncProject('proj');
    state.offline = false;
    await witnessRan();
    expect(state.prompts).toBe(0);
    expect((await stored()).state).toMatchObject({ lastStatus: 'idle' });
    expect((await stored()).state.waitingForFolder).toBeUndefined();
    expect((await stored()).state.lastError).toBeUndefined();
  });

  it('keeps waiting with the new prompt when only the prompt changes, and a save made from an old copy never runs it again', async () => {
    const { store, state, start, stored, checksAgain, witness, witnessRan } = await setUp();
    const runtime = await start();
    await checksAgain();
    const old = await stored();
    await store.upsertScheduledTask('proj', { ...old, execution: { ...old.execution, prompt: 'Changed' } });
    await runtime.syncProject('proj');
    state.offline = false;
    await expect.poll(async () => (await stored()).enabled).toBe(false);
    await store.upsertScheduledTask('proj', old);
    await witness();
    await runtime.syncProject('proj');
    await witnessRan();
    expect(state.prompts).toBe(1);
  });

  it.each([
    ['moved', { ...PAST, date: '2099-01-02' }],
    ['made daily', { kind: 'daily', times: ['03:04'], timezone: 'UTC' }],
  ])('does not run when it is %s while the folder is being checked', async (_name, schedule) => {
    const { store, state, start, stored, task, witness, witnessRan } = await setUp();
    const runtime = await start();
    await witness();
    state.offline = false;
    state.onCheck = async () => {
      state.onCheck = undefined;
      await store.upsertScheduledTask('proj', { ...await stored(), schedule });
      await runtime.syncProject('proj');
    };
    await runtime.runNow('proj', task.id);
    await runtime.syncProject('proj');
    await witnessRan();
    expect(state.prompts).toBe(0);
    expect((await stored()).enabled).toBe(true);
  });

  it('keeps a due run that had not started when the task list was refreshed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DUE - 8000);
    const { state, start, stored } = await setUp({ offline: false, waiting: false });
    const runtime = await start();
    expect((await stored()).state.nextRunAt).toBe(DUE);
    for (const at of [DUE - 3000, DUE + 100]) {
      vi.setSystemTime(at);
      await runtime.syncProject('proj');
    }
    await expect.poll(async () => (await stored()).state.lastStatus, { timeout: 5000 }).toBe('sent');
    await runtime.syncProject('proj');
    expect(state.prompts).toBe(1);
    expect((await stored()).state.nextRunAt).toBeUndefined();
  });

  it('does not run when it is made daily during a recheck', async () => {
    const { store, state, start, stored, checksAgain, witness, witnessRan } = await setUp();
    const runtime = await start();
    await checksAgain();
    await witness();
    state.offline = false;
    const changed = new Promise((resolve) => {
      state.onCheck = async () => {
        state.onCheck = undefined;
        await store.upsertScheduledTask('proj', { ...await stored(), schedule: { kind: 'daily', times: ['03:04'], timezone: 'UTC' } });
        await runtime.syncProject('proj');
        resolve();
      };
    });
    await changed;
    await witnessRan();
    expect(state.prompts).toBe(0);
  });

  it('never runs after it was deleted', async () => {
    const { store, state, start, task, witness, witnessRan } = await setUp();
    const runtime = await start();
    await witness();
    await store.deleteScheduledTask('proj', task.id);
    await runtime.syncProject('proj');
    state.offline = false;
    await witnessRan();
    expect(state.prompts).toBe(0);
  });

  it('goes back to waiting when the folder drops before a session exists', async () => {
    const { state, start, stored } = await setUp({ offline: false, sessionFails: true });
    state.onCreate = () => { state.offline = true; };
    await start();
    await expect.poll(async () => (await stored()).state.lastStatus).toBe('queued');
    expect(await stored()).toMatchObject({ enabled: true, state: { waitingForFolder: DUE } });
    expect(state.events).not.toContain('error');
    Object.assign(state, { offline: false, sessionFails: false, onCreate: undefined });
    await expect.poll(async () => (await stored()).enabled).toBe(false);
    expect(state.prompts).toBe(1);
  });

  it('is used up by any other failure', async () => {
    const { state, start, stored } = await setUp({ offline: false, sessionFails: true });
    await start();
    await expect.poll(async () => (await stored()).state.lastStatus).toBe('error');
    expect((await stored()).enabled).toBe(false);
    expect(state.prompts).toBe(0);
  });

  it('leaves recurring tasks as they were', async () => {
    const { state, start, stored, task } = await setUp({ schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' }, sessionFails: true, waiting: false });
    const runtime = await start();
    expect(await runtime.runNow('proj', task.id)).toMatchObject({ ok: false });
    expect(await stored()).toMatchObject({ enabled: true, state: { lastStatus: 'error' } });
    expect((await stored()).state.waitingForFolder).toBeUndefined();
    expect(state.prompts).toBe(0);
  });
});
