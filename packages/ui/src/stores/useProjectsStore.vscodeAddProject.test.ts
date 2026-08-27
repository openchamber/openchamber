// Regression test for issue #2582: "Add Project" in the VS Code extension
// always failed with the "Failed to add project" toast because
// useProjectsStore.addProject() returned null unconditionally in the VS Code
// runtime (projects are scoped to VS Code workspace folders). The fix makes
// addProject() add the chosen directory as a workspace folder through the
// extension host and sync the new folder back as a project.

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// VS Code runtime detection reads window.__VSCODE_CONFIG__ at module load time;
// bun test has no browser window, so install a test window before importing the
// store (mirrors packages/vscode/src/webviewHtml.ts which sets the config).
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __VSCODE_CONFIG__: {
      workspaceFolder: '/workspace/project-one',
      workspaceFolders: [{ name: 'project-one', path: '/workspace/project-one' }],
    },
    __OPENCHAMBER_LOCAL_ORIGIN__: '',
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

// Transitive imports read location.search / navigator / localStorage as bare
// globals at module load time.
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { href: 'https://example.test/', search: '', pathname: '/', hash: '' },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'linux', userAgent: 'bun-test', language: 'en-US', maxTouchPoints: 0 },
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: (() => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() { return store.size; },
    };
  })(),
});

const noop = () => {};
const opencodeClientStub = new Proxy(
  {
    setDirectory: noop,
    getDirectory: () => null,
    getFilesystemHome: async () => null,
    getSystemInfo: async () => null,
    listLocalDirectory: async () => [],
    cloneRepository: async () => ({}),
    createDirectory: async () => {},
  },
  {
    get(target, prop) {
      if (prop in target) {
        // SAFETY: `prop in target` was just checked, so the key exists on the
        // stub object and the cast narrows to its known key type.
        return target[prop as keyof typeof target];
      }
      return noop;
    },
  },
);
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: opencodeClientStub,
}));
mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async () => {},
}));

const addWorkspaceFolderCalls: string[] = [];
let addWorkspaceFolderError: Error | null = null;

// SAFETY: the store only needs the vscode capability plus the runtime flag;
// everything else on RuntimeAPIs is never reached by the addProject path.
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({
    runtime: { platform: 'vscode', isDesktop: false, isVSCode: true, label: 'VS Code Extension' },
    vscode: {
      async addWorkspaceFolder(path: string) {
        addWorkspaceFolderCalls.push(path);
        if (addWorkspaceFolderError) {
          throw addWorkspaceFolderError;
        }
        return [
          { name: 'project-one', path: '/workspace/project-one' },
          { name: 'my-project', path },
        ];
      },
    },
  }),
  registerRuntimeAPIs: () => {},
}));

const { useProjectsStore } = await import('@/stores/useProjectsStore');

beforeEach(() => {
  addWorkspaceFolderCalls.length = 0;
  addWorkspaceFolderError = null;
});

describe('issue #2582: addProject in the VS Code runtime', () => {
  test('adds the directory as a workspace folder and syncs it as a project', async () => {
    const added = await useProjectsStore.getState().addProject('/home/user/my-project');

    expect(addWorkspaceFolderCalls).toEqual(['/home/user/my-project']);
    expect(added).not.toBeNull();
    expect(added?.path).toBe('/home/user/my-project');
    expect(useProjectsStore.getState().projects.find((p) => p.path === '/home/user/my-project')).toBeTruthy();
  });

  test('returns the existing project for a folder already in the workspace without calling the host', async () => {
    const existing = await useProjectsStore.getState().addProject('/workspace/project-one');

    expect(addWorkspaceFolderCalls).toEqual([]);
    expect(existing?.path).toBe('/workspace/project-one');
  });

  test('returns null when the extension host cannot add the folder', async () => {
    addWorkspaceFolderError = new Error('cancelled');

    const added = await useProjectsStore.getState().addProject('/other/path');

    expect(added).toBeNull();
    expect(useProjectsStore.getState().projects.find((p) => p.path === '/other/path')).toBeFalsy();
  });
});
