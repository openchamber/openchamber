import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * Desktop switches from this Mac to another host with a UI password. Until the
 * user logs in there, the host answers the home lookup with 401. Neither this
 * Mac's home nor the directory it was working in may stand in for the host's.
 */

const MAC_HOME = '/Users/me';
const MAC_PROJECT = '/Users/me/project';
const REMOTE_HOME = '/home/remote';
const REMOTE_CHATS = '/srv/remote/chats';

const storage = new Map<string, string>([['lastDirectory', MAC_PROJECT]]);
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
// Which host the client's requests reach. The app rebinds it in a later
// subscriber of the same endpoint-changed event.
let clientBoundTo = 'local';
let loggedInOnRemote = false;
// A lookup waits on this, so a test can keep one in flight across a switch.
let holdLookup: Promise<void> = Promise.resolve();
let clientDirectory: string | undefined = MAC_PROJECT;
let onRuntimeEndpointChanged: (detail: EndpointChange) => void = () => undefined;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: (directory: string | undefined) => {
      clientDirectory = directory;
    },
    getDirectory: () => clientDirectory,
    // Before login the other host answers /api/fs/home with 401, reported as null.
    getFilesystemHome: async () => {
      const boundTo = clientBoundTo;
      await holdLookup;
      if (boundTo === 'local') return MAC_HOME;
      return loggedInOnRemote ? REMOTE_HOME : null;
    },
    // The real one derives a home from the stored last directory when the
    // host answers nothing, which after a switch is still this Mac's.
    getSystemInfo: async () => ({ homeDirectory: runtimeKey === 'local' || !loggedInOnRemote ? MAC_HOME : REMOTE_HOME }),
    getFilesystemHomeInfo: async () => {
      const boundTo = clientBoundTo;
      await holdLookup;
      if (boundTo === 'local') return { home: MAC_HOME, chatsRoot: `${MAC_HOME}/.config/openchamber/chats` };
      if (!loggedInOnRemote) throw new Error('Failed to resolve the chats root (401)');
      return { home: REMOTE_HOME, chatsRoot: REMOTE_CHATS };
    },
  },
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: async () => MAC_HOME,
  isVSCodeRuntime: () => false,
  isDesktopShell: () => false,
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async () => undefined,
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

describe('directory store after the desktop switches to another host', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('home and directory stay unknown until that host names its home, then both are its own', async () => {
    setTestWindow({
      __OPENCHAMBER_HOME__: MAC_HOME,
      localStorage: testLocalStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const { ensureHomeDirectoryResolved, useDirectoryStore } = await import('@/stores/useDirectoryStore');
    await settle();
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: MAC_HOME, currentDirectory: MAC_PROJECT, isHomeReady: true });

    // A lookup against the Mac is still in flight when the switch happens. Its
    // answer arrives afterwards and must not become the new host's home.
    let releaseLookup: () => void = () => undefined;
    holdLookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    onRuntimeEndpointChanged({ runtimeKey: 'local', previousRuntimeKey: 'local' });
    await settle();
    holdLookup = Promise.resolve();
    // Its answer is already on its way when the switch is dispatched.
    releaseLookup();
    await Promise.resolve();
    await Promise.resolve();

    // The switch: the endpoint changes, and the app-wide reset forgets the
    // directory because the new host remembers none.
    runtimeKey = 'host:remote';
    onRuntimeEndpointChanged({ runtimeKey: 'host:remote', previousRuntimeKey: 'local' });
    clientBoundTo = 'host:remote';
    useDirectoryStore.getState().resetForRuntimeSwitch();
    await settle();
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: '/', currentDirectory: '/', isHomeReady: false });
    expect(clientDirectory).toBeUndefined();
    // The Mac's last directory is still stored for the next start on the Mac.
    expect(storage.get('lastDirectory')).toBe(MAC_PROJECT);

    loggedInOnRemote = true;
    await ensureHomeDirectoryResolved();
    // No project is open on that host: the app works in its chats root.
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: REMOTE_HOME, currentDirectory: REMOTE_CHATS, isHomeReady: true });
    expect(clientDirectory).toBe(REMOTE_CHATS);
  });
});
