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

  it('broadcasts status changes through the shared broadcaster', () => {
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
    runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: {
          type: 'idle',
        },
      },
    });

    expect(events.filter((event) => event.type === 'openchamber:session-status')).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ sessionID: 'session-1', status: 'busy' }) }),
      expect.objectContaining({ properties: expect.objectContaining({ sessionID: 'session-1', status: 'idle' }) }),
    ]);
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
    expect(runtime.getSessionActivitySnapshot()).toEqual({
      'session-busy-1': { type: 'idle' },
      'session-busy-2': { type: 'idle' },
      'session-busy-3': { type: 'idle' },
      'session-idle': { type: 'idle' },
    });
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
      expect(runtime.getSessionActivitySnapshot()['session-1']).toEqual({ type: 'busy' });
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
    runtime.dispose();

    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(runtime.getSessionActivitySnapshot()).toEqual({});
    expect(runtime.getSessionStateSnapshot()).toEqual({});
  });
  describe('turn starts', () => {
    const setup = (readTurnStart = null) => {
      const events = [];
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent: (payload) => events.push(payload),
        readTurnStart,
      });
      runtimes.push(runtime);
      const status = (type, extra = {}) => runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type }, ...extra },
      });
      const statusEvents = () => events.filter((event) => event.type === 'openchamber:session-status');
      return { runtime, status, statusEvents };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('reports the start of a turn it saw begin, and keeps it once the turn ends', () => {
      const readTurnStart = vi.fn(async () => 1);
      const { runtime, status, statusEvents } = setup(readTurnStart);

      status('busy', { turnStartedAt: 5000 });
      status('busy');
      expect(statusEvents()[0].properties).toMatchObject({ status: 'busy', turnStartedAt: 5000 });
      expect(runtime.getSessionStateSnapshot()['session-1'].turnStartedAt).toBe(5000);
      expect(runtime.getRunningTurnStart('session-1')).toBe(5000);

      // A parent idling while its subagent works still reports that start.
      status('idle');
      expect(runtime.getSessionStateSnapshot()['session-1']).toMatchObject({ status: 'idle', turnStartedAt: 5000 });
      expect(runtime.getRunningTurnStart('session-1')).toBeNull();
      expect(readTurnStart).not.toHaveBeenCalled();

      status('busy', { turnStartedAt: 9000 });
      expect(runtime.getSessionStateSnapshot()['session-1'].turnStartedAt).toBe(9000);
    });

    it('reads back the start of a turn that was running before it listened, once per turn', async () => {
      const readTurnStart = vi.fn(async () => 3000);
      const { runtime, status, statusEvents } = setup(readTurnStart);

      status('busy');
      status('retry');
      // The previous turn's start is never handed out as this one's.
      expect(runtime.getSessionStateSnapshot()['session-1'].turnStartedAt).toBeUndefined();
      expect(statusEvents()[0].properties.turnStartedAt).toBeUndefined();
      await settle();

      expect(readTurnStart).toHaveBeenCalledTimes(1);
      expect(runtime.getRunningTurnStart('session-1')).toBe(3000);
      expect(statusEvents().at(-1).properties).toMatchObject({ sessionID: 'session-1', status: 'retry', turnStartedAt: 3000 });
    });

    it('drops a start read back after its turn ended', async () => {
      let resolveRead;
      const { runtime, status, statusEvents } = setup(() => new Promise((resolve) => { resolveRead = resolve; }));

      status('busy');
      await settle();
      status('idle');
      resolveRead(3000);
      await settle();

      expect(runtime.getRunningTurnStart('session-1')).toBeNull();
      expect(runtime.getSessionStateSnapshot()['session-1'].turnStartedAt).toBeUndefined();
      expect(statusEvents().every((event) => event.properties.turnStartedAt === undefined)).toBe(true);
    });

    it('leaves the start unknown when the history cannot tell it', async () => {
      const { runtime, status, statusEvents } = setup(async () => null);

      status('busy');
      await settle();

      expect(runtime.getRunningTurnStart('session-1')).toBeNull();
      expect(statusEvents()).toHaveLength(1);
    });

    it('marks sessions running at connect busy and reads their starts back', async () => {
      const readTurnStart = vi.fn(async (sessionId) => (sessionId === 'session-1' ? 3000 : 4000));
      const { runtime, status, statusEvents } = setup(readTurnStart);
      status('busy', { turnStartedAt: 4500 });

      runtime.adoptRunningSessions(['session-1', 'session-2'], Date.now() + 1);
      await settle();

      // A start seen live is not read again.
      expect(readTurnStart.mock.calls).toEqual([['session-2']]);
      expect(runtime.getSessionStateSnapshot()['session-2']).toMatchObject({ status: 'busy', turnStartedAt: 4000 });
      expect(runtime.getActiveSessionCount()).toBe(2);
      expect(statusEvents().at(-1).properties).toMatchObject({ sessionID: 'session-2', turnStartedAt: 4000 });
    });

    it('leaves a session whose turn ended while the running list was read', async () => {
      const readTurnStart = vi.fn(async () => 3000);
      const { runtime, status } = setup(readTurnStart);
      status('busy', { turnStartedAt: 5000 });
      const readAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      status('idle');

      runtime.adoptRunningSessions(['session-1'], readAt);
      await settle();

      expect(runtime.getSessionStateSnapshot()['session-1'].status).toBe('idle');
      expect(runtime.getActiveSessionCount()).toBe(0);
      expect(readTurnStart).not.toHaveBeenCalled();
    });

    it('forgets starts when the session is deleted or OpenCode restarts', () => {
      const { runtime, status } = setup();
      status('busy', { turnStartedAt: 5000 });
      runtime.processOpenCodeSsePayload({ type: 'session.deleted', properties: { sessionID: 'session-1', info: { id: 'session-1' } } });
      expect(runtime.getRunningTurnStart('session-1')).toBeNull();

      status('busy', { turnStartedAt: 6000 });
      runtime.interruptBusySessionsAfterRestart();
      expect(runtime.getSessionStateSnapshot()['session-1'].turnStartedAt).toBeUndefined();
    });
  });
});
