import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRuntime } from './session-runtime.js';

describe('session runtime', () => {
  const runtimes = [];

  afterEach(() => {
    for (const runtime of runtimes) {
      runtime.dispose();
    }
    runtimes.length = 0;
  });

  it('keeps pending permission requests and forms until they are answered', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: () => {},
    });
    runtimes.push(runtime);
    const permission = { id: 'perm-1', sessionID: 'session-1', action: 'bash', resources: ['rm *'], metadata: {} };
    const form = { id: 'form-1', sessionID: 'session-2', title: 'Pick one', fields: {} };

    runtime.processOpenCodeSsePayload({ type: 'permission.asked', properties: permission });
    runtime.processOpenCodeSsePayload({ type: 'permission.asked', properties: permission });
    runtime.processOpenCodeSsePayload({ type: 'form.created', properties: { sessionID: 'session-2', form } });
    expect(runtime.getPendingBlockingRequestsSnapshot()).toEqual({
      'session-1': { permissions: [permission], forms: [], pages: [] },
      'session-2': { permissions: [], forms: [form], pages: [] },
    });

    runtime.processOpenCodeSsePayload({ type: 'permission.replied', properties: { sessionID: 'session-1', requestID: 'perm-1' } });
    runtime.processOpenCodeSsePayload({ type: 'form.settled', properties: { sessionID: 'session-2' } });
    expect(runtime.getPendingBlockingRequestsSnapshot()).toEqual({});
  });

  it('keeps a page that waits for an answer beside the session\'s forms until it stops waiting', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: () => {},
    });
    runtimes.push(runtime);

    runtime.trackWaitingPage({ type: 'waiting', sessionId: 'session-1', callId: 'call-1', title: 'Pick a layout', directory: '/repo' });
    expect(runtime.getPendingBlockingRequestsSnapshot()).toEqual({
      'session-1': { permissions: [], forms: [], pages: [{ id: 'call-1', sessionID: 'session-1', title: 'Pick a layout' }] },
    });

    runtime.trackWaitingPage({ type: 'settled', sessionId: 'session-1', callId: 'call-1' });
    expect(runtime.getPendingBlockingRequestsSnapshot()).toEqual({});
  });

  it('drops pending requests when the session is deleted or OpenCode restarts', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: () => {},
    });
    runtimes.push(runtime);
    const ask = (sessionID, id) => runtime.processOpenCodeSsePayload({
      type: 'permission.asked', properties: { id, sessionID, action: 'edit', resources: [], metadata: {} },
    });

    ask('session-1', 'perm-1');
    ask('session-2', 'perm-2');
    runtime.processOpenCodeSsePayload({ type: 'session.deleted', properties: { sessionID: 'session-1', info: { id: 'session-1' } } });
    expect(Object.keys(runtime.getPendingBlockingRequestsSnapshot())).toEqual(['session-2']);

    runtime.interruptBusySessionsAfterRestart();
    expect(runtime.getPendingBlockingRequestsSnapshot()).toEqual({});
  });

  it('broadcasts attention clears through the shared broadcaster', () => {
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        events.push(payload);
      },
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: {
          type: 'busy',
        },
      },
    });
    runtime.markUserMessageSent('session-1');
    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: {
          type: 'idle',
        },
      },
    });
    runtime.markSessionViewed('session-1', 'client-1');

    expect(events).toContainEqual({
      type: 'openchamber:session-status',
      properties: expect.objectContaining({
        sessionID: 'session-1',
        status: 'idle',
        needsAttention: true,
      }),
    });
    expect(events.at(-1)).toEqual({
      type: 'openchamber:session-status',
      properties: {
        sessionID: 'session-1',
        status: 'idle',
        timestamp: expect.any(Number),
        metadata: {},
        needsAttention: false,
      },
    });
  });

  it('accepts legacy session.status info.type payloads', () => {
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        events.push(payload);
      },
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'legacy-session-1',
        info: {
          type: 'busy',
        },
      },
    });

    expect(events).toContainEqual({
      type: 'openchamber:session-status',
      properties: expect.objectContaining({
        sessionID: 'legacy-session-1',
        status: 'busy',
      }),
    });
  });

  it('broadcasts idle activity when cooldown expires', () => {
    vi.useFakeTimers();
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        events.push(payload);
      },
    });

    try {
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: {
          sessionID: 'session-activity-1',
          status: {
            type: 'busy',
          },
        },
      });
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: {
          sessionID: 'session-activity-1',
          status: {
            type: 'idle',
          },
        },
      });

      const activityPhases = () => events
        .filter((event) => event.type === 'openchamber:session-activity')
        .map((event) => event.properties.phase);

      expect(activityPhases()).toEqual(['busy', 'cooldown']);

      vi.advanceTimersByTime(1999);
      expect(activityPhases()).toEqual(['busy', 'cooldown']);

      vi.advanceTimersByTime(1);

      expect(activityPhases()).toEqual(['busy', 'cooldown', 'idle']);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('maintains an idempotent active session count', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent() {},
    });
    runtimes.push(runtime);
    const status = (sessionID, type) => runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type } },
    });

    expect(runtime.getActiveSessionCount()).toBe(0);
    status('session-1', 'busy');
    status('session-1', 'busy');
    status('session-1', 'retry');
    expect(runtime.getActiveSessionCount()).toBe(1);

    status('session-2', 'busy');
    expect(runtime.getActiveSessionCount()).toBe(2);

    status('session-1', 'idle');
    expect(runtime.getActiveSessionCount()).toBe(1);
    status('session-1', 'idle');
    expect(runtime.getActiveSessionCount()).toBe(1);

    runtime.resetAllSessionActivityToIdle();
    expect(runtime.getActiveSessionCount()).toBe(0);
  });

  it('counts only host sessions in the host active count', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent() {},
    });
    runtimes.push(runtime);
    const status = (sessionID, type, spaceId) => runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type } },
    }, { spaceId });

    status('space-session', 'busy', 'space-1');
    expect(runtime.getActiveSessionCount()).toBe(1);
    expect(runtime.getActiveHostSessionCount()).toBe(0);

    status('host-session', 'busy', null);
    expect(runtime.getActiveSessionCount()).toBe(2);
    expect(runtime.getActiveHostSessionCount()).toBe(1);

    status('space-session', 'idle', 'space-1');
    expect(runtime.getActiveSessionCount()).toBe(1);
    expect(runtime.getActiveHostSessionCount()).toBe(1);

    status('host-session', 'idle', null);
    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(runtime.getActiveHostSessionCount()).toBe(0);
  });

  it('interrupts busy sessions after restart and broadcasts terminal events once', () => {
    const events = [];
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: (event) => events.push(event),
    });
    runtimes.push(runtime);
    const status = (sessionID, type) => runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type } },
    });

    runtime.setWatcherConnected(true);
    status('session-busy-1', 'busy');
    status('session-busy-2', 'retry');
    status('session-busy-3', 'busy');
    status('session-idle', 'idle');
    expect(runtime.getActiveSessionCount()).toBe(3);
    events.length = 0;

    expect(runtime.interruptBusySessionsAfterRestart()).toEqual({
      sessionIds: ['session-busy-1', 'session-busy-2', 'session-busy-3'],
    });

    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(runtime.getSessionActivitySnapshot()).toEqual(expect.objectContaining({
      version: 1,
      watcherReady: true,
      sessions: {
        'session-busy-1': expect.objectContaining({ type: 'idle' }),
        'session-busy-2': expect.objectContaining({ type: 'idle' }),
        'session-busy-3': expect.objectContaining({ type: 'idle' }),
        'session-idle': expect.objectContaining({ type: 'idle' }),
      },
    }));
    expect(runtime.getSessionStateSnapshot()).toEqual({
      'session-busy-1': expect.objectContaining({
        status: 'idle',
        metadata: expect.objectContaining({
          message: 'Interrupted by OpenCode restart',
          reason: 'opencode-restart',
        }),
      }),
      'session-busy-2': expect.objectContaining({ status: 'idle' }),
      'session-busy-3': expect.objectContaining({ status: 'idle' }),
      'session-idle': expect.objectContaining({ status: 'idle' }),
    });

    const terminalEvents = events.filter((event) => (
      event.type === 'openchamber:session-status' || event.type === 'session.error'
    ));
    expect(terminalEvents).toHaveLength(6);
    for (const sessionId of ['session-busy-1', 'session-busy-2', 'session-busy-3']) {
      expect(terminalEvents).toContainEqual({
        type: 'openchamber:session-status',
        properties: expect.objectContaining({
          sessionID: sessionId,
          status: 'idle',
        }),
      });
      expect(terminalEvents).toContainEqual({
        type: 'session.error',
        properties: {
          sessionID: sessionId,
          error: {
            name: 'MessageAbortedError',
            message: 'The running turn was interrupted when OpenCode restarted.',
          },
        },
      });
    }
    expect(terminalEvents.some((event) => event.properties.sessionID === 'session-idle')).toBe(false);

    events.length = 0;
    expect(runtime.interruptBusySessionsAfterRestart()).toEqual({ sessionIds: [] });
    expect(events).toEqual([]);
  });

  it('restores activity when busy interrupts cooldown without timer underflow', () => {
    vi.useFakeTimers();
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent() {},
    });
    const status = (type) => runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type } },
    });

    try {
      status('busy');
      status('idle');
      expect(runtime.getActiveSessionCount()).toBe(0);

      status('retry');
      expect(runtime.getActiveSessionCount()).toBe(1);
      vi.advanceTimersByTime(2000);

      expect(runtime.getActiveSessionCount()).toBe(1);
      expect(runtime.getSessionActivitySnapshot().sessions['session-1']).toEqual(expect.objectContaining({ type: 'busy' }));
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('releases retained session state when disposed', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent() {},
    });
    runtimes.push(runtime);

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    runtime.markUserMessageSent('session-1');
    runtime.dispose();

    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(runtime.getSessionActivitySnapshot()).toEqual(expect.objectContaining({ version: 1, watcherReady: false, sessions: {} }));
    expect(runtime.getSessionStateSnapshot()).toEqual({});
    expect(runtime.getSessionAttentionSnapshot()).toEqual({});
  });

  it('exposes the session-activity v1 contract fields (design #612, #524)', () => {
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: () => {},
      getSessionModelProvider: (sessionId) => (sessionId === 'session-1' ? { modelID: 'model-1', providerID: 'provider-1' } : null),
    });
    runtimes.push(runtime);

    const empty = runtime.getSessionActivitySnapshot();
    expect(Object.keys(empty).sort()).toEqual(['serverTime', 'sessions', 'version', 'watcherReady']);
    expect(empty.version).toBe(1);
    expect(empty.watcherReady).toBe(false);
    expect(empty.sessions).toEqual({});

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });

    // A payload alone is not readiness (#1441): the watcher must also be
    // connected. Both signals together flip the marker.
    expect(runtime.getSessionActivitySnapshot().watcherReady).toBe(false);
    runtime.setWatcherConnected(true);

    const snapshot = runtime.getSessionActivitySnapshot();
    expect(snapshot.watcherReady).toBe(true);
    expect(snapshot.serverTime).toEqual(expect.any(Number));
    expect(Object.keys(snapshot.sessions['session-1']).sort()).toEqual(['lastActivityAt', 'model', 'queue', 'status', 'toolInFlight', 'type']);
    expect(snapshot.sessions['session-1']).toEqual({
      type: 'busy',
      lastActivityAt: expect.any(Number),
      status: 'busy',
      model: { modelID: 'model-1', providerID: 'provider-1' },
      toolInFlight: null,
      queue: null,
    });

    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID: 'session-2', status: { type: 'idle' } },
    });
    expect(runtime.getSessionActivitySnapshot().sessions['session-2'].model).toBeNull();
  });
  // Oracle: OpenCode's running list. A busy entry stays exactly when that list
  // names it, it belongs to an isolated space (the list never names those), the
  // stream updated it after the read started, or only one read in a row missed
  // it; a failed read settles nothing.
  it('settles busy sessions OpenCode no longer runs and keeps the rest', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const events = [];
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent: (event) => events.push(event),
      });
      runtimes.push(runtime);
      const status = (sessionID, type, spaceId = null) => runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID, status: { type } },
      }, { spaceId });
      status('finished-subagent', 'busy');
      status('still-running', 'busy');
      status('space-session', 'busy', 'space-1');
      status('restarted-during-read', 'idle');
      vi.advanceTimersByTime(10_000);
      expect(runtime.hasBusySessions()).toBe(true);

      expect(await runtime.reconcileBusySessionsWithActive(async () => null)).toEqual([]);
      // The first read to miss a session only marks it: a turn OpenCode
      // resumes after a restart is not on the list until its drain restarts.
      expect(await runtime.reconcileBusySessionsWithActive(async () => new Set(['still-running']))).toEqual([]);
      expect(runtime.getSessionStateSnapshot()['finished-subagent'].status).toBe('busy');

      let resolve;
      const read = new Promise((complete) => { resolve = complete; });
      const reconcile = runtime.reconcileBusySessionsWithActive(() => read);
      status('restarted-during-read', 'busy');
      resolve(new Set(['still-running']));
      expect(await reconcile).toEqual(['finished-subagent']);

      const snapshot = runtime.getSessionStateSnapshot();
      expect(snapshot['finished-subagent'].status).toBe('idle');
      expect(snapshot['still-running'].status).toBe('busy');
      expect(snapshot['space-session'].status).toBe('busy');
      expect(snapshot['restarted-during-read'].status).toBe('busy');
      expect(runtime.getActiveSessionCount()).toBe(3);
      expect(events).toContainEqual({
        type: 'openchamber:session-status',
        properties: expect.objectContaining({ sessionID: 'finished-subagent', status: 'idle' }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a session whose turn resumes between two reads', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });
      runtimes.push(runtime);
      runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'resuming', status: { type: 'busy' } } });
      vi.advanceTimersByTime(10_000);
      expect(await runtime.reconcileBusySessionsWithActive(async () => new Set())).toEqual([]);
      expect(await runtime.reconcileBusySessionsWithActive(async () => new Set(['resuming']))).toEqual([]);
      expect(await runtime.reconcileBusySessionsWithActive(async () => new Set())).toEqual([]);
      expect(runtime.getSessionStateSnapshot().resuming.status).toBe('busy');
      expect(await runtime.reconcileBusySessionsWithActive(async () => new Set())).toEqual(['resuming']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a busy event between reads even when its public update is throttled', async () => {
    const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });
    runtimes.push(runtime);
    const busy = () => runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'resumed', status: { type: 'busy' } } });
    busy();
    expect(await runtime.reconcileBusySessionsWithActive(async () => new Set())).toEqual([]);
    busy();
    expect(await runtime.reconcileBusySessionsWithActive(async () => new Set())).toEqual([]);
    expect(runtime.getSessionStateSnapshot().resumed.status).toBe('busy');
  });

  it('drops missing confirmation across failed reads and stream reconnects', async () => {
    const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });
    runtimes.push(runtime);
    runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'resumed', status: { type: 'busy' } } });
    const empty = async () => new Set();
    await runtime.reconcileBusySessionsWithActive(empty);
    await runtime.reconcileBusySessionsWithActive(async () => null);
    expect(await runtime.reconcileBusySessionsWithActive(empty)).toEqual([]);
    runtime.setWatcherConnected(false);
    runtime.setWatcherConnected(true);
    expect(await runtime.reconcileBusySessionsWithActive(empty)).toEqual([]);
    expect(await runtime.reconcileBusySessionsWithActive(empty)).toEqual(['resumed']);
  });

  it('runs one background read for any number of busy sessions and stops it on disposal', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });
      runtimes.push(runtime);
      const read = vi.fn(async () => new Set());
      runtime.startStatusReconciliation(read);
      runtime.startStatusReconciliation(read);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).not.toHaveBeenCalled();
      for (let index = 0; index < 1000; index += 1) {
        runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: `session-${index}`, status: { type: 'busy' } } });
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(1);
      runtime.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Oracle: no requests without live work, one request per timer tick with
  // live work, and disposal ends the timer and rejects its pending response.
  it('reconciles only busy hosts and stops on disposal', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });
      runtimes.push(runtime);
      const read = vi.fn(async () => new Set());
      runtime.startStatusReconciliation(read);
      runtime.startStatusReconciliation(read);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(0);
      runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'lost', status: { type: 'busy' } } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(runtime.getSessionState('lost').status).toBe('busy');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(runtime.getSessionState('lost').status).toBe('idle');
      runtime.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed read breaks missing confirmation and overlapping reads do not confirm each other', async () => {
    const runtime = createSessionRuntime({ writeSseEvent() {}, getNotificationClients: () => new Set(), broadcastEvent() {} });
    runtimes.push(runtime);
    runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID: 'lost', status: { type: 'busy' } } });
    await runtime.reconcileBusySessionsWithActive(async () => new Set());
    await runtime.reconcileBusySessionsWithActive(async () => null);
    expect(await runtime.reconcileBusySessionsWithActive(async () => new Set())).toEqual([]);
    let complete;
    const pending = new Promise((resolve) => { complete = resolve; });
    const reading = runtime.reconcileBusySessionsWithActive(() => pending);
    const overlap = vi.fn(async () => new Set());
    expect(await runtime.reconcileBusySessionsWithActive(overlap)).toEqual([]);
    expect(overlap).not.toHaveBeenCalled();
    runtime.dispose();
    complete(new Set());
    expect(await reading).toEqual([]);
    expect(runtime.getSessionStateSnapshot()).toEqual({});
  });
});
