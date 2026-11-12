import { describe, expect, test } from 'bun:test';

import type { RelayTunnelStatus } from '@/lib/relay/tunnel-client';

import { fetchThroughRelayOnce, fetchThroughRelayWithRetry } from './mobileRelayFetch';

// A tunnel stand-in: each fetch takes the next scripted step; status changes are
// pushed to subscribers the way the real client reports reconnects.
const createScriptedTunnel = (steps: Array<() => Promise<Response>>, initial: RelayTunnelStatus = { state: 'connecting' }) => {
  let status = initial;
  const listeners = new Set<(next: RelayTunnelStatus) => void>();
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    setStatus(next: RelayTunnelStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
    fetch: () => {
      const step = steps[calls] ?? steps[steps.length - 1];
      calls += 1;
      return step();
    },
    getStatus: () => status,
    subscribeStatus(listener: (next: RelayTunnelStatus) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('fetchThroughRelayWithRetry', () => {
  test('asks again once the tunnel reconnects after a dropped socket', async () => {
    const tunnel = createScriptedTunnel([
      async () => {
        tunnel.setStatus({ state: 'reconnecting', lastError: 'relay socket closed (code 1006)' });
        throw new Error('relay socket closed (code 1006)');
      },
      async () => new Response('ok', { status: 200 }),
    ]);
    const pending = fetchThroughRelayWithRetry(tunnel, '/health', undefined, 1000);
    await wait(20);
    tunnel.setStatus({ state: 'connected' });
    const outcome = await pending;
    expect(outcome.response?.status).toBe(200);
    expect(outcome.failure).toBeNull();
    expect(tunnel.calls).toBe(2);
  });

  test('stops at once on a terminal rejection and reports why', async () => {
    const tunnel = createScriptedTunnel([async () => {
      tunnel.setStatus({ state: 'error', lastError: 'relay connection limit reached', terminal: true });
      throw new Error('relay connection limit reached');
    }]);
    const startedAt = Date.now();
    const outcome = await fetchThroughRelayWithRetry(tunnel, '/health', undefined, 1000);
    expect(outcome).toEqual({ response: null, failure: 'relay connection limit reached' });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(tunnel.calls).toBe(1);
  });

  test('gives up with the last failure when the tunnel does not come back in budget', async () => {
    const tunnel = createScriptedTunnel([async () => {
      tunnel.setStatus({ state: 'reconnecting', lastError: 'relay socket closed (code 1006)' });
      throw new Error('relay socket closed (code 1006)');
    }]);
    const outcome = await fetchThroughRelayWithRetry(tunnel, '/health', undefined, 60);
    expect(outcome).toEqual({ response: null, failure: 'relay socket closed (code 1006)' });
    expect(tunnel.calls).toBe(1);
  });

  test('does not repeat a request that failed while the channel stayed up', async () => {
    const tunnel = createScriptedTunnel([async () => {
      throw new Error('relay stream reset');
    }], { state: 'connected' });
    const outcome = await fetchThroughRelayWithRetry(tunnel, '/health', undefined, 1000);
    expect(outcome.failure).toBe('relay stream reset');
    expect(tunnel.calls).toBe(1);
  });
});

describe('fetchThroughRelayOnce', () => {
  test('reports a timeout when nothing answers in budget', async () => {
    const tunnel = createScriptedTunnel([() => new Promise<Response>(() => undefined)], { state: 'connected' });
    expect(await fetchThroughRelayOnce(tunnel, '/health', undefined, 30)).toEqual({ response: null, failure: 'timeout' });
  });
});
