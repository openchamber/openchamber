import { refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { isVSCodeBootstrapPresent } from '@/lib/vscodeBootstrap';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  type RelayRuntimeDescriptor,
} from '@/lib/relay/runtime-tunnel';

export type RuntimeEndpointChangedDetail = {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
};

const RUNTIME_ENDPOINT_CHANGED_EVENT = 'openchamber:runtime-endpoint-changed';
const RUNTIME_ENDPOINT_WILL_CHANGE_EVENT = 'openchamber:runtime-endpoint-will-change';

let activeApiBaseUrl = '';
let activeRuntimeKey = '';
let instanceGeneration = 0;
let activeSshForwarded: boolean | null = null;

const setWindowRuntimeValue = <K extends '__OPENCHAMBER_API_BASE_URL__' | '__OPENCHAMBER_CLIENT_TOKEN__' | '__OPENCHAMBER_RUNTIME_HEADERS__'>(
  runtimeWindow: typeof window & {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_CLIENT_TOKEN__?: string;
    __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
  },
  key: K,
  value: (typeof runtimeWindow)[K],
): void => {
  try {
    runtimeWindow[key] = value;
  } catch {
    // Electron preload exposes some initial globals through contextBridge, which
    // makes them read-only. Runtime switching must still update in-memory state.
  }
};

const normalizeRuntimeUrlKey = (value: string): string => {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return `url:${value.trim().replace(/\/+$/, '') || 'default'}`;
  }
};

export const MOBILE_DISCONNECTED_RUNTIME_KEY = 'mobile-disconnected';
const UNINITIALIZED_RUNTIME_KEY = 'url:default';

export const isTransientRuntimeKey = (runtimeKey: string): boolean =>
  runtimeKey === ''
  || runtimeKey === MOBILE_DISCONNECTED_RUNTIME_KEY
  || (runtimeKey === UNINITIALIZED_RUNTIME_KEY && !isVSCodeBootstrapPresent());

const readInjectedApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const readInjectedLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const sameOrigin = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

export const getRuntimeApiBaseUrl = (): string => activeApiBaseUrl || readInjectedApiBaseUrl();

export const isSshForwardedRuntime = (): boolean => {
  if (activeSshForwarded !== null) return activeSshForwarded;
  const apiBaseUrl = getRuntimeApiBaseUrl();
  return Boolean(apiBaseUrl && apiBaseUrl === globalThis.window?.__OPENCHAMBER_SSH_FORWARD_API_URL__);
};

let cachedRuntimeKey = '';
let cachedActiveApiBaseUrl: string | null = null;
let cachedRawApiBaseUrl: string | undefined;
let cachedRawLocalOrigin: string | undefined;

const readRawRuntimeGlobal = (key: '__OPENCHAMBER_API_BASE_URL__' | '__OPENCHAMBER_LOCAL_ORIGIN__'): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const value = (window as typeof window & {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
  })[key];
  return typeof value === 'string' ? value : undefined;
};

export const getRuntimeKey = (): string => {
  if (activeRuntimeKey) return activeRuntimeKey;

  const rawApiBaseUrl = readRawRuntimeGlobal('__OPENCHAMBER_API_BASE_URL__');
  const rawLocalOrigin = readRawRuntimeGlobal('__OPENCHAMBER_LOCAL_ORIGIN__');
  if (
    cachedActiveApiBaseUrl === activeApiBaseUrl
    && cachedRawApiBaseUrl === rawApiBaseUrl
    && cachedRawLocalOrigin === rawLocalOrigin
  ) {
    return cachedRuntimeKey;
  }

  const apiBaseUrl = getRuntimeApiBaseUrl();
  cachedRuntimeKey = sameOrigin(apiBaseUrl, readInjectedLocalOrigin())
    ? 'local'
    : normalizeRuntimeUrlKey(apiBaseUrl);
  cachedActiveApiBaseUrl = activeApiBaseUrl;
  cachedRawApiBaseUrl = rawApiBaseUrl;
  cachedRawLocalOrigin = rawLocalOrigin;
  return cachedRuntimeKey;
};

export const captureRuntimeInstance = (): (() => boolean) => {
  const generation = instanceGeneration;
  const runtimeKey = getRuntimeKey();
  return () => generation === instanceGeneration && runtimeKey === getRuntimeKey();
};

export const initializeRuntimeEndpoint = (options: { apiBaseUrl?: string | null; runtimeKey?: string | null } = {}): void => {
  if (activeApiBaseUrl || activeRuntimeKey) {
    return;
  }

  const apiBaseUrl = options.apiBaseUrl?.trim() || readInjectedApiBaseUrl();
  const pageOrigin = globalThis.window?.location?.origin ?? '';
  const sameOriginBaseUrl = /^https?:\/\//.test(pageOrigin) ? pageOrigin : '';
  if (!apiBaseUrl && !sameOriginBaseUrl) {
    return;
  }

  const localOrigin = readInjectedLocalOrigin();
  const isLocal = localOrigin && (!apiBaseUrl || sameOrigin(apiBaseUrl, localOrigin));
  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = options.runtimeKey?.trim() || (isLocal ? 'local' : normalizeRuntimeUrlKey(apiBaseUrl || sameOriginBaseUrl));
};

export const switchRuntimeEndpoint = (options: { apiBaseUrl: string; clientToken?: string | null; runtimeKey?: string | null; requestHeaders?: Record<string, string> | null; relay?: RelayRuntimeDescriptor | null; sshForwarded?: boolean }): void => {
  const apiBaseUrl = options.apiBaseUrl.trim();
  const previousApiBaseUrl = getRuntimeApiBaseUrl();
  const previousRuntimeKey = getRuntimeKey();
  const runtimeKey = options.runtimeKey?.trim() || normalizeRuntimeUrlKey(apiBaseUrl);
  const sshForwarded = options.sshForwarded ?? (
    apiBaseUrl === previousApiBaseUrl && runtimeKey === previousRuntimeKey && isSshForwardedRuntime()
  );
  const detail = { apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, { detail }));
  }
  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = runtimeKey;
  if (runtimeKey !== previousRuntimeKey) instanceGeneration += 1;
  activeSshForwarded = sshForwarded;
  if (typeof window !== 'undefined') {
    const runtimeWindow = window as typeof window & {
      __OPENCHAMBER_API_BASE_URL__?: string;
      __OPENCHAMBER_CLIENT_TOKEN__?: string;
      __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
    };
    setWindowRuntimeValue(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', apiBaseUrl);
    setWindowRuntimeValue(runtimeWindow, '__OPENCHAMBER_CLIENT_TOKEN__', options.clientToken || undefined);
    setWindowRuntimeValue(runtimeWindow, '__OPENCHAMBER_RUNTIME_HEADERS__', options.requestHeaders || undefined);
  }
  configureRuntimeUrlResolver({ apiBaseUrl, realtimeBaseUrl: apiBaseUrl });
  setRuntimeExtraHeaders(options.requestHeaders || null);
  setRuntimeBearerToken(options.clientToken || null);
  if (options.relay) {
    activateRelayTunnel(options.relay);
  } else {
    deactivateRelayTunnel();
  }
  void refreshRuntimeUrlAuthToken(apiBaseUrl).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_CHANGED_EVENT, {
      detail,
    }));
  }
};

export const subscribeRuntimeEndpointWillChange = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
};

export const subscribeRuntimeEndpointChanged = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
};
