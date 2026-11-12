import { expect, test } from 'bun:test';
import { waitForHmrApi } from './hmr-readiness.mjs';

test('waits for the HMR API to become healthy', async () => {
  let attempts = 0;
  await waitForHmrApi(3901, {
    fetchImpl: async () => new Response('', { status: ++attempts === 1 ? 503 : 200 }),
    sleep: async () => {},
  });
  expect(attempts).toBe(2);
});

test('reports a deadline instead of starting against another server', async () => {
  let time = 0;
  await expect(waitForHmrApi(3901, {
    fetchImpl: async () => { throw new Error('offline'); },
    now: () => time,
    sleep: async () => { time += 250; },
    timeoutMs: 500,
  })).rejects.toThrow('Timed out waiting for the HMR API');
});
