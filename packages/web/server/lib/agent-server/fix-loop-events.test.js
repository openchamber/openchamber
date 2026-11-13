import { expect, test, vi } from 'vitest';
import { createAgentStreams } from './agent-streams.js';
import { parseAgentStreamEvent } from './agent-stream-schemas.js';
import { autoLoop } from './fix-loop-test-fixture.js';

test('agent auto events can neither overwrite nor remove owner loop and worker IDs', async () => {
  const controllers = new Map();
  const broadcast = vi.fn();
  const stream = createAgentStreams({ upstream: { buildUrl: (path) => `http://agent${path}`,
    fetch: async (url, { signal }) => new Response(new ReadableStream({ start(controller) {
      controllers.set(new URL(url).pathname, controller); signal.addEventListener('abort', () => controller.close(), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }) }, broadcastUiEvent: broadcast, broadcastGlobalUiEvent: broadcast,
  isOwnerFixLoopIdentity: (id) => ['fixloop_owner', 'worker-owner', 'receipt-owner'].includes(id) });
  stream.start(); await Promise.resolve();
  const send = async (properties) => {
    controllers.get('/api/openchamber/events').enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'openchamber:pr-fix-loop.updated', properties })}\n\n`));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    for (const id of ['fixloop_owner', 'worker-owner', 'receipt-owner']) {
      await send({ loop: autoLoop(id) }); await send({ id, removed: true });
    }
    await send({ loop: autoLoop() }); await send({ id: 'fixloop_agent', removed: true });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ origin: 'agent', properties: { loop: { id: 'fixloop_agent', totalIterations: 0 } } });
    expect(broadcast.mock.calls[1][0].properties).toMatchObject({ id: 'fixloop_agent', removed: true });
  } finally { await stream.close(); }
});
test('typed agent auto events refuse review approval claims before fanout', () => {
  const logger = { warn: vi.fn() };
  expect(parseAgentStreamEvent({ type: 'openchamber:pr-fix-loop.updated', properties: { loop: autoLoop() } }, 'control', logger)).not.toBeNull();
  for (const state of ['awaitingPublication', 'pending', 'blocked', 'complete']) {
    const loop = { ...autoLoop(), review: { state, actions: [], completed: 0, total: 0, lastError: null } };
    expect(parseAgentStreamEvent({ type: 'openchamber:pr-fix-loop.updated', properties: { loop } }, 'control', logger)).toBeNull();
  }
  expect(logger.warn).toHaveBeenCalledTimes(4);
});
