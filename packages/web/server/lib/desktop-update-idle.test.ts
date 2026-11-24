import { describe, expect, it } from 'vitest';

import { collectDesktopUpdateIdle, createDesktopUpdateActiveSessionReadiness, type DesktopUpdateIdleParts } from './desktop-update-idle-status.js';

const quiet = (live = false) => ({ load: async () => undefined, hasLiveWork: () => live });

const owners = (overrides: Partial<DesktopUpdateIdleParts> = {}): DesktopUpdateIdleParts => ({
  canReadSessions: () => true,
  sessionRuntime: {
    getSessionStateSnapshot: () => ({}),
    getSessionActivitySnapshot: () => ({}),
    getPendingBlockingRequestsSnapshot: () => ({}),
  },
  terminalRuntime: { listTerminals: () => [] },
  scheduledTasksRuntime: { getStatus: () => ({ runningScheduledTasksCount: 0, queuedScheduledTasksCount: 0 }) },
  workflowRuntime: { hasLiveRun: () => false },
  sessionGoalRuntime: { hasLiveWork: () => false },
  sessionAssistRuntime: { hasLiveWork: () => false },
  messageQueueRuntime: quiet(),
  autoReviewRuntime: quiet(),
  ...overrides,
});

describe('desktop update active-session reconciliation', () => {
  it('remains unreadable until an authoritative read succeeds for the current connection', async () => {
    let connected = true;
    let statuses: Record<string, { type: string }> | null = null;
    const adopted: string[][] = [];
    const readiness = createDesktopUpdateActiveSessionReadiness({
      readStatuses: async () => statuses,
      isConnected: () => connected,
      adoptRunning: (ids) => { adopted.push(ids); },
    });
    await readiness.connect();
    expect(readiness.isReady()).toBe(false);
    statuses = { running: { type: 'busy' } };
    expect(await readiness.ensureReady()).toBe(true);
    expect(readiness.isReady()).toBe(true);
    expect(adopted).toEqual([['running']]);
    readiness.disconnect();
    expect(readiness.isReady()).toBe(false);
    connected = false;
    await readiness.connect();
    expect(readiness.isReady()).toBe(false);
  });

  it('rejects a stale reconnect read even when it finishes after the newer connection', async () => {
    let finishOld!: (value: Record<string, { type: string }>) => void;
    const oldRead = new Promise<Record<string, { type: string }>>((resolve) => { finishOld = resolve; });
    let reads = 0;
    const adopted: string[][] = [];
    const readiness = createDesktopUpdateActiveSessionReadiness({
      readStatuses: () => ++reads === 1 ? oldRead : Promise.resolve({ recent: { type: 'busy' } }),
      isConnected: () => true,
      adoptRunning: (ids) => { adopted.push(ids); },
    });
    const stale = readiness.connect();
    readiness.disconnect();
    await readiness.connect();
    expect(readiness.isReady()).toBe(true);
    finishOld({ stale: { type: 'busy' } });
    await stale;
    expect(readiness.isReady()).toBe(true);
    expect(adopted).toEqual([['recent']]);
  });
});

describe('collectDesktopUpdateIdle', () => {
  const state = async (overrides: Partial<DesktopUpdateIdleParts> = {}) =>
    (await collectDesktopUpdateIdle(owners(overrides))).state;

  it('accepts verified idle sessions and blocks busy, retrying or unknown sessions', async () => {
    expect(await state()).toBe('idle');
    for (const [status, expected] of Object.entries({ idle: 'idle', busy: 'busy', retry: 'busy', paused: 'unknown', '': 'unknown' })) {
      expect(await state({ sessionRuntime: { ...owners().sessionRuntime, getSessionStateSnapshot: () => ({ s: { status } }) } })).toBe(expected);
    }
  });

  it('requires a readable terminal list and waits for running terminals', async () => {
    expect(await state({ terminalRuntime: null })).toBe('unknown');
    expect(await state({ terminalRuntime: { listTerminals: () => [{ status: 'running' }] } })).toBe('busy');
    for (const mode of ['command', 'interactive', '', 'other']) {
      expect(await state({ terminalRuntime: { listTerminals: () => [{ status: 'running', mode }] } })).toBe(mode === 'other' ? 'unknown' : 'busy');
    }
    expect(await state({ terminalRuntime: { listTerminals: () => [{ status: 'exited' }] } })).toBe('idle');
  });

  it('counts queued and running tasks and each live work catalog', async () => {
    for (const [runningScheduledTasksCount, queuedScheduledTasksCount] of [[1, 0], [0, 1], [NaN, 0]] as const) {
      expect(await state({ scheduledTasksRuntime: { getStatus: () => ({ runningScheduledTasksCount, queuedScheduledTasksCount }) } }))
        .toBe(Number.isNaN(runningScheduledTasksCount) ? 'unknown' : 'busy');
    }
    for (const key of ['messageQueueRuntime', 'autoReviewRuntime', 'sessionGoalRuntime'] as const) {
      expect(await state({ [key]: quiet(true) })).toBe('busy');
    }
    expect(await state({ workflowRuntime: { hasLiveRun: () => true } })).toBe('busy');
  });

  it('waits for running OpenCode background jobs and fails closed when the probe is unreadable', async () => {
    expect(await state({ readBackgroundJobs: async () => undefined })).toBe('idle');
    expect(await state({ readBackgroundJobs: async () => [] })).toBe('idle');
    expect(await state({ readBackgroundJobs: async () => null })).toBe('unknown');
    expect(await state({
      readBackgroundJobs: async () => [{ kind: 'shell', sessionID: 'ses_1', command: 'bun run build', startedAt: Date.now() }],
    })).toBe('busy');
  });
  it('cannot authorize an install on an empty disconnected session snapshot', async () => {
    expect(await collectDesktopUpdateIdle(owners({ canReadSessions: () => false })))
      .toEqual({ state: 'unknown' });
  });
  it('samples live sessions after the catalog loads, and counts session assists', async () => {
    let running = false;
    const parts = owners({
      messageQueueRuntime: { load: async () => { running = true; }, hasLiveWork: () => false },
      sessionRuntime: {
        ...owners().sessionRuntime,
        getSessionStateSnapshot: () => ({ s: { status: running ? 'busy' : 'idle' } }),
      },
    });
    expect(await collectDesktopUpdateIdle(parts)).toEqual({ state: 'busy' });
    expect(await collectDesktopUpdateIdle(owners({
      sessionAssistRuntime: { hasLiveWork: () => true },
    }))).toEqual({ state: 'busy' });
  });
  it('counts a pending blocking request as a running session', async () => {
    const status = await collectDesktopUpdateIdle(owners({
      sessionRuntime: {
        getSessionStateSnapshot: () => ({ s: { status: 'idle' } }),
        getSessionActivitySnapshot: () => ({}),
        getPendingBlockingRequestsSnapshot: () => ({ s: { permissions: [{}], forms: [], pages: [] } }),
      },
    }));
    expect(status).toEqual({ state: 'busy' });
  });

  it('stays unknown when a catalog load fails, and sees work that arrives with that load', async () => {
    const failed = await collectDesktopUpdateIdle(owners({
      messageQueueRuntime: { load: async () => { throw new Error('unreadable'); }, hasLiveWork: () => false },
    }));
    expect(failed).toEqual({ state: 'unknown' });

    let loaded = false;
    const queued = await collectDesktopUpdateIdle(owners({
      messageQueueRuntime: {
        load: async () => { loaded = true; },
        hasLiveWork: () => loaded,
      },
    }));
    expect(queued).toEqual({ state: 'busy' });
  });
});
