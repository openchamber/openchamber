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
  tunnelActive: false,
  ...overrides,
});

describe('decideDesktopUpdateIdle', () => {
  it('is idle when every read is empty', () => {
    expect(decideDesktopUpdateIdle(idleInput())).toEqual({ state: 'idle', reason: null });
  });

  it('treats a running or retrying session as busy and leaves an idle session alone', () => {
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: 'running' } } })).reason).toBe('session');
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: 'retrying' } } })).reason).toBe('session');
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: 'retry' } } })).reason).toBe('session');
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: 'idle' } } })).state).toBe('idle');
  });

  it('stays unknown when a session read fails or a status is not one this check understands', () => {
    expect(decideDesktopUpdateIdle(idleInput({ sessions: null }))).toEqual({ state: 'unknown', reason: 'unreadable' });
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: 'paused' } } })).reason).toBe('unreadable');
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: '' } } })).reason).toBe('unreadable');
  });

  it('names the tunnel when that read fails while a tunnel is open', () => {
    expect(decideDesktopUpdateIdle(idleInput({ sessions: null, tunnelActive: true })).reason).toBe('tunnel');
    expect(decideDesktopUpdateIdle(idleInput({ sessions: { a: { type: 'running' } }, tunnelActive: true })).reason).toBe('session');
    expect(decideDesktopUpdateIdle(idleInput({ tunnelActive: true })).state).toBe('idle');
  });

  it('blocks a running interactive terminal because nothing shows it is at a prompt', () => {
    expect(decideDesktopUpdateIdle(idleInput({
      terminals: [{ status: 'running', mode: 'interactive' }],
    })).reason).toBe('interactive-shell');
    expect(decideDesktopUpdateIdle(idleInput({
      terminals: [{ status: 'running' }],
    })).reason).toBe('interactive-shell');
  });

  it('blocks a running command and ignores a terminal that has exited', () => {
    expect(decideDesktopUpdateIdle(idleInput({
      terminals: [{ status: 'running', mode: 'command' }],
    })).reason).toBe('command');
    expect(decideDesktopUpdateIdle(idleInput({
      terminals: [{ status: 'exited', mode: 'interactive' }, { status: 'exited', mode: 'command' }],
    })).state).toBe('idle');
  });

  it('prefers the interactive terminal when a command is also running', () => {
    expect(decideDesktopUpdateIdle(idleInput({
      terminals: [
        { status: 'running', mode: 'command' },
        { status: 'running', mode: 'interactive' },
      ],
    })).reason).toBe('interactive-shell');
  });

  it('blocks a scheduled task that is running or already queued, and not one that is only enabled', () => {
    expect(decideDesktopUpdateIdle(idleInput({ scheduledRunning: 1 })).reason).toBe('scheduled-task');
    expect(decideDesktopUpdateIdle(idleInput({ scheduledQueued: 1 })).reason).toBe('scheduled-task');
    expect(decideDesktopUpdateIdle(idleInput()).state).toBe('idle');
  });

  it('blocks each kind of OpenChamber-owned work', () => {
    expect(decideDesktopUpdateIdle(idleInput({ workflowLive: true })).reason).toBe('workflow');
    expect(decideDesktopUpdateIdle(idleInput({ goalLive: true })).reason).toBe('goal');
    expect(decideDesktopUpdateIdle(idleInput({ queueLive: true })).reason).toBe('message-queue');
    expect(decideDesktopUpdateIdle(idleInput({ waitLive: true })).reason).toBe('wait');
    expect(decideDesktopUpdateIdle(idleInput({ reviewLive: true })).reason).toBe('review');
  });

  it('stays unknown when the terminal list or the schedule counts did not arrive', () => {
    expect(decideDesktopUpdateIdle(idleInput({ terminals: null })).reason).toBe('unreadable');
    expect(decideDesktopUpdateIdle(idleInput({ scheduledRunning: Number.NaN })).reason).toBe('unreadable');
  });
});

const quiet = (live = false) => ({ load: async () => undefined, hasLiveWork: () => live });

const owners = (overrides: Partial<DesktopUpdateIdleParts> = {}): DesktopUpdateIdleParts => ({
  canReadSessions: () => true,
  tunnelService: { getPublicUrl: () => null },
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
      .toEqual({ state: 'unknown', reason: 'unreadable' });
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
    expect(await collectDesktopUpdateIdle(parts)).toEqual({ state: 'busy', reason: 'session' });
    expect(await collectDesktopUpdateIdle(owners({
      sessionAssistRuntime: { hasLiveWork: () => true },
    }))).toEqual({ state: 'busy', reason: 'session' });
  });
  it('counts a pending blocking request as a running session', async () => {
    const status = await collectDesktopUpdateIdle(owners({
      sessionRuntime: {
        getSessionStateSnapshot: () => ({ s: { status: 'idle' } }),
        getSessionActivitySnapshot: () => ({}),
        getPendingBlockingRequestsSnapshot: () => ({ s: { permissions: [{}], forms: [], pages: [] } }),
      },
    }));
    expect(status).toEqual({ state: 'busy', reason: 'session' });
  });

  it('stays unknown when a catalog load fails, and sees work that arrives with that load', async () => {
    const failed = await collectDesktopUpdateIdle(owners({
      messageQueueRuntime: { load: async () => { throw new Error('unreadable'); }, hasLiveWork: () => false },
    }));
    expect(failed).toEqual({ state: 'unknown', reason: 'unreadable' });

    let loaded = false;
    const queued = await collectDesktopUpdateIdle(owners({
      messageQueueRuntime: {
        load: async () => { loaded = true; },
        hasLiveWork: () => loaded,
      },
    }));
    expect(queued).toEqual({ state: 'busy', reason: 'message-queue' });
  });
});
