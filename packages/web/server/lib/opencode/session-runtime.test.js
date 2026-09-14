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
    runtime.markUserMessageSent('session-1');
    runtime.dispose();

    expect(runtime.getActiveSessionCount()).toBe(0);
    expect(runtime.getSessionActivitySnapshot()).toEqual({});
    expect(runtime.getSessionStateSnapshot()).toEqual({});
    expect(runtime.getSessionAttentionSnapshot()).toEqual({});
  });

  describe('background child activity aggregation', () => {
    const learnChild = (runtime, childId, parentId) => runtime.processOpenCodeSsePayload({
      type: 'session.updated',
      properties: { info: { id: childId, parentID: parentId } },
    });
    const status = (runtime, sessionId, type) => runtime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID: sessionId, status: { type } },
    });

    it('keeps the parent active while a background child is busy even when the parent is idle', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'parent-1', 'busy');
      status(runtime, 'parent-1', 'idle');
      status(runtime, 'child-1', 'busy');

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getSessionStateSnapshot()['parent-1'].status).toBe('idle');
      // The derived parent is presentation-only; the busy child is the single
      // operational active session.
      expect(runtime.getActiveSessionCount()).toBe(1);
    });

    it('does not put the parent into cooldown when it goes idle while a child is active', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      const phases = () => Object.values(runtime.getSessionActivitySnapshot());

      try {
        learnChild(runtime, 'child-1', 'parent-1');
        status(runtime, 'child-1', 'busy');
        status(runtime, 'parent-1', 'busy');
        status(runtime, 'parent-1', 'idle');

        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(phases()).not.toContainEqual({ type: 'cooldown' });
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('falls back to the parent raw busy when the last child settles', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'parent-1', 'busy');
      status(runtime, 'child-1', 'busy');
      status(runtime, 'child-1', 'idle');

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      status(runtime, 'parent-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('clears derived parent activity once all children settle and the parent is idle', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        learnChild(runtime, 'child-1', 'parent-1');
        status(runtime, 'child-1', 'busy');
        status(runtime, 'child-1', 'retry');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

        status(runtime, 'child-1', 'idle');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });

        vi.advanceTimersByTime(2000);
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'idle' });
        expect(runtime.getActiveSessionCount()).toBe(0);
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('keeps the parent active while any of several children remain active', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      learnChild(runtime, 'child-2', 'parent-1');
      status(runtime, 'child-1', 'busy');
      status(runtime, 'child-2', 'busy');

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      status(runtime, 'child-2', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
    });

    it('does not treat a session without children differently on its own idle', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      status(runtime, 'plain-1', 'busy');
      status(runtime, 'plain-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['plain-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('adopts a child already busy before its record arrived', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      status(runtime, 'child-1', 'busy');
      learnChild(runtime, 'child-1', 'parent-1');

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
    });

    it('clears a parent derived activity, relation, and count when a busy child is deleted', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      runtime.processOpenCodeSsePayload({
        type: 'session.deleted',
        properties: { info: { id: 'child-1', parentID: 'parent-1' } },
      });

      // Parent settled (raw idle → cooldown), deleted child fully removed from
      // the activity snapshot, and the raw busy contribution dropped.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toBeUndefined();
      expect(runtime.getActiveSessionCount()).toBe(0);

      // The relation is forgotten: a later busy event cannot resurrect it.
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
    });

    it('settles the former parent when an active child is reparented', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      // Reassignment via session.updated carrying the new parentID.
      learnChild(runtime, 'child-1', 'parent-2');

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['parent-2']).toEqual({ type: 'busy' });
      // The child is the only operational active session; both parents are
      // presentation-only.
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('does not aggregate a rejected cycle proposal even while the candidate parent is synthetic-busy', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      // Accepted relation: child-1 → parent-1, and the child is busy.
      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      // Cycle proposal parent-1 → child-1 arrives while parent-1 is already
      // synthetic-busy from the accepted edge. The relation is rejected, and
      // the busy adoption must not insert a ghost active edge for it.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', parentID: 'child-1' } },
      });

      // Raw child settles: neither ghost active edge nor synthetic activity
      // remains on either side.
      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('rejects a stale relation record older than a newer reparent so the busy child is not re-adopted', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      // Newer reparent record first, then the child goes busy.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-2', time: { updated: 200 } } },
      });
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-2']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      // Delayed stale old-parent record (older time) arrives afterwards: it
      // must not move the busy child or re-adopt it to the stale ancestor.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
      });

      expect(runtime.getSessionActivitySnapshot()['parent-2']).toEqual({ type: 'busy' });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-2']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('resets child relations so a later busy status cannot rederive a stale former parent', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      runtime.resetAllSessionActivityToIdle();
      expect(runtime.getActiveSessionCount()).toBe(0);

      // Without a new relation record, a busy status must not rederive the old
      // parent after the reset cleared every relation source (the reset keeps
      // an idle phase entry for it, but it must not become derived busy).
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).not.toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      // A fresh relation record works normally.
      learnChild(runtime, 'child-1', 'parent-2');
      expect(runtime.getSessionActivitySnapshot()['parent-2']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);
    });

    it('clears orphaned child relations when a parent session is deleted', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      runtime.processOpenCodeSsePayload({
        type: 'session.deleted',
        properties: { info: { id: 'parent-1' } },
      });

      // The deleted parent is fully removed from the activity snapshot; the
      // orphaned child keeps its own liveness but no parent derives from it.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('detaches a busy child on explicit parentID null and clears the former parent while the child stays busy', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      // Derived parent is presentation-only; child is the one operational count.
      expect(runtime.getActiveSessionCount()).toBe(1);

      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: null } },
      });

      // Former parent settled, child raw busy untouched, child still counted.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('detaches a busy child when a complete record omits parentID and clears the former parent while the child stays busy', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      // Derived parent is presentation-only; child is the one operational count.
      expect(runtime.getActiveSessionCount()).toBe(1);

      // A complete record (info.id present) omits parentID exactly for root
      // sessions: the omitted parent detaches the former relation just like an
      // explicit parentID: null.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1' } },
      });

      // Former parent settled, child raw busy untouched, child still counted.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('does not mutate relations for partial payloads without a complete record', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      // Payloads lacking `properties.info` (or an info record with an id) are
      // not authoritative session records: they must not detach the relation.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { sessionID: 'child-1' },
      });
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: {} },
      });
      // An empty-string parentID is likewise not a relation mutation.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: '' } },
      });

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
    });

    it('counts one busy background child as exactly one operational active session', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'parent-1', 'idle');
      status(runtime, 'child-1', 'busy');

      // The parent is visibly active (presentation), the child is the single
      // operational active session.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('counts a raw busy parent and a busy child exactly once each without a synthetic double count', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'parent-1', 'busy');
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'busy');
      // Parent raw busy + child busy = two operational sessions; the child does
      // not demote the raw-busy parent to synthetic.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(2);

      status(runtime, 'parent-1', 'idle');
      // Parent becomes presentation-only (synthetic busy), child stays raw.
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('settles a synthetic parent in the same cleanup cycle that prunes its stale child relation', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        learnChild(runtime, 'child-1', 'parent-1');
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        // Refresh the parent phase after the child's last status so the parent
        // phase stays inside its TTL while the child state ages out (the child
        // keeps emitting nothing, so only the parent's raw transitions move).
        vi.advanceTimersByTime(60 * 60 * 1000);
        status(runtime, 'parent-1', 'busy');
        vi.advanceTimersByTime(60 * 60 * 1000);
        status(runtime, 'parent-1', 'idle');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });

        // Let the hourly cleanup fire past the 24h child-state TTL: the stale
        // child relation is pruned and the synthetic parent settles to
        // cooldown in the same cycle instead of staying busy until its own TTL.
        vi.advanceTimersByTime(23 * 60 * 60 * 1000);
        expect(runtime.getSessionStateSnapshot()['child-1']).toBeUndefined();
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
        expect(runtime.getActiveSessionCount()).toBe(0);

        vi.advanceTimersByTime(2000);
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'idle' });
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('propagates a busy grandchild to every ancestor and settles them together', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      learnChild(runtime, 'grandchild-1', 'child-1');
      status(runtime, 'grandchild-1', 'busy');

      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getSessionActivitySnapshot()['grandchild-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'grandchild-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('keeps ancestors active when a middle session idles while its grandchild runs', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      learnChild(runtime, 'grandchild-1', 'child-1');
      status(runtime, 'grandchild-1', 'busy');
      status(runtime, 'child-1', 'idle');

      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'grandchild-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('reparents an active middle session with its descendants to the new ancestor chain', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      learnChild(runtime, 'grandchild-1', 'child-1');
      status(runtime, 'grandchild-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      learnChild(runtime, 'child-1', 'parent-2');

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['parent-2']).toEqual({ type: 'busy' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);
    });

    it('detaches an active middle session with descendants from its former parent', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      learnChild(runtime, 'grandchild-1', 'child-1');
      status(runtime, 'grandchild-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: null } },
      });

      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);
    });

    it('rejects an indirect cycle-forming relation so synthetic activity cannot self-sustain', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      // Would form child-1 ↔ parent-1: the proposed parent is a descendant of
      // the child, so it is rejected without storing a cycle.
      learnChild(runtime, 'parent-1', 'child-1');

      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      status(runtime, 'child-1', 'idle');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });

    it('removes a deleted session from every snapshot and its cooldown cannot recreate it', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        status(runtime, 'session-1', 'busy');
        runtime.markUserMessageSent('session-1');
        status(runtime, 'session-1', 'idle');
        expect(runtime.getSessionActivitySnapshot()['session-1']).toEqual({ type: 'cooldown' });

        runtime.processOpenCodeSsePayload({
          type: 'session.deleted',
          properties: { info: { id: 'session-1' } },
        });

        expect(runtime.getSessionActivitySnapshot()).toEqual({});
        expect(runtime.getSessionStateSnapshot()).toEqual({});
        expect(runtime.getSessionAttentionSnapshot()).toEqual({});
        expect(runtime.getActiveSessionCount()).toBe(0);

        // The pending cooldown timer must not recreate a phase entry.
        vi.advanceTimersByTime(2000);
        expect(runtime.getSessionActivitySnapshot()).toEqual({});
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('rejects a same-recency relation record that would reconnect a busy child to a deleted parent', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
      });
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

      runtime.processOpenCodeSsePayload({
        type: 'session.deleted',
        properties: { info: { id: 'parent-1' } },
      });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();

      // Delayed same-recency relation record: rejected by the deletion tombstone.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
      });
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
    });

    it('rejects same-recency reconnection without prior relation recency but admits a strictly newer record', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      // The parent is deleted before any relation record touched the child.
      runtime.processOpenCodeSsePayload({
        type: 'session.deleted',
        properties: { info: { id: 'parent-1', time: { updated: 100 } } },
      });

      // Same-recency record proposing the tombstoned parent: rejected.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
      });
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();

      // Strictly newer record: admitted and participates normally.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 200 } } },
      });
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
    });

    it('treats a complete session update with time.archived as terminal deletion', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      // Archive the parent: terminal like deletion, with the archived record
      // time as the tombstone baseline.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
      });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getActiveSessionCount()).toBe(1);

      // A same-recency delayed relation cannot restore the archived parent.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
      });
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getActiveSessionCount()).toBe(1);
    });

    it('ignores unversioned status updates for a tombstoned session id until a strictly newer record recreates it', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      // Archive the parent: terminal; its phase and raw state are cleared.
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
      });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getSessionStateSnapshot()['parent-1']).toBeUndefined();

      // Delayed unversioned busy status for the tombstoned parent: ignored, so
      // no raw/phase resurrection and no operational count change.
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'busy' } },
      });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getSessionStateSnapshot()['parent-1']).toBeUndefined();
      expect(runtime.getActiveSessionCount()).toBe(1);

      // A strictly newer complete record recreates the session: its status now
      // applies normally (raw busy phase, counted operationally).
      runtime.processOpenCodeSsePayload({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', time: { updated: 200 } } },
      });
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'busy' } },
      });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(2);
    });

    it('restores the relation on a strictly newer child edge but keeps the parent status-blocked until the parent itself has a newer record', () => {
      // Mirrors the UI tombstone semantics: a newer child→parent edge may
      // restore the relation but never clears the parent's tombstone/status
      // block; the parent's own unversioned status stays ignored until the
      // parent's own strictly-newer complete record is accepted. Runs for both
      // terminal flavors (archive and delete) with a @150 tombstone baseline
      // (the initial terminal is strictly newer than the accepted edge@100).
      const runScenario = (terminalPayload) => {
        const runtime = createSessionRuntime({
          writeSseEvent() {},
          getNotificationClients: () => new Set(),
          broadcastEvent() {},
        });
        runtimes.push(runtime);

        // Busy child derives the parent, then the parent is terminal @150.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        runtime.processOpenCodeSsePayload(terminalPayload);
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getActiveSessionCount()).toBe(1);

        // A strictly newer child->parent edge @201 restores the edge relation
        // (the busy child derives the parent again) but must NOT unblock the
        // parent's own unversioned status.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 201 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        // Raw unversioned busy status for the parent is still blocked: the
        // parent stays presentation-busy only (no raw state, no operational
        // count), while the busy child aggregation is preserved.
        status(runtime, 'parent-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getSessionStateSnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getActiveSessionCount()).toBe(1);

        // The parent itself gets a strictly-newer complete record @200: its
        // raw status now applies normally (raw busy phase, counted
        // operationally, still derived by the child).
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'parent-1', time: { updated: 200 } } },
        });
        status(runtime, 'parent-1', 'busy');
        expect(runtime.getSessionStateSnapshot()['parent-1'].status).toBe('busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(2);
      };

      runScenario({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
      });
      runScenario({
        type: 'session.deleted',
        properties: { info: { id: 'parent-1', time: { updated: 150 } } },
      });
    });

    it('ignores a delayed terminal record after a newer child edge restored the relation but honors a strictly newer deletion', () => {
      // Terminal parent@150 establishes the tombstone baseline (strictly newer
      // than the accepted edge@100); a child edge @201 restores the relation; a
      // delayed deletion@100 must do nothing (relation and derived activity
      // preserved); a strictly newer deletion @202 still cleans up. Runs for
      // both terminal flavors of the initial event (archive and delete).
      const runScenario = (initialTerminalPayload) => {
        const runtime = createSessionRuntime({
          writeSseEvent() {},
          getNotificationClients: () => new Set(),
          broadcastEvent() {},
        });
        runtimes.push(runtime);

        // Busy child establishes the relation, then the parent is terminal @150.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        runtime.processOpenCodeSsePayload(initialTerminalPayload);
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getActiveSessionCount()).toBe(1);

        // A strictly newer child edge @201 restores the relation and the busy
        // child derives the parent again.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 201 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        // A delayed deletion @100 (not strictly newer than the @150 tombstone
        // baseline) is ignored: relation and derived activity stay preserved,
        // and no raw state is created for the tombstoned parent.
        runtime.processOpenCodeSsePayload({
          type: 'session.deleted',
          properties: { info: { id: 'parent-1', time: { updated: 100 } } },
        });
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
        expect(runtime.getSessionStateSnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getActiveSessionCount()).toBe(1);

        // A strictly newer deletion @202 is honored and cleans up; the busy
        // child keeps its own liveness after its parent is orphaned.
        runtime.processOpenCodeSsePayload({
          type: 'session.deleted',
          properties: { info: { id: 'parent-1', time: { updated: 202 } } },
        });
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);
      };

      runScenario({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
      });
      runScenario({
        type: 'session.deleted',
        properties: { info: { id: 'parent-1', time: { updated: 150 } } },
      });
    });

    it('requires a terminal record to be strictly newer than the newest accepted relation/session recency (equal-recency terminal is stale)', () => {
      // A restored child edge @201 raises the newest accepted relation recency;
      // a terminal @201 (equal to it, and above the tombstone baseline) must be
      // ignored while a strictly newer terminal @202 still cleans up. An
      // unversioned terminal after the tombstone stays ignored (baseline
      // behavior), and the initial terminal is strictly newer than the accepted
      // edge so it still cleans up. Runs for both terminal flavors of the
      // initial event (archive and delete).
      const runScenario = (initialTerminalPayload) => {
        const runtime = createSessionRuntime({
          writeSseEvent() {},
          getNotificationClients: () => new Set(),
          broadcastEvent() {},
        });
        runtimes.push(runtime);

        // Busy child establishes the relation, then the parent is terminal
        // @150 (strictly newer than the accepted edge@100, so the initial
        // terminal cleans up and tombstones the id at 150).
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        runtime.processOpenCodeSsePayload(initialTerminalPayload);
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getActiveSessionCount()).toBe(1);

        // A strictly newer child edge @201 restores the relation: the newest
        // accepted relation/session recency for the parent is now 201.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 201 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        // An unversioned deletion cannot prove it is newer than the @150
        // tombstone baseline: ignored, relation and derived activity preserved.
        runtime.processOpenCodeSsePayload({
          type: 'session.deleted',
          properties: { info: { id: 'parent-1' } },
        });
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        // An equal-recency terminal @201 (same as the restored edge, and
        // strictly newer than the tombstone baseline) is stale: it cannot prove
        // the parent was terminated after the edge re-created it, so the
        // relation and derived activity are preserved and no raw state is
        // created for the tombstoned parent.
        runtime.processOpenCodeSsePayload({
          type: 'session.deleted',
          properties: { info: { id: 'parent-1', time: { updated: 201 } } },
        });
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
        expect(runtime.getSessionStateSnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getActiveSessionCount()).toBe(1);

        // A strictly newer terminal @202 is honored and cleans up; the busy
        // child keeps its own liveness after its parent is orphaned.
        runtime.processOpenCodeSsePayload({
          type: 'session.deleted',
          properties: { info: { id: 'parent-1', time: { updated: 202 } } },
        });
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);
      };

      runScenario({
        type: 'session.updated',
        properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
      });
      runScenario({
        type: 'session.deleted',
        properties: { info: { id: 'parent-1', time: { updated: 150 } } },
      });
    });

    it('does not reclaim a tombstone while the id is still referenced, so stale-event blocking survives cleanup cycles', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        // Busy child derives the parent, then the parent is terminal @150
        // (tombstone baseline 150).
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
        });
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();

        // A strictly newer child edge @201 restores the relation, so parent-1
        // is referenced again (as a parent) and stays referenced through the
        // cleanup cycle below.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 201 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });

        // Run a cleanup cycle well inside the 24h retention window.
        vi.advanceTimersByTime(60 * 60 * 1000);

        // The tombstone is still retained: the parent's own unversioned busy
        // status remains blocked (no raw state, no operational count change),
        // exactly as before cleanup ran.
        status(runtime, 'parent-1', 'busy');
        expect(runtime.getSessionStateSnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('reclaims a tombstone once the id is unreferenced and the retention window passes, forgetting the id', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        // Archive the parent @150: terminal, so no relation, raw state, or
        // activity remains for it — only the tombstone.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'parent-1', time: { updated: 150, archived: 150 } } },
        });
        expect(runtime.getSessionActivitySnapshot()).toEqual({});
        expect(runtime.getSessionStateSnapshot()).toEqual({});

        // Inside the retention window a stale reconnection stays blocked: the
        // old-recency child edge cannot re-create the archived parent.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();

        // Cross the deliberate retention window (the hourly cleanup fires
        // along the way): the unreferenced id's tombstone is reclaimed.
        vi.advanceTimersByTime(25 * 60 * 60 * 1000);

        // The id is now forgotten like any id pruned by the state TTL: an
        // unversioned busy status creates raw state and counts operationally,
        // exactly as for a brand-new session id.
        status(runtime, 'parent-1', 'busy');
        expect(runtime.getSessionStateSnapshot()['parent-1'].status).toBe('busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('reclaims relation recency only after the 24h retention expiry so an older record is treated as a fresh session', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        // Complete child record @200 plus a busy status establish the recency
        // baseline and the parent-child relation.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 200 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);

        // Let everything about the session age past the 24h TTLs: raw state,
        // activity phase, and the parent-child relation are all pruned by the
        // hourly cleanup. The recency baseline is retained for the deliberate
        // 24h stale-event window, so it is reclaimed only after this same
        // window passes.
        vi.advanceTimersByTime(25 * 60 * 60 * 1000);
        expect(runtime.getSessionStateSnapshot()['child-1']).toBeUndefined();
        expect(runtime.getSessionActivitySnapshot()).toEqual({});

        // The retention window has expired: the id is forgotten like any id
        // pruned by the state TTL, so a delayed older record @100 is no longer
        // rejected as stale and is admitted as a fresh session, deriving the
        // parent again.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('retains a root/detach ordering baseline through hourly cleanup before 24h so a delayed older reparent record stays rejected', () => {
      vi.useFakeTimers();
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });

      try {
        // A newer root record (omitted parentID) establishes the child's
        // ordering baseline at @200 with no active raw state: the child never
        // went busy, so nothing else references the id.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', time: { updated: 200 } } },
        });
        expect(runtime.getSessionActivitySnapshot()).toEqual({});
        expect(runtime.getActiveSessionCount()).toBe(0);

        // Hourly cleanup fires well inside the 24h stale-event window. The
        // unreferenced recency baseline must survive (like a tombstone), or a
        // delayed older child relation event could slip past as fresh.
        vi.advanceTimersByTime(23 * 60 * 60 * 1000);

        // A delayed older reparent record @100 must not re-adopt the child to
        // the stale ancestor: the root ordering baseline outlived every
        // cleanup cycle inside the window.
        runtime.processOpenCodeSsePayload({
          type: 'session.updated',
          properties: { info: { id: 'child-1', parentID: 'parent-1', time: { updated: 100 } } },
        });
        status(runtime, 'child-1', 'busy');
        expect(runtime.getSessionActivitySnapshot()['parent-1']).toBeUndefined();
        expect(runtime.getSessionActivitySnapshot()['child-1']).toEqual({ type: 'busy' });
        expect(runtime.getActiveSessionCount()).toBe(1);
      } finally {
        runtime.dispose();
        vi.useRealTimers();
      }
    });

    it('normalizes session.idle and session.error terminal events to idle for lifecycle settlement', () => {
      const runtime = createSessionRuntime({
        writeSseEvent() {},
        getNotificationClients: () => new Set(),
        broadcastEvent() {},
      });
      runtimes.push(runtime);

      // session.idle settles the busy child.
      learnChild(runtime, 'child-1', 'parent-1');
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      runtime.processOpenCodeSsePayload({ type: 'session.idle', properties: { sessionID: 'child-1' } });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);

      // session.error settles it the same way.
      status(runtime, 'child-1', 'busy');
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'busy' });
      expect(runtime.getActiveSessionCount()).toBe(1);

      runtime.processOpenCodeSsePayload({ type: 'session.error', properties: { sessionID: 'child-1' } });
      expect(runtime.getSessionActivitySnapshot()['parent-1']).toEqual({ type: 'cooldown' });
      expect(runtime.getActiveSessionCount()).toBe(0);
    });
  });
});
