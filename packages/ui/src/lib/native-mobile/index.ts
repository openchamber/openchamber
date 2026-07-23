type NativeMobileCapabilities = {
  http: boolean;
  secureStorage: boolean;
  lifecycle: boolean;
  keyboardChoreography: boolean;
  deepLinks: boolean;
  scanQr: boolean;
  push: boolean;
  updater: boolean;
};

export type NativeMobileSecureStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

type NativeMobileLifecycle = {
  onAppStateChange(listener: (active: boolean) => void): () => void;
};

export type NativeMobileStorageFailureReason =
  | 'invalid-key'
  | 'invalid-input'
  | 'permission-denied'
  | 'device-locked'
  | 'access-denied'
  | 'invalid-secret'
  | 'storage-unavailable'
  | 'invalid-response';

export class NativeMobileStorageError extends Error {
  readonly reason: NativeMobileStorageFailureReason;

  constructor(reason: NativeMobileStorageFailureReason) {
    super('Harmony secure storage operation failed');
    this.name = 'NativeMobileStorageError';
    this.reason = reason;
  }
}

type NativeMobileAdapter = {
  platform: 'harmony';
  capabilities: NativeMobileCapabilities;
  secureStorage?: NativeMobileSecureStorage;
  lifecycle?: NativeMobileLifecycle;
};

type HarmonyBridge = {
  getPlatform?: () => unknown;
  getCapabilities?: () => unknown;
  secureStorageGet?: (requestId: string, key: string) => unknown;
  secureStorageSet?: (requestId: string, key: string, value: string) => unknown;
  secureStorageRemove?: (requestId: string, key: string) => unknown;
};

type BridgeResult = {
  ok?: unknown;
  value?: unknown;
  error?: unknown;
};

const STORAGE_FAILURE_REASONS = new Set<NativeMobileStorageFailureReason>([
  'invalid-key',
  'invalid-input',
  'permission-denied',
  'device-locked',
  'access-denied',
  'invalid-secret',
  'storage-unavailable',
]);

const HARMONY_RESULT_CALLBACK = '__openChamberHarmonyBridgeResult';
const HARMONY_LIFECYCLE_CALLBACK = '__openChamberHarmonyLifecycle';
const HARMONY_BRIDGE_TIMEOUT_MS = 2_500;
let harmonyRequestSequence = 0;

type PendingHarmonyRequest = {
  resolve: (value: unknown) => void;
  reject: (error: NativeMobileStorageError) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const pendingHarmonyRequests = new Map<string, PendingHarmonyRequest>();

type HarmonyWindow = Window & {
  openChamberHarmony?: unknown;
  __openChamberHarmonyBridgeResult?: (requestId: unknown, value: unknown) => void;
  __openChamberHarmonyLifecycle?: (active: unknown) => void;
};

const harmonyLifecycleListeners = new Set<(active: boolean) => void>();

const receiveHarmonyLifecycle = (active: unknown): void => {
  if (typeof active !== 'boolean') return;
  for (const listener of harmonyLifecycleListeners) {
    try {
      listener(active);
    } catch {
      // One UI subscriber must not prevent other lifecycle consumers running.
    }
  }
};

const installHarmonyLifecycleReceiver = (): void => {
  const harmonyWindow = window as HarmonyWindow;
  if (harmonyWindow[HARMONY_LIFECYCLE_CALLBACK] === receiveHarmonyLifecycle) return;
  Object.defineProperty(harmonyWindow, HARMONY_LIFECYCLE_CALLBACK, {
    configurable: true,
    value: receiveHarmonyLifecycle,
  });
};

const receiveHarmonyResult = (requestId: unknown, value: unknown): void => {
  if (typeof requestId !== 'string') return;
  const pending = pendingHarmonyRequests.get(requestId);
  if (!pending) return;
  pendingHarmonyRequests.delete(requestId);
  clearTimeout(pending.timeoutId);
  pending.resolve(value);
};

const installHarmonyResultReceiver = (): void => {
  const harmonyWindow = window as HarmonyWindow;
  if (harmonyWindow[HARMONY_RESULT_CALLBACK] === receiveHarmonyResult) return;
  Object.defineProperty(harmonyWindow, HARMONY_RESULT_CALLBACK, {
    configurable: true,
    value: receiveHarmonyResult,
  });
};

const nextHarmonyRequestId = (): string => {
  harmonyRequestSequence = (harmonyRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `oc-${Date.now().toString(36)}-${harmonyRequestSequence.toString(36)}`;
};

const invokeHarmonyMethod = (
  bridge: HarmonyBridge,
  method: (...args: string[]) => unknown,
  args: string[],
): Promise<unknown> => {
  installHarmonyResultReceiver();
  const requestId = nextHarmonyRequestId();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingHarmonyRequests.delete(requestId);
      reject(new NativeMobileStorageError('storage-unavailable'));
    }, HARMONY_BRIDGE_TIMEOUT_MS);
    pendingHarmonyRequests.set(requestId, { resolve, reject, timeoutId });
    try {
      // ArkWeb async JavaScriptProxy methods are fire-and-forget. ArkTS sends
      // the result back through the request-scoped receiver above.
      method.call(bridge, requestId, ...args);
    } catch {
      clearTimeout(timeoutId);
      pendingHarmonyRequests.delete(requestId);
      reject(new NativeMobileStorageError('storage-unavailable'));
    }
  });
};

