import { describe, expect, mock, test } from 'bun:test';

import { deleteMobileConnection, loadMobileConnections, mobilePairingFailureKey, probeConnectionCandidates, upsertMobileConnection, validateMobileConnectionSession, type MobileDirectE2eeConfig, type MobileRelayConfig } from './mobileConnections';
import type { RelayTunnelClient, RelayTunnelFailureClassification } from '@/lib/relay/tunnel-client';
import { PairingRedemptionError } from '@/lib/pairingCandidateRedemption';
import { dict as englishMessages } from '@/lib/i18n/messages/en';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

const createLocalStorageStub = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
};

const installTestWindow = (protocol = 'https:') => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol },
      localStorage: createLocalStorageStub(),
    },
  });
};

const restoreGlobals = () => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
};

const STORAGE_KEY = 'openchamber.mobile.connections.v1';

const testRelay: MobileRelayConfig = {
  relayUrl: 'wss://relay.example/tunnel',
  serverId: 'srv_test123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
};

describe('mobile connection storage', () => {
  test('native secure storage operations and migration never log connection descriptors or secrets', async () => {
    const sentinels = [
      'sentinel.example',
      'wss://sentinel.example/api/openchamber/direct-e2ee/ws',
      'sentinel-token',
      'sentinel-jwk-x',
      'sentinel-jwk-y',
    ];
    const logs: unknown[][] = [];
    const originalInfo = console.info;
    const originalWarn = console.warn;
    console.info = (...args: unknown[]) => { logs.push(args); };
    console.warn = (...args: unknown[]) => { logs.push(args); };
    try {
      installTestWindow('capacitor:');
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{
        id: 'legacy', label: 'Legacy', url: 'https://sentinel.example', lastUsedAt: 1, clientToken: 'sentinel-token',
      }]));
      await loadMobileConnections();
      const saved = await upsertMobileConnection({
        label: 'Sentinel',
        candidates: [{ kind: 'direct-e2ee', directE2ee: {
          wssUrl: sentinels[1]!,
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: sentinels[3], y: sentinels[4] },
        } }],
        clientToken: sentinels[2],
      });
      await deleteMobileConnection(saved[0]!.id);
      const output = JSON.stringify(logs);
      for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
    } finally {
      console.info = originalInfo;
      console.warn = originalWarn;
      restoreGlobals();
    }
  });

  test('entries persisted before candidates migrate to a single direct candidate', async () => {
    try {
      installTestWindow();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
        { id: 'a', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10, clientToken: 'tok-a' },
        { id: 'b', label: 'Work', url: 'http://work.example', lastUsedAt: 5 },
      ]));

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(2);
      const home = connections.find((c) => c.id === 'a')!;
      expect(home.candidates).toEqual([{ kind: 'direct', url: 'http://192.168.1.10:2606' }]);
      expect(home.clientToken).toBe('tok-a');
    } finally {
      restoreGlobals();
    }
  });

  test('a relay device round-trips its candidate + token', async () => {
    try {
      installTestWindow();

      await upsertMobileConnection({
        label: 'My Desktop',
        candidates: [{ kind: 'relay', relay: testRelay }],
        clientToken: 'oc_client_secret',
      });

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(1);
      const saved = connections[0]!;
      expect(saved.candidates).toEqual([{ kind: 'relay', relay: testRelay }]);
      // Web surface: token stays inline like direct connections.
      expect(saved.clientToken).toBe('oc_client_secret');

      // Persisted metadata carries only the three transport fields — no grant/token.
      const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
      const rawCandidate = (raw[0]?.candidates as Array<Record<string, unknown>>)[0];
      expect(rawCandidate.kind).toBe('relay');
      expect(Object.keys(rawCandidate.relay as object).sort()).toEqual(['hostEncPubJwk', 'relayUrl', 'serverId']);
    } finally {
      restoreGlobals();
    }
  });

  test('a multi-transport device persists all candidates in order (LAN then relay)', async () => {
    try {
      installTestWindow();
      await upsertMobileConnection({
        label: 'Both',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.5:2606' }, { kind: 'relay', relay: testRelay }],
        clientToken: 'tok',
      });

      const connections = await loadMobileConnections();
      expect(connections[0]?.candidates.map((c) => c.kind)).toEqual(['direct', 'relay']);
    } finally {
      restoreGlobals();
    }
  });

  test('a direct E2EE device persists only its public pinned descriptor and token', async () => {
    try {
      installTestWindow();
      await upsertMobileConnection({
        label: 'E2EE',
        candidates: [{ kind: 'direct-e2ee', directE2ee: {
          wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
          hostEncPubJwk: testRelay.hostEncPubJwk,
        } }],
        clientToken: 'oc_client_token',
      });
      const raw = window.localStorage.getItem(STORAGE_KEY) || '';
      expect(raw).toContain('direct-e2ee');
      expect(raw).not.toContain('pairingId');
      expect(raw).not.toContain('one-time');
    } finally {
      restoreGlobals();
    }
  });

  test('a legacy relay entry with malformed transport config is dropped, direct entries survive', async () => {
    try {
      installTestWindow();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
        { id: 'bad', label: 'Broken', lastUsedAt: 20, mode: 'relay', relay: { relayUrl: 'wss://relay.example' } },
        { id: 'ok', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10 },
      ]));

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]?.id).toBe('ok');
      expect(connections[0]?.candidates[0]?.kind).toBe('direct');
    } finally {
      restoreGlobals();
    }
  });

  test('relay and direct devices dedupe independently by candidate identity', async () => {
    try {
      installTestWindow();
      await upsertMobileConnection({ label: 'Direct', candidates: [{ kind: 'direct', url: 'http://host.example' }] });
      await upsertMobileConnection({ label: 'Relay', candidates: [{ kind: 'relay', relay: testRelay }] });
      await upsertMobileConnection({ label: 'Relay renamed', candidates: [{ kind: 'relay', relay: testRelay }] });

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(2);
      const relayEntries = connections.filter((c) => c.candidates.some((x) => x.kind === 'relay'));
      expect(relayEntries).toHaveLength(1);
      expect(relayEntries[0]?.label).toBe('Relay renamed');
    } finally {
      restoreGlobals();
    }
  });
});

