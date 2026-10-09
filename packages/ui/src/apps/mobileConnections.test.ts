import { describe, expect, mock, test } from 'bun:test';

import { adoptRelayTunnel, getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

import { autoConnectLastInstance, createMobilePasswordOperationTracker, loadMobileConnections, migrateLegacyInlineTokenRecords, upsertMobileConnection, validateMobileConnectionSession, type MobileRelayConfig } from './mobileConnections';

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

const installTestWindow = (native = false) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol: 'https:' },
      Capacitor: { isNativePlatform: () => native },
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
  test('native LAN metadata keeps both instances and their secure-token flags', async () => {
    try {
      installTestWindow(true);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
        {
          id: 'native-a', label: 'Server A', lastUsedAt: 10, hasToken: true,
          candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606' }],
        },
      ]));
      await upsertMobileConnection({
        label: 'Server B',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.20:2606' }],
      });

      const reloaded = await loadMobileConnections();
      expect(reloaded).toHaveLength(2);
      expect(reloaded.find((connection) => connection.id === 'native-a')).toMatchObject({
        label: 'Server A', hasToken: true,
        candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606' }],
      });
      expect(reloaded.find((connection) => connection.label === 'Server B')?.id).not.toBe('native-a');
      expect(reloaded.every((connection) => connection.clientToken === undefined)).toBe(true);
    } finally {
      restoreGlobals();
    }
  });

  test('LAN servers keep separate identities and credentials after re-pairing and reload', async () => {
    try {
      installTestWindow();
      const first = await upsertMobileConnection({
        label: 'Server A',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606' }],
        clientToken: 'token-a',
      });
      const firstId = first[0]?.id;
      const second = await upsertMobileConnection({
        label: 'Server B',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.20:2606' }],
        clientToken: 'token-b',
      });
      expect(second).toHaveLength(2);
      const secondId = second[0]?.id;
      expect(secondId).not.toBe(firstId);

      await upsertMobileConnection({
        label: 'Server A paired again',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606/' }],
        clientToken: 'token-a-new',
      });

      const reloaded = await loadMobileConnections();
      expect(reloaded).toHaveLength(2);
      expect(reloaded.find((connection) => connection.id === firstId)).toMatchObject({
        label: 'Server A paired again', clientToken: 'token-a-new',
      });
      expect(reloaded.find((connection) => connection.id === secondId)).toMatchObject({
        label: 'Server B', clientToken: 'token-b',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.20:2606' }],
      });
    } finally {
      restoreGlobals();
    }
  });

  test('adding a LAN server preserves a legacy saved LAN server', async () => {
    try {
      installTestWindow();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
        { id: 'legacy-a', label: 'Server A', url: 'http://192.168.1.10:2606', lastUsedAt: 10, clientToken: 'token-a' },
      ]));
      await upsertMobileConnection({
        label: 'Server B',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.20:2606' }],
        clientToken: 'token-b',
      });

      const reloaded = await loadMobileConnections();
      expect(reloaded).toHaveLength(2);
      expect(reloaded.find((connection) => connection.id === 'legacy-a')).toMatchObject({
        label: 'Server A', clientToken: 'token-a',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606' }],
      });
    } finally {
      restoreGlobals();
    }
  });

  test('relay servers stay distinct and re-pair by server identity when the LAN address changes', async () => {
    try {
      installTestWindow();
      const first = await upsertMobileConnection({
        label: 'Server A',
        candidates: [
          { kind: 'direct', url: 'http://192.168.1.10:2606' },
          { kind: 'relay', relay: testRelay },
        ],
        clientToken: 'token-a',
      });
      const firstId = first[0]?.id;
      const secondRelay = { ...testRelay, serverId: 'srv_second' };
      const second = await upsertMobileConnection({
        label: 'Server B',
        candidates: [{ kind: 'relay', relay: secondRelay }],
        clientToken: 'token-b',
      });
      const secondId = second[0]?.id;
      expect(second).toHaveLength(2);
      expect(secondId).not.toBe(firstId);

      await upsertMobileConnection({
        label: 'Server A paired again',
        candidates: [
          { kind: 'direct', url: 'http://192.168.1.30:2606' },
          { kind: 'relay', relay: testRelay },
        ],
        clientToken: 'token-a-new',
      });

      const reloaded = await loadMobileConnections();
      expect(reloaded).toHaveLength(2);
      expect(reloaded.find((connection) => connection.id === firstId)).toMatchObject({
        label: 'Server A paired again', clientToken: 'token-a-new',
        candidates: [
          { kind: 'direct', url: 'http://192.168.1.30:2606' },
          { kind: 'relay', relay: testRelay },
        ],
      });
      expect(reloaded.find((connection) => connection.id === secondId)).toMatchObject({
        label: 'Server B', clientToken: 'token-b',
        candidates: [{ kind: 'relay', relay: secondRelay }],
      });
    } finally {
      restoreGlobals();
    }
  });

  test('cancellation invalidates an in-flight password completion', async () => {
    const tracker = createMobilePasswordOperationTracker();
    const operation = tracker.begin();
    let resolveLogin: () => void = () => {
      throw new Error('Login was not started');
    };
    let switchedRuntime = false;
    const completion = new Promise<void>((resolve) => { resolveLogin = resolve; }).then(() => {
      if (tracker.isCurrent(operation)) switchedRuntime = true;
    });

    tracker.cancel();
    resolveLogin();
    await completion;

    expect(switchedRuntime).toBe(false);
  });

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

