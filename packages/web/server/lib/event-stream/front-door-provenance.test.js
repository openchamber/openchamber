import { describe, expect, it } from 'vitest';
import { createGlobalMessageStreamHub } from './global-hub.js';

describe('connection-owned provenance', () => {
  it('drops native events with nested Space locations or known Space session IDs', async () => {
    const received = [];
    let reachedBarrier;
    const barrier = new Promise((resolve) => { reachedBarrier = resolve; });
    const payloads = [
      { type: 'session.moved', location: { directory: '/work' }, data: { sessionID: 'ses_fake', location: { directory: '/spaces/012345abcdef/repo' } } },
      { type: 'session.created', location: { directory: '/work' }, data: { sessionID: 'ses_space' } },
      { type: 'session.created', location: { directory: '/work' }, data: { sessionID: 'ses_agent' } },
    ];
    const hub = createGlobalMessageStreamHub({
      upstreamOrigin: 'agent', isSpaceSession: (id) => id === 'ses_space',
      buildOpenCodeUrl: (route) => `http://agent.test${route}`, getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')));
      } })),
    });
    hub.subscribeEvent((event) => { received.push(event.payload); reachedBarrier(); });
    try {
      hub.start();
      await barrier;
      expect(received).toEqual([payloads[2]]);
    } finally { hub.stop(); }
  });
  it.each([null, 'agent'])('ignores upstream space claims with origin %s', async (upstreamOrigin) => {
    // Given an upstream frame forged as a space event.
    const received = [];
    let publish;
    const arrived = new Promise((resolve) => { publish = resolve; });
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (route) => `http://agent.test${route}`, getOpenCodeAuthHeaders: () => ({}),
      upstreamOrigin, deltaCoalesceWindowMs: 0,
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          directory: '/work/project', spaceId: '012345abcdef', origin: 'space',
          payload: { type: 'session.updated', spaceId: '012345abcdef', origin: 'space', properties: { info: { id: 'ses_test' } } },
        })}\n\n`));
      } })),
    });
    const ordinary = [];
    hub.subscribeEvent((event) => { received.push(event); publish(); }, { spaces: true });
    hub.subscribeEvent((event) => ordinary.push(event));
    try {
      // When the connection delivers it to an ordinary subscriber.
      hub.start();
      await arrived;
      // Then upstream data cannot assign a space, in either server mode.
      expect(received[0]).toMatchObject({ spaceId: null, origin: upstreamOrigin, directory: '/work/project' });
      expect(received[0].payload).not.toHaveProperty('spaceId');
      expect(received[0].payload).not.toHaveProperty('origin');
      if (upstreamOrigin) expect(JSON.parse(received[0].serialize())).toMatchObject({ origin: 'agent', spaceId: null });
      // Owner-injected space events remain a working positive control.
      const spaces = [];
      hub.subscribeEvent((event) => spaces.push(event), { spaces: true });
      hub.injectEvent({ payload: { type: 'session.updated' }, directory: '/spaces/012345abcdef/repo', spaceId: '012345abcdef' });
      expect(spaces[0]).toMatchObject({ origin: 'space', spaceId: '012345abcdef' });
      expect(ordinary).toHaveLength(1);
    } finally { hub.stop(); }
  });
});
