import { describe, expect, it, vi } from 'vitest';

import { createSessionRuntime } from './session-runtime.js';

describe('managed OpenCode restart session recovery', () => {
  it('settles busy sessions and broadcasts one interruption notification', () => {
    const events = [];
    const broadcastUiNotification = vi.fn();
    const rebindUpstream = vi.fn();
    const sessionRuntime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: (event) => events.push(event),
    });
    const onOpenCodeRestarted = () => {
      rebindUpstream();
      const { sessionIds } = sessionRuntime.interruptBusySessionsAfterRestart();
      if (sessionIds.length > 0) {
        const multiple = sessionIds.length > 1;
        broadcastUiNotification({
          title: multiple ? 'Chats interrupted' : 'Chat interrupted',
          body: multiple
            ? 'OpenCode restarted during running responses. Send a message in each chat to continue.'
            : 'OpenCode restarted during a running response. Send a message to continue.',
          tag: 'opencode-restart-interrupted',
          kind: 'opencode-restart-interrupted',
          sessionId: sessionIds[0],
        });
      }
    };
    const markBusy = (sessionID) => sessionRuntime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    });

    try {
      markBusy('session-1');
      markBusy('session-2');
      markBusy('session-3');
      events.length = 0;

      onOpenCodeRestarted();

      expect(rebindUpstream).toHaveBeenCalledOnce();
      expect(sessionRuntime.getActiveSessionCount()).toBe(0);
      expect(Object.values(sessionRuntime.getSessionStateSnapshot()).map((state) => state.status))
        .toEqual(['idle', 'idle', 'idle']);
      expect(events.filter((event) => event.type === 'openchamber:session-status')).toHaveLength(3);
      expect(events.filter((event) => event.type === 'session.error')).toHaveLength(3);
      expect(broadcastUiNotification).toHaveBeenCalledOnce();
      expect(broadcastUiNotification).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'opencode-restart-interrupted',
        sessionId: 'session-1',
      }));
    } finally {
      sessionRuntime.dispose();
    }
  });
});
