import { EventEmitter } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createFrontDoor } from './front-door.js';

it('keeps native SSE event shape and waits for drain without dropping a large healthy event', async () => {
  // Given a response whose high-water mark is exceeded by one legitimate tool result.
  let publish;
  const hub = { subscribeEvent: (callback) => { publish = callback; return () => {}; }, start() {} };
  const door = createFrontDoor({ upstream: { close() {} }, getSpacesHost: () => null, hub });
  const res = new EventEmitter();
  res.set = () => {};
  res.flushHeaders = () => {};
  res.destroy = vi.fn(() => { res.destroyed = true; res.emit('close'); });
  res.write = vi.fn((block) => !block.includes('large-result'));
  onTestFinished(() => { res.emit('close'); door.close(); });
  door.serveEvents({ url: '/api/global/event', headers: {} }, res);
  await Promise.resolve();
  // When a large event is followed by another while the first waits for drain.
  publish({ eventId: 'e1', directory: '/work', origin: 'agent', spaceId: null,
    payload: { type: 'session.text.ended', data: { text: `large-result${'x'.repeat(64 * 1024)}` } } });
  publish({ eventId: 'e2', directory: '/work', origin: 'agent', spaceId: null, payload: { type: 'session.idle' } });
  await Promise.resolve();
  expect(res.destroy).not.toHaveBeenCalled();
  expect(res.write).toHaveBeenCalledTimes(2);
  const data = JSON.parse(res.write.mock.calls[1][0].split('data: ')[1].trim());
  // Then the pinned SDK receives the native top-level type, not a WS envelope.
  expect(data.type).toBe('session.text.ended');
  expect(data).toMatchObject({ origin: 'agent', spaceId: null });
  expect(data).not.toHaveProperty('payload');
  res.emit('drain');
  await Promise.resolve();
  await Promise.resolve();
  expect(res.write).toHaveBeenCalledTimes(3);
});
