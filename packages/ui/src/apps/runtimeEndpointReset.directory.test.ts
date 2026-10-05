import { afterEach, describe, expect, test } from 'bun:test';

/**
 * The whole switch on real modules: the endpoint event, the app-wide reset,
 * the client rebind and the directory store, with only `fetch` stubbed. The
 * desktop starts on its local instance and switches to another host that the
 * window has not visited. The directory store must load with a `window`, so
 * every module is imported after one is installed.
 */

const LOCAL = 'http://127.0.0.1:4100';
const REMOTE = 'https://remote.example';
const LOCAL_HOME = '/Users/me';
const LOCAL_DIRECTORY = '/Users/me/project';
const REMOTE_HOME = '/home/remote';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;

const installWindow = (): void => {
  const events = new EventTarget();
  const storage = new Map<string, string>([['lastDirectory', LOCAL_DIRECTORY], ['homeDirectory', LOCAL_HOME]]);
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: () => null,
    length: 0,
  } satisfies Storage;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_HOME__: LOCAL_HOME,
      __OPENCHAMBER_LOCAL_ORIGIN__: LOCAL,
      __OPENCHAMBER_API_BASE_URL__: LOCAL,
      localStorage,
      // The packaged desktop page: not an http origin, so the API base comes
      // from the injected globals above.
      location: new URL('openchamber-ui://app/index.html'),
      matchMedia: () => ({ matches: false }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
};

type SeenRequest = { origin: string; path: string; directory: string | null };
const seen: SeenRequest[] = [];

// Each host names its own home; everything else is not there.
const stubFetch = (): void => {
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const header = request.headers.get('x-opencode-directory');
    seen.push({ origin: url.origin, path: url.pathname, directory: header ? decodeURIComponent(header) : url.searchParams.get('directory') });
    if (url.pathname === '/api/fs/home') {
      return Response.json({ home: url.origin === REMOTE ? REMOTE_HOME : LOCAL_HOME });
    }
    return new Response(null, { status: 404 });
  };
  // SAFETY: the modules under test only call fetch(input, init); Bun's extra
  // `preconnect` member is never read.
  globalThis.fetch = respond as typeof fetch;
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of [['window', originalWindow], ['localStorage', originalLocalStorage]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('working directory across a real host switch', () => {
  test('the new host is asked for its own home and gets no request for the previous host\'s directory', async () => {
    installWindow();
    stubFetch();
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    const { opencodeClient } = await import('@/lib/opencode/client');
    const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
    const { installRuntimeEndpointReset } = await import('./runtimeEndpointReset');
    await settle();
    expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: LOCAL_DIRECTORY, homeDirectory: LOCAL_HOME, isHomeReady: true });
    expect(opencodeClient.getDirectory()).toBe(LOCAL_DIRECTORY);

    const uninstall = installRuntimeEndpointReset();
    try {
      seen.length = 0;
      switchRuntimeEndpoint({ apiBaseUrl: REMOTE, runtimeKey: 'host:remote' });
      // Forgotten at once, before any answer.
      expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: '/', isHomeReady: false });
      expect(opencodeClient.getDirectory()).toBeUndefined();

      await settle();
      expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: REMOTE_HOME, homeDirectory: REMOTE_HOME, isHomeReady: true });
      expect(opencodeClient.getDirectory()).toBe(REMOTE_HOME);
      const homeLookups = seen.filter((request) => request.path === '/api/fs/home');
      expect(homeLookups.length).toBeGreaterThan(0);
      expect(homeLookups.every((request) => request.origin === REMOTE)).toBe(true);
      expect(seen.filter((request) => request.directory?.startsWith(LOCAL_HOME))).toEqual([]);

      switchRuntimeEndpoint({ apiBaseUrl: LOCAL, runtimeKey: 'local' });
      await settle();
      expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: LOCAL_DIRECTORY, homeDirectory: LOCAL_HOME, isHomeReady: true });

      switchRuntimeEndpoint({ apiBaseUrl: REMOTE, runtimeKey: 'host:remote' });
      await settle();
      expect(useDirectoryStore.getState().currentDirectory).toBe(REMOTE_HOME);
    } finally {
      uninstall();
    }
  });
});
