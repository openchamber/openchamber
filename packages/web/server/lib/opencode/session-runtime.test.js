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

  it('recovers from idle within cooldown window when busy arrives (Issue #1630 context)', () => {
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
          status: { type: 'busy' },
        },
      });

      // SDK emits idle between internal turns
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: {
          sessionID: 'session-activity-1',
          status: { type: 'idle' },
        },
      });

      // Model resumes within 2 seconds → busy event comes before cooldown expires
      vi.advanceTimersByTime(500);
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: {
          sessionID: 'session-activity-1',
          status: { type: 'busy' },
        },
      });

      const activityPhases = () => events
        .filter((event) => event.type === 'openchamber:session-activity')
        .map((event) => event.properties.phase);

      // The session goes back to busy instead of continuing to idle
      expect(activityPhases()).toEqual(['busy', 'cooldown', 'busy']);

      // Wait well past the cooldown timer — should NOT transition to idle
      vi.advanceTimersByTime(5000);
      expect(activityPhases()).toEqual(['busy', 'cooldown', 'busy']);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
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
});
