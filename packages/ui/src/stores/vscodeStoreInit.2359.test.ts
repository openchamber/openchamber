import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * Integration-style coverage for #2359: store modules evaluate before
 * RuntimeAPIs registration, with only extension-host __VSCODE_CONFIG__ present
 * and a stale lastDirectory in storage. The directory store must settle on the
 * VS Code workspace folder rather than the stale persisted directory.
 */

const WORKSPACE = '/tmp/oc-ws-project-a';
const STALE = '/tmp/oc-ws-other';

const storage = new Map<string, string>([
  ['lastDirectory', STALE],
  ['homeDirectory', STALE],
]);

interface TestWindow {
  __VSCODE_CONFIG__?: { workspaceFolder: string; workspaceFolders: { name: string; path: string }[] };
  __OPENCHAMBER_HOME__?: string;
  localStorage: Storage;
  matchMedia: () => { matches: boolean };
  addEventListener: () => void;
  removeEventListener: () => void;
}

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

/**
 * bun test runs without a DOM, so `globalThis` has neither `window` nor
 * `localStorage` to assign through, and these store modules read both at module
 * evaluation time. Defining the properties directly installs a stub carrying
 * exactly the members they touch, without asserting it is a real `Window`.
 */
const setTestWindow = (value: TestWindow | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'localStorage');
    return;
  }
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', {
    value: value.localStorage,
    configurable: true,
    writable: true,
  });
};

const installWindow = () => {
  setTestWindow({
    __VSCODE_CONFIG__: {
      workspaceFolder: WORKSPACE,
      workspaceFolders: [{ name: 'oc-ws-project-a', path: WORKSPACE }],
    },
    __OPENCHAMBER_HOME__: WORKSPACE,
    localStorage: testLocalStorage,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
};

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => null,
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: () => undefined,
    getDirectory: () => WORKSPACE,
    getFilesystemHome: async () => WORKSPACE,
    getSystemInfo: async () => ({ homeDirectory: WORKSPACE }),
  },
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

describe('VS Code store init before RuntimeAPIs (#2359)', () => {
  afterEach(() => {
    setTestWindow(undefined);
  });

  test('directory store starts on the workspace folder, not the stale persisted directory', async () => {
    installWindow();
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
    const state = useDirectoryStore.getState();

    expect(state.currentDirectory).toBe(WORKSPACE);
    expect(state.homeDirectory).toBe(WORKSPACE);
    expect(state.directoryHistory).toEqual([WORKSPACE]);
    expect(state.currentDirectory).not.toBe(STALE);
  });
});
