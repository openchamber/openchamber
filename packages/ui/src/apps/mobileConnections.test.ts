import { describe, expect, mock, test } from 'bun:test';

import { autoConnectLastInstance, deleteMobileConnection, loadMobileConnections, migrateLegacyInlineTokenRecords, upsertMobileConnection, validateMobileConnectionSession, type MobileRelayConfig } from './mobileConnections';

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

const installTestWindow = (extra: Record<string, unknown> = {}) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol: 'https:' },
      localStorage: createLocalStorageStub(),
      ...extra,
    },
  });
};

const respondToHarmonyRequest = (requestId: string, result: object): void => {
  const receiver = (window as typeof window & {
    __openChamberHarmonyBridgeResult?: (requestId: unknown, value: unknown) => void;
  }).__openChamberHarmonyBridgeResult;
  receiver?.(requestId, JSON.stringify(result));
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
  test('removes inline tokens only after each secure migration succeeds', async () => {
    const result = await migrateLegacyInlineTokenRecords([
      { id: 'ok', url: 'http://ok.example', clientToken: 'token-ok' },
      { id: 'failed', url: 'http://failed.example', clientToken: 'token-failed' },
    ], async (url) => url.includes('ok.example'));

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.records[0]).toEqual({ id: 'ok', url: 'http://ok.example', hasToken: true });
    expect(result.records[1]).toEqual({ id: 'failed', url: 'http://failed.example', clientToken: 'token-failed' });
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

  test('a Harmony connection stores its token only through the secure bridge', async () => {
    const secureValues = new Map<string, string>();
    try {
      installTestWindow({
        openChamberHarmony: {
          getPlatform: () => 'harmony',
          getCapabilities: () => JSON.stringify({ secureStorage: true }),
          secureStorageGet: (requestId: string, key: string) => {
            respondToHarmonyRequest(requestId, { ok: true, value: secureValues.get(key) ?? null });
          },
          secureStorageSet: (requestId: string, key: string, value: string) => {
            secureValues.set(key, value);
            respondToHarmonyRequest(requestId, { ok: true });
          },
          secureStorageRemove: (requestId: string, key: string) => {
            secureValues.delete(key);
            respondToHarmonyRequest(requestId, { ok: true });
          },
        },
      });

      await upsertMobileConnection({
        label: 'Harmony Server',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.8:2606' }],
        clientToken: 'harmony-secret',
      });

      const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
      expect(raw[0]?.hasToken).toBe(true);
      expect(raw[0]?.clientToken).toBe(undefined);
      expect(JSON.stringify(raw)).not.toContain('harmony-secret');
      expect([...secureValues.values()]).toEqual(['harmony-secret']);

      const loaded = await loadMobileConnections();
      expect(loaded[0]?.hasToken).toBe(true);
      expect(loaded[0]?.clientToken).toBe(undefined);

      await deleteMobileConnection(loaded[0]!.id);
      expect(await loadMobileConnections()).toEqual([]);
      expect(secureValues.size).toBe(0);
    } finally {
      restoreGlobals();
    }
  });

  test('a failed Harmony secure write does not persist token metadata', async () => {
    try {
      installTestWindow({
        openChamberHarmony: {
          getPlatform: () => 'harmony',
          getCapabilities: () => JSON.stringify({ secureStorage: true }),
          secureStorageGet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true, value: null }),
          secureStorageSet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: false }),
          secureStorageRemove: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true }),
        },
      });

      await expect(upsertMobileConnection({
        label: 'Unavailable Store',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.9:2606' }],
        clientToken: 'must-not-persist',
      })).rejects.toThrow('secure storage write failed');
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      restoreGlobals();
    }
  });

  test('a failed Harmony secure delete preserves the connection and failure reason', async () => {
    try {
      installTestWindow({
        openChamberHarmony: {
          getPlatform: () => 'harmony',
          getCapabilities: () => JSON.stringify({ secureStorage: true }),
          secureStorageGet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true, value: null }),
          secureStorageSet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true }),
          secureStorageRemove: (requestId: string) => {
            respondToHarmonyRequest(requestId, { ok: false, error: 'invalid-secret' });
          },
        },
      });

      await upsertMobileConnection({
        label: 'Delete failure',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.11:2606' }],
        clientToken: 'must-remain-protected',
      });
      const [saved] = await loadMobileConnections();

      try {
        await deleteMobileConnection(saved!.id);
        throw new Error('Expected secure delete to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as { reason?: unknown }).reason).toBe('invalid-secret');
      }
      expect(await loadMobileConnections()).toHaveLength(1);
    } finally {
      restoreGlobals();
    }
  });

  test('a failed Harmony secure read does not masquerade as a missing saved token', async () => {
    try {
      installTestWindow({
        openChamberHarmony: {
          getPlatform: () => 'harmony',
          getCapabilities: () => JSON.stringify({ secureStorage: true }),
          secureStorageGet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: false }),
          secureStorageSet: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true }),
          secureStorageRemove: (requestId: string) => respondToHarmonyRequest(requestId, { ok: true }),
        },
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{
        id: 'saved',
        label: 'Saved Harmony Server',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606' }],
        lastUsedAt: 1,
        hasToken: true,
      }]));

      expect(await autoConnectLastInstance()).toBe(false);
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
      expect(saved[0]?.hasToken).toBe(true);
      expect(saved[0]?.id).toBe('saved');
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
