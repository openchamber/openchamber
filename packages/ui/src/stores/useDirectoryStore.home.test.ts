import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * First visit to a server with a UI password: the store module evaluates
 * before login, when /api/fs/home and system info both answer 401, and the
 * browser has no stored home yet. The home is resolved again after login.
 */

const HOME = '/home/user';

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

let loggedIn = false;
let homeReads = 0;
const directoriesSet: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: (directory: string) => {
      directoriesSet.push(directory);
    },
    getDirectory: () => directoriesSet.at(-1) ?? '/',
    getFilesystemHome: async () => {
      homeReads += 1;
      // Before login /api/fs/home answers 401, which this read reports as null.
      return loggedIn ? HOME : null;
    },
    getSystemInfo: async () => {
      if (!loggedIn) throw new Error('UI authentication required');
      return { homeDirectory: HOME };
    },
  },
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: async () => null,
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async () => undefined,
}));

mock.module('@/lib/runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: () => () => undefined,
  getRuntimeApiBaseUrl: () => 'http://127.0.0.1:9',
  getRuntimeKey: () => 'test',
}));

mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: {
    getState: () => ({ clearCache: () => undefined, invalidateDirectory: () => undefined }),
  },
}));

describe('home directory on a first visit to a password-protected server', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('starts on "/" before login and moves to the real home once logged in', async () => {
    setTestWindow({
      localStorage: testLocalStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    // A browser has no process environment to fall back on; bun test does.
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd;
    delete process.env.HOME;
    process.cwd = () => '';
    const { ensureHomeDirectoryResolved, useDirectoryStore } = await import('@/stores/useDirectoryStore').finally(() => {
      process.env.HOME = savedHome;
      process.cwd = savedCwd;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: '/', currentDirectory: '/', isHomeReady: false });

    loggedIn = true;
    await ensureHomeDirectoryResolved();
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: HOME, currentDirectory: HOME, isHomeReady: true });
    expect(directoriesSet.at(-1)).toBe(HOME);

    // Once known, the home is not read again.
    const reads = homeReads;
    await ensureHomeDirectoryResolved();
    expect(homeReads).toBe(reads);
  });
});
