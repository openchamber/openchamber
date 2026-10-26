import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * A Windows desktop whose default host is a Mac boots on its own server and
 * switches to the Mac while the boot-time home lookup is still out. That
 * lookup answers with the Windows home after the Mac has named its own. It
 * must not be stored: not in this window, and not in the Mac's settings.
 */

const LOCAL_HOME = 'C:/Users/me';
const REMOTE_HOME = '/Users/me';
const REMOTE_CHATS = '/Users/me/.config/openchamber/chats';

const storage = new Map<string, string>();
const testLocalStorage = {
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

interface TestWindow {
  __OPENCHAMBER_HOME__: string;
  localStorage: Storage;
  matchMedia: () => { matches: boolean };
  addEventListener: () => void;
  removeEventListener: () => void;
}

const setTestWindow = (value: TestWindow | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'localStorage');
    return;
  }
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: value.localStorage, configurable: true, writable: true });
};

type EndpointChange = { runtimeKey: string; previousRuntimeKey: string };

let runtimeKey = 'local';
// The host a lookup reaches is fixed when the lookup starts.
let lookupsReach = 'local';
let homeLookups = 0;
let answerBootLookup: () => void = () => undefined;
const bootLookup = new Promise<void>((resolve) => {
  answerBootLookup = resolve;
});
let onRuntimeEndpointChanged: (detail: EndpointChange) => void = () => undefined;
const settingsWrites: Array<{ runtimeKey: string; changes: Record<string, string> }> = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: () => undefined,
    getDirectory: () => undefined,
    getFilesystemHome: async () => {
      const host = lookupsReach;
      homeLookups += 1;
      if (homeLookups === 1) await bootLookup;
      return host === 'local' ? LOCAL_HOME : REMOTE_HOME;
    },
    getSystemInfo: async () => ({ homeDirectory: LOCAL_HOME }),
    getFilesystemHomeInfo: async () => (lookupsReach === 'local'
      ? { home: LOCAL_HOME, chatsRoot: `${LOCAL_HOME}/.config/openchamber/chats` }
      : { home: REMOTE_HOME, chatsRoot: REMOTE_CHATS }),
  },
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: async () => LOCAL_HOME,
  isVSCodeRuntime: () => false,
  isDesktopShell: () => false,
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async (changes: Record<string, string>) => {
    settingsWrites.push({ runtimeKey, changes });
  },
}));

mock.module('@/lib/runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: (listener: (detail: EndpointChange) => void) => {
    onRuntimeEndpointChanged = listener;
    return () => undefined;
  },
  getRuntimeApiBaseUrl: () => 'http://127.0.0.1:9',
  getRuntimeKey: () => runtimeKey,
}));

mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: {
    getState: () => ({ clearCache: () => undefined, invalidateDirectory: () => undefined }),
  },
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('home lookup that answers after a runtime switch', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('stores nothing from the host the window left', async () => {
    setTestWindow({
      __OPENCHAMBER_HOME__: LOCAL_HOME,
      localStorage: testLocalStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

    // The default-host restore switches while the boot lookup is out.
    runtimeKey = 'host:mac';
    lookupsReach = 'host:mac';
    onRuntimeEndpointChanged({ runtimeKey: 'host:mac', previousRuntimeKey: 'local' });
    await settle();
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: REMOTE_HOME, currentDirectory: REMOTE_CHATS, isHomeReady: true });

    answerBootLookup();
    await settle();

    expect(useDirectoryStore.getState().homeDirectory).toBe(REMOTE_HOME);
    expect(storage.get('homeDirectory')).toBe(REMOTE_HOME);
    expect(settingsWrites.filter((write) => write.runtimeKey === 'host:mac' && write.changes.homeDirectory === LOCAL_HOME)).toEqual([]);
    // `~` is the Mac's home.
    useDirectoryStore.getState().setDirectory('~/notes');
    expect(useDirectoryStore.getState().currentDirectory).toBe(`${REMOTE_HOME}/notes`);
  });
});
