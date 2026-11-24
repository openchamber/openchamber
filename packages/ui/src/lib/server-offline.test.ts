import { afterEach, describe, expect, test } from 'bun:test';
import { adoptRelayTunnel, deactivateRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { isServerOffline } from './server-offline';

const original = { window: globalThis.window, navigator: globalThis.navigator };
const page = ({ onLine, origin, api, ssh, capacitor }: { onLine: boolean; origin: string; api?: string; ssh?: string; capacitor?: boolean }) => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: new URL(origin), __OPENCHAMBER_API_BASE_URL__: api, __OPENCHAMBER_SSH_FORWARD_API_URL__: ssh,
    Capacitor: capacitor ? { isNativePlatform: () => true } : undefined,
  } });
};

afterEach(() => {
  deactivateRelayTunnel();
  for (const [name, value] of Object.entries(original)) Object.defineProperty(globalThis, name, { configurable: true, value });
});

describe('isServerOffline', () => {
  test('a server on this machine is reachable without a network', () => {
    page({ onLine: false, origin: 'http://localhost:3000' });
    expect(isServerOffline()).toBe(false);
    page({ onLine: false, origin: 'https://app.test', api: 'http://127.0.0.1:3001' });
    expect(isServerOffline()).toBe(false);
  });

  test('a server elsewhere is offline with the device', () => {
    page({ onLine: false, origin: 'https://app.test' });
    expect(isServerOffline()).toBe(true);
    page({ onLine: false, origin: 'http://localhost:3000', api: 'https://app.test' });
    expect(isServerOffline()).toBe(true);
    page({ onLine: true, origin: 'https://app.test' });
    expect(isServerOffline()).toBe(false);
  });

  test('a loopback address that leads elsewhere is offline too', () => {
    page({ onLine: false, origin: 'http://localhost', capacitor: true });
    expect(isServerOffline()).toBe(true);
    page({ onLine: false, origin: 'http://localhost:3000', api: 'http://127.0.0.1:4100', ssh: 'http://127.0.0.1:4100' });
    expect(isServerOffline()).toBe(true);
    page({ onLine: false, origin: 'http://localhost:3000' });
    const tunnel: RelayTunnelClient = {
      fetch: async () => new Response(),
      openWebSocket: () => { throw new Error('unused'); },
      getStatus: () => ({ state: 'connected' }),
      subscribeStatus: () => () => undefined,
      retry: () => undefined,
      close: () => undefined,
    };
    adoptRelayTunnel({ relayUrl: 'wss://relay.test', serverId: 'fixture', hostEncPubJwk: {} }, tunnel);
    expect(isServerOffline()).toBe(true);
  });
});
