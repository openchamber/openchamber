import { getLocalRuntimeUrlAuthTokenSync, getRuntimeExtraHeadersSync, getRuntimeUrlAuthTokenSync } from '@/lib/runtime-auth';

type QueryValue = string | number | boolean | null | undefined;

export type RuntimeUrlQuery = Record<string, QueryValue> | URLSearchParams;

export interface RuntimeUrlConfig {
  apiBaseUrl?: string | null;
  realtimeBaseUrl?: string | null;
  currentHref?: () => string;
}

export interface RuntimeUrlResolver {
  api(path: string, query?: RuntimeUrlQuery): string;
  authenticatedAsset(path: string, query?: RuntimeUrlQuery): string;
  auth(path: string, query?: RuntimeUrlQuery): string;
  health(query?: RuntimeUrlQuery): string;
  rawFile(path: string, options?: { download?: boolean; allowOutsideWorkspace?: boolean; outsideFileGrant?: string }): string;
  sse(path: string, query?: RuntimeUrlQuery): string;
  websocket(path: string, query?: RuntimeUrlQuery): string;
}

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

const normalizePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const normalizeBaseUrl = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
};

const readInjectedApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__;
  return normalizeBaseUrl(injected);
};

const readInjectedLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return normalizeBaseUrl(injected);
};

const hasRuntimeExtraHeaders = (): boolean => Object.keys(getRuntimeExtraHeadersSync()).length > 0;

const currentHref = (config: RuntimeUrlConfig): string => {
  const configured = config.currentHref?.();
  if (configured) return configured;
  if (typeof window !== 'undefined') {
    return window.location.href || window.location.origin;
  }
  return '';
};

const appendQuery = (url: URL, query?: RuntimeUrlQuery): void => {
  if (!query) return;

  const entries = query instanceof URLSearchParams
    ? Array.from(query.entries())
    : Object.entries(query);

  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
};

const appendRelativeQuery = (path: string, query?: RuntimeUrlQuery): string => {
  if (!query) return path;
  const params = new URLSearchParams();
  appendQuery({ searchParams: params } as URL, query);
  const serialized = params.toString();
  if (!serialized) return path;
  return path.includes('?') ? `${path}&${serialized}` : `${path}?${serialized}`;
};

const buildHttpUrl = (baseUrl: string, path: string, query?: RuntimeUrlQuery): string => {
  if (ABSOLUTE_URL_PATTERN.test(path)) {
    const url = new URL(path);
    appendQuery(url, query);
    return url.toString();
  }

  const normalizedPath = normalizePath(path);
  if (!baseUrl) {
    return appendRelativeQuery(normalizedPath, query);
  }

  const url = new URL(normalizedPath, `${baseUrl}/`);
  appendQuery(url, query);
  return url.toString();
};

const withUrlAuth = (urlValue: string): string => {
  const token = getRuntimeUrlAuthTokenSync();
  if (!token) return urlValue;

  const url = ABSOLUTE_URL_PATTERN.test(urlValue)
    ? new URL(urlValue)
    : new URL(urlValue, 'http://openchamber.local');
  url.searchParams.set('oc_url_token', token);
  if (ABSOLUTE_URL_PATTERN.test(urlValue)) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
};

const toWebSocketUrl = (candidate: string, config: RuntimeUrlConfig): string => {
  const url = ABSOLUTE_URL_PATTERN.test(candidate)
    ? new URL(candidate)
    : new URL(candidate, currentHref(config));
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return url.toString();
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const toRealtimeProxyUrl = (kind: 'sse' | 'ws', targetUrl: string, config: RuntimeUrlConfig): string | null => {
  if (!hasRuntimeExtraHeaders()) return null;
  const localOrigin = readInjectedLocalOrigin();
  if (!localOrigin) return null;
  try {
    const proxy = new URL(`/api/openchamber/realtime-proxy/${kind === 'sse' ? 'sse' : 'ws'}`, `${localOrigin}/`);
    proxy.searchParams.set('url', targetUrl);
    const localToken = getLocalRuntimeUrlAuthTokenSync(localOrigin);
    if (localToken) proxy.searchParams.set('oc_url_token', localToken);
    if (kind === 'ws') {
      proxy.protocol = proxy.protocol === 'https:' ? 'wss:' : 'ws:';
      return toWebSocketUrl(proxy.toString(), config);
    }
    return proxy.toString();
  } catch {
    return null;
  }
};

export const createRuntimeUrlResolver = (config: RuntimeUrlConfig = {}): RuntimeUrlResolver => {
  const configuredApiBaseUrl = normalizeBaseUrl(config.apiBaseUrl);
  const configuredRealtimeBaseUrl = normalizeBaseUrl(config.realtimeBaseUrl);

  const apiBaseUrl = (): string => configuredApiBaseUrl || readInjectedApiBaseUrl();
  const realtimeBaseUrl = (): string => configuredRealtimeBaseUrl || apiBaseUrl();

  const http = (path: string, query?: RuntimeUrlQuery): string => buildHttpUrl(apiBaseUrl(), path, query);
  const realtime = (path: string, query?: RuntimeUrlQuery): string => buildHttpUrl(realtimeBaseUrl(), path, query);

  return {
    api: http,
    authenticatedAsset: (path, query) => withUrlAuth(http(path, query)),
    auth: http,
    health: (query) => http('/health', query),
    rawFile: (path, options) => http('/api/fs/raw', {
      path,
      download: options?.download === true ? true : undefined,
      allowOutsideWorkspace: options?.allowOutsideWorkspace === true ? true : undefined,
      outsideFileGrant: options?.outsideFileGrant,
    }),
    sse: (path, query) => {
      const target = withUrlAuth(realtime(path, query));
      return toRealtimeProxyUrl('sse', target, config) || target;
    },
    websocket: (path, query) => {
      const target = toWebSocketUrl(withUrlAuth(realtime(path, query)), config);
      return toRealtimeProxyUrl('ws', target, config) || target;
    },
  };
};

let activeRuntimeUrlResolver = createRuntimeUrlResolver();

export const getRuntimeUrlResolver = (): RuntimeUrlResolver => activeRuntimeUrlResolver;

export const setRuntimeUrlResolver = (resolver: RuntimeUrlResolver): void => {
  activeRuntimeUrlResolver = resolver;
};

export const configureRuntimeUrlResolver = (config: RuntimeUrlConfig): RuntimeUrlResolver => {
  activeRuntimeUrlResolver = createRuntimeUrlResolver(config);
  return activeRuntimeUrlResolver;
};
