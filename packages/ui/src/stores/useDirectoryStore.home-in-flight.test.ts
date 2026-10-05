import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * First visit to a server without a UI password: the page-load read of the
 * home directory is slow but succeeds. The session gate asks for the home while
 * that read is still in flight; it must wait for it, not race it with a second.
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

let homeReads = 0;
let answerPageLoadRead: () => void = () => undefined;
const directoriesSet: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: (directory: string) => {
      directoriesSet.push(directory);
    },
    getDirectory: () => directoriesSet.at(-1) ?? '/',
    getFilesystemHome: async () => {
      homeReads += 1;
      if (homeReads > 1) throw new Error('a second read must not happen');
      await new Promise<void>((resolve) => {
        answerPageLoadRead = resolve;
      });
      return HOME;
    },
    getSystemInfo: async () => {
      throw new Error('a second source must not be asked');
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

describe('home directory read still in flight when the gate asks for it', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('waits for the page-load read instead of starting a second one', async () => {
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
    expect(useDirectoryStore.getState().isHomeReady).toBe(false);

    const ensured = ensureHomeDirectoryResolved();
    answerPageLoadRead();
    await ensured;

    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: HOME, currentDirectory: HOME, isHomeReady: true });
    expect(homeReads).toBe(1);
  });
});