describe('validateMobileConnectionSession', () => {
  test('accepts a reachable authenticated runtime', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      if (url.endsWith('/auth/session')) return Response.json({ authenticated: true, scope: 'client' });
      return new Response(null, { status: 404 });
    });
    try {
      installTestWindow();
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'token' });
      expect(result).toBe(true);
    } finally {
      restoreGlobals();
    }
  });

  test('rejects unreachable runtimes', async () => {
    try {
      installTestWindow();
      globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'token' });
      expect(result).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  test('rejects invalid or unauthenticated sessions', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      return Response.json({ authenticated: false }, { status: 401 });
    });
    try {
      installTestWindow();
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'expired' });
      expect(result).toBe(false);
    } finally {
      restoreGlobals();
    }
  });
});

describe('mobile encrypted candidate fallback policy', () => {
  const directE2ee: MobileDirectE2eeConfig = {
    wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
    hostEncPubJwk: testRelay.hostEncPubJwk,
  };

  const failingClient = (failureClassification: RelayTunnelFailureClassification): RelayTunnelClient => ({
    fetch: async () => { throw new Error('direct failed'); },
    openWebSocket: () => { throw new Error('unused'); },
    getStatus: () => ({ state: failureClassification === 'network' ? 'reconnecting' : 'error', failureClassification }),
    subscribeStatus: () => () => {},
    close: () => {},
  });

  test('does not probe relay after direct crypto, protocol, or terminal failure', async () => {
    for (const failureClassification of ['crypto', 'protocol', 'terminal'] as const) {
      let relayCalls = 0;
      const result = await probeConnectionCandidates([
        { kind: 'direct-e2ee', directE2ee },
        { kind: 'relay', relay: testRelay },
      ], 'token', {
        createDirectE2eeClient: () => failingClient(failureClassification),
        probeRelay: async () => { relayCalls += 1; return 'ok'; },
      });
      expect(result.status).toBe('security');
      expect(relayCalls).toBe(0);
    }
  });

  test('probes relay after an ordinary unreachable direct failure', async () => {
    let relayCalls = 0;
    const result = await probeConnectionCandidates([
      { kind: 'direct-e2ee', directE2ee },
      { kind: 'relay', relay: testRelay },
    ], 'token', {
      createDirectE2eeClient: () => failingClient('network'),
      probeRelay: async () => { relayCalls += 1; return 'ok'; },
    });
    expect(result.status).toBe('ok');
    expect(relayCalls).toBe(1);
  });
});

describe('mobile pairing failure messages', () => {
  test('maps every pairing classification and unknown errors to fixed localized keys', () => {
    const cases = [
      ['unreachable', 'mobile.connect.error.unreachable'],
      ['security', 'mobile.connect.error.pairingSecurity'],
      ['credential', 'mobile.connect.error.authRequired'],
      ['ambiguous', 'mobile.connect.error.pairingUncertain'],
      ['authorization', 'mobile.connect.error.authRequired'],
    ] as const;

    for (const [classification, expected] of cases) {
      expect(mobilePairingFailureKey(new PairingRedemptionError(classification, 'sensitive detail'))).toBe(expected);
    }
    expect(mobilePairingFailureKey(new Error('unknown sensitive detail'))).toBe('mobile.connect.error.pairingUncertain');
  });

  test('mobile pairing errors render safe copy without raw failure details or classification tokens', () => {
    const sensitive = 'wss://private.example crypto protocol credential authorization';
    const errors = [
      new PairingRedemptionError('security', sensitive),
      new PairingRedemptionError('ambiguous', sensitive),
      new Error(sensitive),
    ];

    for (const error of errors) {
      const message = englishMessages[mobilePairingFailureKey(error)];
      expect(message).toBeTruthy();
      expect(message).not.toContain('private.example');
      expect(message).not.toContain('crypto');
      expect(message).not.toContain('protocol');
      expect(message).not.toContain('credential');
      expect(message).not.toContain('authorization');
    }
  });
});
