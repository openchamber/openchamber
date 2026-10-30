import { beforeEach, describe, expect, mock, test } from 'bun:test';

const RELAY = {
  relayUrl: 'wss://relay.example/rooms',
  serverId: 'srv_123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x-value' },
};
// The candidates endpoint strips trailing slashes, so a bare-origin LAN
// address arrives without one. Storage canonicalizes through URL.toString()
// and adds it back. The renderer's normalizeHostUrl keeps the raw string.
const LAN_URL = 'http://192.168.1.20:3000';
const LAN_URL_AS_STORED = 'http://192.168.1.20:3000/';

type StoredHost = {
  id: string;
  url: string;
  apiUrl?: string;
  clientToken?: string;
  relay: typeof RELAY;
};

let storedHosts: StoredHost[] = [];
let storedDropsLearnedApiUrl = false;
let storageWriteFails = false;
let setCalls = 0;
let probeUrls: string[] = [];
let switches: Array<{ apiBaseUrl: string; runtimeKey: string }> = [];
const scheduledCallbacks: Array<() => void> = [];

// The refresh path only reads `window.setTimeout`; the shim records the
// callback so tests run the flow without waiting out the real 5s delay.
const windowShim = {
  setTimeout: (fn: () => void) => {
    scheduledCallbacks.push(fn);
    return 0;
  },
};
Object.assign(globalThis, { window: windowShim });

// The actual modules are captured before mocking and spread into every mock,
// so other exports the import chain reads (isDesktopShell among them) stay
// real. The real desktopHosts module supplies the real `normalizeHostUrl`;
// only the IPC boundaries (get/set/probe) are replaced.
const actualDesktop = await import('@/lib/desktop');
const actualDesktopHosts = await import('@/lib/desktopHosts');
const actualRuntimeFetch = await import('@/lib/runtime-fetch');
const actualRuntimeSwitch = await import('@/lib/runtime-switch');

mock.module('@/lib/desktop', () => ({
  ...actualDesktop,
  isElectronShell: () => true,
}));

// Storage canonicalizes a learned address through URL.toString(), exactly as
// the electron normalizer does, and can simulate an older native build that
// drops a relay host's learned address entirely.
const storeLikeNative = (hosts: StoredHost[]): StoredHost[] => hosts.map((entry) => {
  if (entry.relay && storedDropsLearnedApiUrl) return { ...entry, apiUrl: undefined };
  if (!entry.apiUrl) return entry;
  try {
    return { ...entry, apiUrl: new URL(entry.apiUrl).toString() };
  } catch {
    return entry;
  }
});

mock.module('@/lib/desktopHosts', () => ({
  ...actualDesktopHosts,
  desktopHostProbe: async (url: string) => {
    probeUrls.push(url);
    return { status: 'ok' as const, latencyMs: 3 };
  },
  desktopHostsGet: async () => ({
    hosts: storedHosts,
    defaultHostId: 'host-1',
    initialHostChoiceCompleted: true,
  }),
  desktopHostsSet: async (config: { hosts: StoredHost[] }) => {
    setCalls += 1;
    if (storageWriteFails) throw new Error('write failed');
    storedHosts = storeLikeNative(config.hosts);
    return null;
  },
  getDesktopHostApiUrl: () => null,
}));

mock.module('@/lib/runtime-fetch', () => ({
  ...actualRuntimeFetch,
  runtimeFetch: async () => ({
    ok: true,
    json: async () => ({ serverId: 'srv_123', candidates: [{ type: 'lan', url: LAN_URL }] }),
  }),
}));

mock.module('@/lib/runtime-switch', () => ({
  ...actualRuntimeSwitch,
  getRuntimeKey: () => 'host:host-1',
  switchRuntimeEndpoint: (config: { apiBaseUrl: string; runtimeKey: string }) => {
    switches.push({ apiBaseUrl: config.apiBaseUrl, runtimeKey: config.runtimeKey });
  },
}));

const { scheduleDesktopHostCandidateRefresh } = await import('./desktopRelayRestore');

const runScheduledRefresh = async () => {
  for (const callback of scheduledCallbacks.splice(0)) callback();
  // Every await in the flow settles on mocked promises; a macrotask drains them.
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('desktop host candidate refresh', () => {
  beforeEach(() => {
    storedHosts = [];
    storedDropsLearnedApiUrl = false;
    storageWriteFails = false;
    setCalls = 0;
    probeUrls = [];
    switches = [];
  });

  test('learns the slash-less LAN address, keeps it in storage, and hot-switches', async () => {
    storedHosts = [{ id: 'host-1', url: 'relay://srv_123', relay: RELAY }];

    scheduleDesktopHostCandidateRefresh('host-1');
    await runScheduledRefresh();

    expect(setCalls).toBe(1);
    expect(storedHosts[0]?.apiUrl).toBe(LAN_URL_AS_STORED);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.apiBaseUrl).toBe(LAN_URL);
    expect(switches[0]?.runtimeKey).toBe('host:host-1');
  });

  test('does not rewrite storage when the stored address is the same server', async () => {
    storedHosts = [{ id: 'host-1', url: 'relay://srv_123', apiUrl: LAN_URL_AS_STORED, relay: RELAY }];

    scheduleDesktopHostCandidateRefresh('host-1');
    await runScheduledRefresh();

    expect(setCalls).toBe(0);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.apiBaseUrl).toBe(LAN_URL);
  });

  test('does not switch when storage dropped the learned address', async () => {
    storedDropsLearnedApiUrl = true;
    storedHosts = [{ id: 'host-1', url: 'relay://srv_123', relay: RELAY }];

    scheduleDesktopHostCandidateRefresh('host-1');
    await runScheduledRefresh();

    expect(setCalls).toBe(1);
    expect(probeUrls).toEqual([]);
    expect(switches).toEqual([]);
  });

  test('keeps relay and the previous address when the storage write fails', async () => {
    storageWriteFails = true;
    const previous = { id: 'host-1', url: 'relay://srv_123', apiUrl: 'http://192.0.2.1:3000/', relay: RELAY };
    storedHosts = [previous];

    scheduleDesktopHostCandidateRefresh('host-1');
    await runScheduledRefresh();

    expect(storedHosts).toEqual([previous]);
    expect(probeUrls).toEqual([]);
    expect(switches).toEqual([]);
  });
});