// The tunnel client imports the host key before it dials, so it must be real.
const relayHostKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const liveRelay: MobileRelayConfig = { ...testRelay, hostEncPubJwk: await crypto.subtle.exportKey('jwk', relayHostKeys.publicKey) };

describe('relay probe while the runtime is on the relay', () => {
  const originalWebSocket = globalThis.WebSocket;

  // Every relay dial from this device. The hosted relay keeps one client leg per
  // server, so a dial here would replace the runtime's live leg.
  const dials: string[] = [];
  class RecordingRelaySocket {
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    constructor(url: string) {
      dials.push(url);
      setTimeout(() => this.onclose?.({ code: 4002, reason: 'relay connection replaced by another client' }), 0);
    }
    send() {}
    close() {}
  }

  const connectThroughRuntimeTunnel = (answer: (path: string) => Promise<Response>) => {
    const requests: string[] = [];
    let closed = 0;
    const tunnel: RelayTunnelClient = {
      fetch: (input) => {
        requests.push(String(input));
        return answer(String(input));
      },
      openWebSocket() { throw new Error('the probe opens no socket'); },
      getStatus: () => ({ state: 'connected' }),
      subscribeStatus: () => () => undefined,
      close: () => { closed += 1; },
    };
    adoptRelayTunnel(liveRelay, tunnel);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://localhost', clientToken: null, runtimeKey: 'relay-device', relay: liveRelay });
    return { requests, closedCount: () => closed };
  };

  const installRelayWindow = () => {
    dials.length = 0;
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: RecordingRelaySocket });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(new EventTarget(), {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        location: { protocol: 'https:', origin: 'https://localhost' },
        Capacitor: { isNativePlatform: () => false },
        localStorage: createLocalStorageStub(),
      }),
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: 'relay-device', label: 'Relay', lastUsedAt: 1, candidates: [{ kind: 'relay', relay: liveRelay }] },
    ]));
  };

  const restoreRelayGlobals = () => {
    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    restoreGlobals();
  };

  test('a background auto-connect asks through the live tunnel and leaves it open', async () => {
    try {
      installRelayWindow();
      const runtime = connectThroughRuntimeTunnel(async () => Response.json({ authenticated: true, scope: 'client' }));

      const outcome = await autoConnectLastInstance({ fast: false, skipIfConnected: true });

      expect(outcome).toEqual({ status: 'no-candidate' });
      expect(runtime.requests).toContain('/auth/session');
      expect(dials).toEqual([]);
      expect(runtime.closedCount()).toBe(0);
      expect(getActiveRelayTunnel()?.getStatus().state).toBe('connected');
    } finally {
      restoreRelayGlobals();
    }
  });

  test('a probe dials its own tunnel only when the live one gives no answer', async () => {
    try {
      installRelayWindow();
      const runtime = connectThroughRuntimeTunnel(async () => { throw new Error('relay tunnel reset'); });

      const outcome = await autoConnectLastInstance({ fast: true, skipIfConnected: true });

      expect(outcome.status).toBe('unreachable');
      expect(runtime.requests).toContain('/auth/session');
      expect(dials).toHaveLength(1);
      expect(runtime.closedCount()).toBe(0);
    } finally {
      restoreRelayGlobals();
    }
  });
});
