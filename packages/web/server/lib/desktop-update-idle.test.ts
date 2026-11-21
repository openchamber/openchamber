import { describe, expect, it } from 'vitest';

import { decideDesktopUpdateIdle, type DesktopUpdateIdleInput } from './desktop-update-idle.js';
import { collectDesktopUpdateIdle, createDesktopUpdateActiveSessionReadiness, type DesktopUpdateIdleParts } from './desktop-update-idle-status.js';

const idleInput = (overrides: Partial<DesktopUpdateIdleInput> = {}): DesktopUpdateIdleInput => ({
  sessions: {},
  terminals: [],
  scheduledRunning: 0,
  scheduledQueued: 0,
  workflowLive: false,
  goalLive: false,
  queueLive: false,
  waitLive: false,
  reviewLive: false,
  ...overrides,
});

describe('decideDesktopUpdateIdle', () => {
  const state = (overrides: Partial<DesktopUpdateIdleInput> = {}) => decideDesktopUpdateIdle(idleInput(overrides)).state;

  it('accepts verified empty or idle session state', () => {
    expect(state()).toBe('idle');
    expect(state({ sessions: { s: { type: 'idle' } } })).toBe('idle');
  });

  it('blocks running, retrying, or unknown sessions and unreadable session lists', () => {
    for (const type of ['running', 'retry', 'retrying']) {
      expect(state({ sessions: { s: { type } } })).toBe('busy');
    }
    for (const type of ['paused', '']) {
      expect(state({ sessions: { s: { type } } })).toBe('unknown');
    }
    expect(state({ sessions: null })).toBe('unknown');
  });

  it('blocks running terminals, regardless of whether an interactive shell is at its prompt', () => {
    for (const mode of ['command', 'interactive', '']) {
      expect(state({ terminals: [{ status: 'running', mode }] })).toBe('busy');
    }
    expect(state({ terminals: [{ status: 'running' }] })).toBe('busy');
    expect(state({ terminals: [{ status: 'exited', mode: 'interactive' }] })).toBe('idle');
    expect(state({ terminals: null })).toBe('unknown');
    expect(state({ terminals: [{ status: 'running', mode: 'unknown' }] })).toBe('unknown');
  });

  it('blocks scheduled tasks and every kind of tracked background work', () => {
    expect(state({ scheduledRunning: 1 })).toBe('busy');
    expect(state({ scheduledQueued: 1 })).toBe('busy');
    expect(state({ scheduledRunning: Number.NaN })).toBe('unknown');
    for (const key of ['workflowLive', 'goalLive', 'queueLive', 'waitLive', 'reviewLive'] as const) {
      expect(state({ [key]: true })).toBe('busy');
    }
  });
});

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
  extensionWaitsRuntime: quiet(),
  prWatchRuntime: quiet(),
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
    await readiness.connect();
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
