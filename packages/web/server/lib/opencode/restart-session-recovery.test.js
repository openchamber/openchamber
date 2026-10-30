import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRestartNotification } from './restart-notification.js';
import { createSessionRuntime, RESTART_RESUME_GRACE_MS } from './session-runtime.js';

describe('managed OpenCode restart session recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('settles busy sessions and switches to manual guidance after automatic recovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events = [];
    const sessionRuntime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: (event) => events.push(event),
      buildOpenCodeUrl: (path) => `http://localhost:49722${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => ({ ok: true }),
    });
    const markBusy = (sessionID) => sessionRuntime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    });

    try {
      markBusy('session-1');
      markBusy('session-2');
      markBusy('session-3');
      events.length = 0;
      const recovery = sessionRuntime.interruptBusySessionsAfterRestart();

      expect(sessionRuntime.getActiveSessionCount()).toBe(0);
      expect(Object.values(sessionRuntime.getSessionStateSnapshot()).map((state) => state.status))
        .toEqual(['idle', 'idle', 'idle']);
      expect(events.filter((event) => event.type === 'openchamber:session-status')).toHaveLength(3);
      expect(events.filter((event) => event.type === 'session.error')).toHaveLength(3);
      expect(buildRestartNotification(recovery)).toMatchObject({
        kind: 'opencode-restart-resuming',
        sessionId: 'session-1',
        body: expect.stringContaining('resume automatically'),
      });

      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
      markBusy('session-1');
      const repeated = sessionRuntime.interruptBusySessionsAfterRestart();
      expect(repeated.autoResumeSessionIds).toEqual([]);
      expect(buildRestartNotification(repeated)).toMatchObject({
        kind: 'opencode-restart-interrupted',
        body: 'OpenCode restarted during a running response. Send a message to continue.',
      });
      expect(buildRestartNotification(sessionRuntime.interruptBusySessionsAfterRestart())).toBeNull();
    } finally {
      sessionRuntime.dispose();
    }
  });

  it('uses manual guidance for a batch with an exhausted session', () => {
    expect(buildRestartNotification({ sessionIds: ['used', 'new'], autoResumeSessionIds: ['new'] }))
      .toMatchObject({
        kind: 'opencode-restart-interrupted',
        body: 'OpenCode restarted during running responses. Send a message in each chat to continue.',
      });
  });
});