const EMPTY_CAPABILITIES: NativeMobileCapabilities = {
  http: false,
  secureStorage: false,
  lifecycle: false,
  keyboardChoreography: false,
  deepLinks: false,
  scanQr: false,
  push: false,
  updater: false,
};

const readBridge = (): HarmonyBridge | null => {
  if (typeof window === 'undefined') return null;
  const bridge = (window as HarmonyWindow).openChamberHarmony;
  return bridge && typeof bridge === 'object' ? bridge as HarmonyBridge : null;
};

const parseCapabilities = (value: unknown): NativeMobileCapabilities => {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return EMPTY_CAPABILITIES;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_CAPABILITIES;
  const record = parsed as Record<string, unknown>;
  return {
    http: record.nativeHttp === true,
    secureStorage: record.secureStorage === true,
    lifecycle: record.lifecycle === true,
    keyboardChoreography: record.keyboardChoreography === true,
    deepLinks: record.deepLinks === true,
    scanQr: record.scanQr === true,
    push: record.push === true,
    updater: record.updater === true,
  };
};

const parseBridgeResult = (value: unknown): BridgeResult => {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new NativeMobileStorageError('invalid-response');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeMobileStorageError('invalid-response');
  }
  const result = parsed as BridgeResult;
  if (result.ok !== true) {
    const reason = typeof result.error === 'string' && STORAGE_FAILURE_REASONS.has(result.error as NativeMobileStorageFailureReason)
      ? result.error as NativeMobileStorageFailureReason
      : 'storage-unavailable';
    throw new NativeMobileStorageError(reason);
  }
  return result;
};

const createSecureStorage = (bridge: HarmonyBridge): NativeMobileSecureStorage | undefined => {
  const get = bridge.secureStorageGet;
  const set = bridge.secureStorageSet;
  const remove = bridge.secureStorageRemove;
  if (typeof get !== 'function' || typeof set !== 'function' || typeof remove !== 'function') return undefined;

  return {
    async get(key) {
      const result = parseBridgeResult(await invokeHarmonyMethod(bridge, get, [key]));
      if (result.value === null) return null;
      if (typeof result.value !== 'string') throw new NativeMobileStorageError('invalid-response');
      return result.value;
    },
    async set(key, value) {
      parseBridgeResult(await invokeHarmonyMethod(bridge, set, [key, value]));
    },
    async remove(key) {
      parseBridgeResult(await invokeHarmonyMethod(bridge, remove, [key]));
    },
  };
};

const createLifecycle = (): NativeMobileLifecycle => ({
  onAppStateChange(listener) {
    installHarmonyLifecycleReceiver();
    harmonyLifecycleListeners.add(listener);
    return () => harmonyLifecycleListeners.delete(listener);
  },
});

/** Returns the narrow native adapter only for a valid Harmony bridge. */
export const getNativeMobileAdapter = (): NativeMobileAdapter | null => {
  const bridge = readBridge();
  if (!bridge || typeof bridge.getPlatform !== 'function' || typeof bridge.getCapabilities !== 'function') return null;

  try {
    if (bridge.getPlatform.call(bridge) !== 'harmony') return null;
    const capabilities = parseCapabilities(bridge.getCapabilities.call(bridge));
    const secureStorage = capabilities.secureStorage ? createSecureStorage(bridge) : undefined;
    const lifecycle = capabilities.lifecycle ? createLifecycle() : undefined;
    return {
      platform: 'harmony',
      capabilities: {
        ...capabilities,
        secureStorage: Boolean(secureStorage),
        lifecycle: Boolean(lifecycle),
      },
      ...(secureStorage ? { secureStorage } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
  } catch {
    return null;
  }
};
