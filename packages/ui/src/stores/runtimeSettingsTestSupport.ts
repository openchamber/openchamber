import { mock } from 'bun:test';

export type RuntimeEndpointDetail = {
  runtimeKey: string;
  previousRuntimeKey: string;
};

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

export const storageValues = new Map<string, string>();
export const updateDesktopSettings = mock(async () => undefined);
export const setDirectory = mock(() => undefined);

let runtimeKey = 'local';
let runtimeApiBaseUrl = 'http://local.example';
let desktopHome = '/Users/local-user';
let filesystemHomeResolver: () => Promise<string | null> = async () => desktopHome;
let runtimeFetchResolver: () => Promise<Response> = async () => new Response('{}', {
  headers: { 'Content-Type': 'application/json' },
});

const runtimeEndpointChangedListeners = new Set<(detail: RuntimeEndpointDetail) => void>();
const events = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

export const runtimeWindow = {
  __OPENCHAMBER_HOME__: desktopHome,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};

export const installRuntimeSettingsTestWindow = (): void => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: runtimeWindow,
  });
};

export const restoreRuntimeSettingsTestWindow = (): void => {
  if (previousWindow) {
    Object.defineProperty(globalThis, 'window', previousWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
};

const safeStorage = {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => storageValues.set(key, value),
  removeItem: (key: string) => storageValues.delete(key),
  clear: () => storageValues.clear(),
  key: (index: number) => Array.from(storageValues.keys())[index] ?? null,
  get length() {
    return storageValues.size;
  },
} as Storage;

mock.module('./utils/safeStorage', () => ({
  getDeferredSafeStorage: () => safeStorage,
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getFilesystemHome: mock(() => filesystemHomeResolver()),
    getSystemInfo: mock(async () => ({ homeDirectory: '/' })),
    setDirectory,
  },
}));

mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: mock(async () => desktopHome),
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: (detail: RuntimeEndpointDetail) => void) => {
    runtimeEndpointChangedListeners.add(listener);
    return () => runtimeEndpointChangedListeners.delete(listener);
  },
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings,
}));

mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: {
    getState: () => ({ invalidateDirectory: () => undefined }),
  },
}));

mock.module('@/stores/utils/streamDebug', () => ({
  streamDebugEnabled: () => false,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => null,
}));

mock.module('@/lib/projectMeta', () => ({
  PROJECT_COLORS: [{ key: 'blue' }],
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    setState: () => undefined,
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(() => runtimeFetchResolver()),
}));

export const setRuntimeKey = (value: string): void => {
  runtimeKey = value;
};

export const setRuntimeApiBaseUrl = (value: string): void => {
  runtimeApiBaseUrl = value;
};

export const setDesktopHome = (value: string): void => {
  desktopHome = value;
  runtimeWindow.__OPENCHAMBER_HOME__ = value;
};

export const setFilesystemHomeResolver = (resolver: () => Promise<string | null>): void => {
  filesystemHomeResolver = resolver;
};

export const setRuntimeFetchResolver = (resolver: () => Promise<Response>): void => {
  runtimeFetchResolver = resolver;
};

export const emitRuntimeEndpointChanged = (detail: RuntimeEndpointDetail): void => {
  runtimeEndpointChangedListeners.forEach((listener) => listener(detail));
};

export const resetRuntimeSettingsTestState = (): void => {
  storageValues.clear();
  runtimeKey = 'local';
  runtimeApiBaseUrl = 'http://local.example';
  desktopHome = '/Users/local-user';
  runtimeWindow.__OPENCHAMBER_HOME__ = desktopHome;
  filesystemHomeResolver = async () => desktopHome;
  runtimeFetchResolver = async () => new Response('{}', {
    headers: { 'Content-Type': 'application/json' },
  });
  updateDesktopSettings.mockClear();
  setDirectory.mockClear();
};
