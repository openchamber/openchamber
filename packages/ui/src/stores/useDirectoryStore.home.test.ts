import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * First visit to a server with a UI password: the store module evaluates
 * before login, when /api/fs/home and system info both answer 401, and the
 * browser has no stored home yet. The home is resolved again after login.
 */

const HOME = '/home/user';
// Outside the home, as with OPENCHAMBER_DATA_DIR.
const CHATS_ROOT = '/srv/openchamber/chats';

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
    getFilesystemHomeInfo: async () => {
      if (!loggedIn) throw new Error('Failed to resolve the chats root (401)');
      return { home: HOME, chatsRoot: CHATS_ROOT };
    },
  },
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: async () => null,
  isVSCodeRuntime: () => false,
  isDesktopShell: () => false,
}));

const settingsUpdates: Array<Record<string, string>> = [];

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async (changes: Record<string, string>) => {
    settingsUpdates.push(changes);
  },
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

// Local storage writes land on the next tick.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('home directory on a first visit to a password-protected server', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('starts on "/" before login and moves to the chats root once logged in', async () => {
    setTestWindow({
      localStorage: testLocalStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    // A browser has no process environment to fall back on; bun test does.
    // Scrub every variable the store reads for the process home: HOME on
    // POSIX, and USERPROFILE / HOMEDRIVE+HOMEPATH on Windows. Leaving the
    // Windows pair behind makes the store bootstrap on the real Windows home.
    const savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      HOMEDRIVE: process.env.HOMEDRIVE,
      HOMEPATH: process.env.HOMEPATH,
    };
    const savedCwd = process.cwd;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;
    process.cwd = () => '';
    const { ensureHomeDirectoryResolved, useDirectoryStore } = await import('@/stores/useDirectoryStore').finally(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.cwd = savedCwd;
    });
    await settle();
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: '/', currentDirectory: '/', isHomeReady: false });

    loggedIn = true;
    await ensureHomeDirectoryResolved();
    // With no project open the app works in the chats root. Every OpenCode
    // read names the app's directory, and the home started OpenCode over the
    // whole home folder.
    expect(useDirectoryStore.getState()).toMatchObject({ homeDirectory: HOME, currentDirectory: CHATS_ROOT, isHomeReady: true });
    expect(directoriesSet).toEqual([CHATS_ROOT]);
    await settle();
    // The fallback is not opening a directory. A stored last directory
    // becomes a project on the server when there is none, which put the home
    // in the sidebar and started OpenCode there on every launch.
    expect(storage.has('lastDirectory')).toBe(false);
    expect(settingsUpdates.some((changes) => 'lastDirectory' in changes)).toBe(false);
    expect(useDirectoryStore.getState().hasPersistedDirectory).toBe(false);

    // Once known, the home is not read again.
    const reads = homeReads;
    await ensureHomeDirectoryResolved();
    expect(homeReads).toBe(reads);
  });

  test('removing the last project moves to the chats root and forgets the last directory', async () => {
    setTestWindow({
      localStorage: testLocalStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    useDirectoryStore.getState().setDirectory('/home/user/project');
    await settle();
    expect(storage.get('lastDirectory')).toBe('/home/user/project');

    settingsUpdates.length = 0;
    await useDirectoryStore.getState().goToNoProjectDirectory();
    expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: CHATS_ROOT, hasPersistedDirectory: false });
    expect(directoriesSet.at(-1)).toBe(CHATS_ROOT);
    await settle();
    // Neither the removed project nor the chats root stays stored: the server
    // would turn either into a project.
    expect(storage.has('lastDirectory')).toBe(false);
    expect(settingsUpdates).toEqual([{ lastDirectory: '' }]);
  });

  test('a known home without a chats root before login is resolved again after login', async () => {
    const { ensureHomeDirectoryResolved, useDirectoryStore } = await import('@/stores/useDirectoryStore');
    // A returning visitor whose login expired: the home is stored, no project
    // is open, and the server names nothing until login.
    loggedIn = false;
    useDirectoryStore.getState().synchronizeHomeDirectory(HOME, null);
    expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: HOME, isHomeReady: false });

    loggedIn = true;
    await ensureHomeDirectoryResolved();
    expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: CHATS_ROOT, isHomeReady: true });
  });
});
