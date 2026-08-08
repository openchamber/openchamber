import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * Integration-style coverage for #2359: store modules evaluate before
 * RuntimeAPIs registration, with only extension-host __VSCODE_CONFIG__ present
 * and a stale lastDirectory in storage.
 */

const WORKSPACE = '/tmp/oc-ws-project-a';
const STALE = '/tmp/oc-ws-other';

const storage = new Map<string, string>([
  ['lastDirectory', STALE],
  ['homeDirectory', STALE],
]);

const installWindow = () => {
  (globalThis as { window: unknown }).window = {
    __VSCODE_CONFIG__: {
      workspaceFolder: WORKSPACE,
      workspaceFolders: [{ name: 'oc-ws-project-a', path: WORKSPACE }],
    },
    __OPENCHAMBER_HOME__: WORKSPACE,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  };
  (globalThis as { localStorage: unknown }).localStorage = (globalThis as { window: { localStorage: unknown } }).window.localStorage;
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
    getState: () => ({ clearCache: () => undefined }),
  },
}));

describe('VS Code store init before RuntimeAPIs (#2359)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('desktop isVSCodeRuntime prefers bootstrap config', async () => {
    installWindow();
    const { isVSCodeRuntime } = await import('@/lib/desktop');
    expect(isVSCodeRuntime()).toBe(true);
  });

  test('projects helper derives workspace projects without RuntimeAPIs', async () => {
    installWindow();
    const { getVSCodeBootstrapConfig, isVSCodeRuntime } = await import('@/stores/utils/vscodeRuntime');
    const config = getVSCodeBootstrapConfig();
    expect(isVSCodeRuntime(null, config)).toBe(true);
    expect(config?.workspaceFolder).toBe(WORKSPACE);
  });
});
