import { refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayTunnel,
  type RelayRuntimeDescriptor,
} from '@/lib/relay/runtime-tunnel';

export { getActiveRelayTunnel };

export type RuntimeEndpointChangedDetail = {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
  transportIdentityChanged?: boolean;
};

const RUNTIME_ENDPOINT_CHANGED_EVENT = 'openchamber:runtime-endpoint-changed';

let activeApiBaseUrl = '';
let activeRuntimeKey = '';
let activeEndpointFingerprint = '';
let activeTransportFingerprint = '';

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

const normalizeHeaders = (headers?: Record<string, string> | null): Array<[string, string]> => {
  if (!headers) return [];
  return Object.entries(headers)
    .map(([key, value]) => [key.trim().toLowerCase(), value] as [string, string])
    .filter(([key]) => key.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
};

const buildEndpointFingerprint = (options: {
  apiBaseUrl: string;
  clientToken?: string | null;
  runtimeKey: string;
  requestHeaders?: Record<string, string> | null;
  relay?: RelayRuntimeDescriptor | null;
}): string => stableSerialize({
  apiBaseUrl: options.apiBaseUrl.replace(/\/+$/, ''),
  clientToken: options.clientToken || null,
  runtimeKey: options.runtimeKey,
  requestHeaders: normalizeHeaders(options.requestHeaders),
  relay: options.relay ?? null,
});

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

export const isRuntimeEndpointIdentityChange = (detail: RuntimeEndpointChangedDetail): boolean => (
  detail.transportIdentityChanged
  ?? normalizeRuntimeUrlKey(detail.apiBaseUrl) !== normalizeRuntimeUrlKey(detail.previousApiBaseUrl)
);

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
export const getRuntimeKey = (): string => {
  if (activeRuntimeKey) return activeRuntimeKey;
  const apiBaseUrl = getRuntimeApiBaseUrl();
  if (sameOrigin(apiBaseUrl, readInjectedLocalOrigin())) return 'local';
  return normalizeRuntimeUrlKey(apiBaseUrl);
};

export const initializeRuntimeEndpoint = (options: { apiBaseUrl?: string | null; runtimeKey?: string | null } = {}): void => {
  if (activeApiBaseUrl || activeRuntimeKey) {
    return;
  }

  const apiBaseUrl = options.apiBaseUrl?.trim() || readInjectedApiBaseUrl();
  if (!apiBaseUrl) {
    return;
  }

  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = options.runtimeKey?.trim() || (sameOrigin(apiBaseUrl, readInjectedLocalOrigin()) ? 'local' : normalizeRuntimeUrlKey(apiBaseUrl));
};

export const switchRuntimeEndpoint = (options: { apiBaseUrl: string; clientToken?: string | null; runtimeKey?: string | null; requestHeaders?: Record<string, string> | null; relay?: RelayRuntimeDescriptor | null }): void => {
  const apiBaseUrl = options.apiBaseUrl.trim();
  const previousApiBaseUrl = getRuntimeApiBaseUrl();
  const previousRuntimeKey = getRuntimeKey();
  const sameEndpoint = normalizeRuntimeUrlKey(apiBaseUrl) === normalizeRuntimeUrlKey(previousApiBaseUrl);
  const runtimeKey = options.runtimeKey?.trim()
    || (sameEndpoint ? previousRuntimeKey : normalizeRuntimeUrlKey(apiBaseUrl));
  const endpointFingerprint = buildEndpointFingerprint({ ...options, apiBaseUrl, runtimeKey });
  if (endpointFingerprint === activeEndpointFingerprint) {
    return;
  }
  const previousTransportFingerprint = activeTransportFingerprint
    || `direct:${normalizeRuntimeUrlKey(previousApiBaseUrl)}`;
  const transportFingerprint = options.relay
    ? `relay:${stableSerialize(options.relay)}`
    : `direct:${normalizeRuntimeUrlKey(apiBaseUrl)}`;
  const transportIdentityChanged = transportFingerprint !== previousTransportFingerprint;
  activeEndpointFingerprint = endpointFingerprint;
  activeTransportFingerprint = transportFingerprint;
  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = runtimeKey;
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
  // Relay mode routes runtime HTTP/WS through an E2EE tunnel instead of the
  // network. Activate the tunnel BEFORE minting the url token, since the mint
  // itself rides the tunnel (runtimeFetch -> tunnel.fetch).
  if (options.relay) {
    activateRelayTunnel(options.relay);
  } else {
    deactivateRelayTunnel();
  }
  void refreshRuntimeUrlAuthToken(apiBaseUrl).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_CHANGED_EVENT, {
      detail: { apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey, transportIdentityChanged },
    }));
  }
};

export const subscribeRuntimeEndpointChanged = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
};
