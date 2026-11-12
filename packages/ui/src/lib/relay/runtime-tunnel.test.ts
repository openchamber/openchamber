import { afterEach, describe, expect, test } from 'bun:test';

import { adoptRelayTunnel, deactivateRelayTunnel, subscribeActiveRelayTunnelStatus } from './runtime-tunnel';
import type { RelayTunnelClient, RelayTunnelStatus } from './tunnel-client';

const descriptor = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv_test',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eA', y: 'eQ' },
};

const createFakeTunnel = () => {
  const listeners = new Set<(status: RelayTunnelStatus) => void>();
  let status: RelayTunnelStatus = { state: 'connected' };
  const client: RelayTunnelClient = {
    fetch: () => Promise.reject(new Error('unused')),
    openWebSocket() { throw new Error('unused'); },
    getStatus: () => status,
    subscribeStatus(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    retry: () => undefined,
    close: () => {
      status = { state: 'idle' };
      for (const listener of listeners) listener(status);
    },
  };
  const emit = (next: RelayTunnelStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };
  return { client, emit, listenerCount: () => listeners.size };
};

const limitStatus: RelayTunnelStatus = { state: 'error', lastError: 'relay connection limit reached', terminal: true, closeCode: 4029 };

describe('active relay tunnel status', () => {
  afterEach(() => deactivateRelayTunnel());

  test('follows the runtime tunnel across replacement and stops listening to the old one', () => {
    const seen: RelayTunnelStatus[] = [];
    const unsubscribe = subscribeActiveRelayTunnelStatus((status) => seen.push(status));
    const first = createFakeTunnel();
    const second = createFakeTunnel();

    adoptRelayTunnel(descriptor, first.client);
    adoptRelayTunnel({ ...descriptor, serverId: 'srv_other' }, second.client);
    // The replaced tunnel closed on its way out and is no longer followed.
    expect(seen).toEqual([{ state: 'idle' }]);
    expect(first.listenerCount()).toBe(0);
    first.emit(limitStatus);
    expect(seen).toHaveLength(1);

    second.emit(limitStatus);
    expect(seen.at(-1)).toEqual(limitStatus);
    unsubscribe();
    second.emit({ state: 'connected' });
    expect(seen.at(-1)).toEqual(limitStatus);
  });

  test('deactivation detaches from the tunnel', () => {
    const tunnel = createFakeTunnel();
    adoptRelayTunnel(descriptor, tunnel.client);
    expect(tunnel.listenerCount()).toBe(1);
    deactivateRelayTunnel();
    expect(tunnel.listenerCount()).toBe(0);
  });
});
