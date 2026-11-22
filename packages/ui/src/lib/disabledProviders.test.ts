import { describe, expect, jest, mock, test } from 'bun:test';

let getImpl: (() => Promise<Response>) | null = null;
let putImpl: (() => Promise<Response>) | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') {
      if (putImpl) return putImpl();
      throw new Error('unexpected PUT in disabledProviders test');
    }
    if (getImpl) return getImpl();
    throw new Error('unexpected GET in disabledProviders test');
  }),
}));

const {
  loadDisabledProviders,
  loadProviderOffState,
  peekDisabledProviders,
  peekProviderOffState,
  rememberDisabledProviders,
  setProviderDisabled,
  subscribeProviderOffState,
} = await import('./disabledProviders');

const providersResponse = (providers: string[]) => new Response(JSON.stringify({ providers }), {
  headers: { 'Content-Type': 'application/json' },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

describe('disabledProviders read/write ordering (#659)', () => {
  test('a read started before a turn-off toggle cannot overwrite or answer with the pre-toggle list', async () => {
    rememberDisabledProviders([]);
    const pendingRead = deferred<Response>();
    getImpl = () => pendingRead.promise;
    putImpl = async () => providersResponse(['groq']);

    const load = loadDisabledProviders();
    expect(await setProviderDisabled('groq', true)).toEqual(['groq']);
    // The in-flight read now resolves with the list from before the toggle.
    pendingRead.resolve(providersResponse([]));

    expect(await load).toEqual(['groq']);
    expect(peekDisabledProviders()).toEqual(['groq']);
  });

  test('a read started before a turn-back-on toggle cannot overwrite or answer with the pre-toggle list', async () => {
    rememberDisabledProviders(['groq']);
    const pendingRead = deferred<Response>();
    getImpl = () => pendingRead.promise;
    putImpl = async () => providersResponse([]);

    const load = loadDisabledProviders();
    expect(await setProviderDisabled('groq', false)).toEqual([]);
    // The in-flight read now resolves with the list from before the toggle.
    pendingRead.resolve(providersResponse(['groq']));

    expect(await load).toEqual([]);
    expect(peekDisabledProviders()).toEqual([]);
  });

  test('an unsuperseded read still commits and answers with its own list', async () => {
    getImpl = async () => providersResponse(['copilot']);
    putImpl = null;

    expect(await loadDisabledProviders()).toEqual(['copilot']);
    expect(peekDisabledProviders()).toEqual(['copilot']);
  });

  test('a failed read still throws and keeps the previous snapshot', async () => {
    rememberDisabledProviders(['copilot']);
    getImpl = async () => new Response('nope', { status: 500 });
    putImpl = null;

    await expect(loadDisabledProviders()).rejects.toThrow('Could not read disabled providers (500)');
    expect(peekDisabledProviders()).toEqual(['copilot']);
  });
});

interface OffStatePayload {
  catalogReady?: boolean;
  providers: string[];
  offProviders: string[];
  offReasons: { [providerId: string]: 'disabled' | 'policy' | 'allowlist' };
}

const offStateResponse = (payload: OffStatePayload) => new Response(JSON.stringify(payload), {
  headers: { 'Content-Type': 'application/json' },
});

describe('provider off state (#218)', () => {
  test('a full payload carries policy and allowlist reasons through the read', async () => {
    getImpl = async () => offStateResponse({
      providers: ['alpha'],
      offProviders: ['alpha', 'beta', 'gamma'],
      offReasons: { alpha: 'disabled', beta: 'policy', gamma: 'allowlist' },
    });
    putImpl = null;

    expect(await loadProviderOffState()).toEqual({
      offProviders: ['alpha', 'beta', 'gamma'],
      offReasons: { alpha: 'disabled', beta: 'policy', gamma: 'allowlist' },
    });
    expect(peekProviderOffState()).toEqual({
      offProviders: ['alpha', 'beta', 'gamma'],
      offReasons: { alpha: 'disabled', beta: 'policy', gamma: 'allowlist' },
    });
    expect(peekDisabledProviders()).toEqual(['alpha']);
  });

  test('a legacy payload without off fields reports every off provider as toggleable', async () => {
    getImpl = async () => providersResponse(['legacy']);
    putImpl = null;

    expect(await loadProviderOffState()).toEqual({
      offProviders: ['legacy'],
      offReasons: { legacy: 'disabled' },
    });
  });

  test('a catalog-cold read schedules a refresh and subscribers see the enriched state land', async () => {
    jest.useFakeTimers();
    try {
      getImpl = async () => offStateResponse({
        catalogReady: false,
        providers: [],
        offProviders: [],
        offReasons: {},
      });
      putImpl = null;
      await loadProviderOffState();
      expect(peekProviderOffState()).toEqual({ offProviders: [], offReasons: {} });

      let notifications = 0;
      const unsubscribe = subscribeProviderOffState(() => { notifications += 1; });
      getImpl = async () => offStateResponse({
        catalogReady: true,
        providers: [],
        offProviders: ['gamma'],
        offReasons: { gamma: 'allowlist' },
      });
      // Fire the scheduled re-read (past the catalog fetch timeout) and let
      // its promise chain settle.
      jest.advanceTimersByTime(10_000);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      unsubscribe();

      expect(peekProviderOffState()).toEqual({ offProviders: ['gamma'], offReasons: { gamma: 'allowlist' } });
      expect(notifications).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a toggle write keeps binding reasons the toggle cannot change', async () => {
    getImpl = async () => offStateResponse({
      providers: ['alpha'],
      offProviders: ['alpha', 'beta', 'gamma'],
      offReasons: { alpha: 'disabled', beta: 'policy', gamma: 'allowlist' },
    });
    putImpl = async () => providersResponse([]);
    await loadProviderOffState();

    expect(await setProviderDisabled('alpha', false)).toEqual([]);
    const offState = peekProviderOffState();
    expect(offState?.offReasons).toEqual({ beta: 'policy', gamma: 'allowlist' });
    expect([...(offState?.offProviders ?? [])].sort()).toEqual(['beta', 'gamma']);
  });
});
