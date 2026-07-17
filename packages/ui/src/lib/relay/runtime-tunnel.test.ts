import { afterEach, describe, expect, test } from 'bun:test';

import {
  activateRuntimeTunnel,
  deactivateRelayTunnel,
  setRuntimeTunnelClientFactoriesForTests,
  type RuntimeTunnelDescriptor,
} from './runtime-tunnel';
import type { RelayTunnelClient } from './tunnel-client';

const direct: RuntimeTunnelDescriptor = {
  type: 'direct-e2ee',
  wssUrl: 'wss://direct.example.test/api/openchamber/direct-e2ee/ws',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
};
const hosted: RuntimeTunnelDescriptor = {
  type: 'relay', relayUrl: 'wss://relay.example.test', serverId: 'server',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
};

const fakeClient = (closed: { value: boolean }): RelayTunnelClient => ({
  fetch: async () => new Response(),
  openWebSocket: () => { throw new Error('unused'); },
  getStatus: () => ({ state: 'idle' }),
  subscribeStatus: () => () => {},
  close: () => { closed.value = true; },
});

afterEach(() => setRuntimeTunnelClientFactoriesForTests(null));

describe('runtime tunnel activation identity', () => {
  test('reuses the same direct descriptor with the same token', () => {
    let calls = 0;
    setRuntimeTunnelClientFactoriesForTests({ createDirect: () => { calls += 1; return fakeClient({ value: false }); } });
    const first = activateRuntimeTunnel(direct, 'token-a');
    expect(activateRuntimeTunnel(direct, 'token-a')).toBe(first);
    expect(calls).toBe(1);
  });

  test('changed direct token closes and recreates with the new token', () => {
    const tokens: Array<string | null | undefined> = [];
    const closes: Array<{ value: boolean }> = [];
    setRuntimeTunnelClientFactoriesForTests({ createDirect: (_descriptor, token) => {
      tokens.push(token); const closed = { value: false }; closes.push(closed); return fakeClient(closed);
    } });
    activateRuntimeTunnel(direct, 'token-a');
    activateRuntimeTunnel(direct, 'token-b');
    expect(tokens).toEqual(['token-a', 'token-b']);
    expect(closes[0].value).toBe(true);
  });

  test('hosted relay reuse ignores client token and receives no readiness token', () => {
    let calls = 0;
    setRuntimeTunnelClientFactoriesForTests({ createHosted: () => { calls += 1; return fakeClient({ value: false }); } });
    const first = activateRuntimeTunnel(hosted, 'token-a');
    expect(activateRuntimeTunnel(hosted, 'token-b')).toBe(first);
    expect(calls).toBe(1);
  });

  test('deactivation clears direct token identity', () => {
    const tokens: Array<string | null | undefined> = [];
    setRuntimeTunnelClientFactoriesForTests({ createDirect: (_descriptor, token) => { tokens.push(token); return fakeClient({ value: false }); } });
    activateRuntimeTunnel(direct, 'token-a');
    deactivateRelayTunnel();
    activateRuntimeTunnel(direct, 'token-a');
    expect(tokens).toEqual(['token-a', 'token-a']);
  });
});
