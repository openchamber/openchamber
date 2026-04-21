import { describe, expect, it } from 'vitest';

import { createGlobalUiEventBroadcaster } from './runtime.js';

describe('event stream broadcaster', () => {
  it('fans out synthetic events to SSE and WS clients', () => {
    const sseEvents = [];
    const wsPayloads = [];
    const sseClient = { id: 'sse-1' };
    const wsClient = {
      readyState: 1,
      send(payload) {
        wsPayloads.push(JSON.parse(payload));
      },
    };

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set([sseClient]),
      wsClients: new Set([wsClient]),
      writeSseEvent(res, payload) {
        sseEvents.push({ res, payload });
      },
    });

    broadcast({ type: 'openchamber:session-status' }, { eventId: 'evt-1', directory: '/tmp/project' });

    expect(sseEvents).toEqual([
      {
        res: sseClient,
        payload: { type: 'openchamber:session-status' },
      },
    ]);
    expect(wsPayloads).toEqual([
      {
        type: 'event',
        payload: { type: 'openchamber:session-status' },
        eventId: 'evt-1',
        directory: '/tmp/project',
      },
    ]);
  });

  it('removes websocket clients that fail to receive a payload', () => {
    const wsClients = new Set([
      {
        readyState: 1,
        send() {
          throw new Error('socket write failed');
        },
      },
    ]);

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set(),
      wsClients,
      writeSseEvent() {
        throw new Error('should not be called');
      },
    });

    broadcast({ type: 'openchamber:notification' });

    expect(wsClients.size).toBe(0);
  });
});
