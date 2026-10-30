import { afterAll, expect, mock, test } from 'bun:test';

const home = '/home/user';
const chatsRoot = `${home}/.config/openchamber/chats`;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const directories: string[] = [];
let rootAvailable = false;
let allowMkdir = false;
let rootExists = false;
const allocations: string[] = [];

Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  __VSCODE_CONFIG__: { workspaceFolder: '', workspaceFolders: [] },
  __OPENCHAMBER_HOME__: home,
  addEventListener() {}, removeEventListener() {},
} });
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => true, isDesktopShell: () => false, getDesktopHomeDirectory: async () => home }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  setDirectory: (directory: string) => {
    expect(rootExists).toBe(true);
    directories.push(directory);
  },
  createDirectory: async (directory: string) => {
    allocations.push(directory);
    if (!allowMkdir) throw new Error('Read-only filesystem');
    rootExists = true;
    return { success: true };
  },
  getFilesystemHome: async () => home,
  getFilesystemHomeInfo: async () => {
    if (!rootAvailable) throw new Error('Host unavailable');
    return { home, chatsRoot };
  },
} }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeApiBaseUrl: () => '', getRuntimeKey: () => 'vscode-chats-startup', subscribeRuntimeEndpointChanged: () => () => {} }));
mock.module('@/lib/persistence', () => ({ updateDesktopSettings: async () => {} }));
mock.module('@/stores/useFileSearchStore', () => ({ useFileSearchStore: { getState: () => ({ invalidateDirectory() {} }) } }));

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('an empty VS Code window waits for the host root and never bootstraps the home', async () => {
  const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('./useDirectoryStore');
  await ensureHomeDirectoryResolved();
  expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: '', isHomeReady: false });
  expect(directories).toEqual([]);
  rootAvailable = true;
  await ensureHomeDirectoryResolved();
  expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: '', isHomeReady: false });
  expect(directories).toEqual([]);
  expect(allocations).toEqual([chatsRoot]);
  allowMkdir = true;
  await ensureHomeDirectoryResolved();
  expect(useDirectoryStore.getState()).toMatchObject({ currentDirectory: chatsRoot, isHomeReady: true });
  expect(directories).toEqual([chatsRoot]);
  expect(allocations).toEqual([chatsRoot, chatsRoot]);
});
