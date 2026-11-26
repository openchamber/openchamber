import { getActiveRelayTunnel } from './relay/runtime-tunnel';
import { TUNNEL_PARSE_BASE } from './relay/tunnel-payloads';
import { buildRuntimeAuthHeaders, getRuntimeExtraHeadersSync } from './runtime-auth';
import { isCapacitorApp } from './platform';
import { observeRuntimeAuthResponse } from './runtime-auth-expiry';
import { getRuntimeUrlResolver, type RuntimeUrlQuery } from './runtime-url';
import { spaceDirectoryHeaders } from './spaces/space-route';

export interface RuntimeFetchOptions extends RequestInit {
  query?: RuntimeUrlQuery;
  directory?: string | null;
}

const shouldResolveApiPath = (input: string): boolean => {
  return input.startsWith('/api/') || input === '/api' || input.startsWith('/auth/') || input === '/auth' || input === '/health';
};

const getCurrentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.location.origin || '';
};

const isCurrentWindowUrl = (url: URL): boolean => {
  if (typeof window === 'undefined') return false;
  const currentOrigin = getCurrentOrigin();
  if (currentOrigin && url.origin === currentOrigin) return true;
  try {
    const current = new URL(window.location.href || currentOrigin);
    return url.protocol === current.protocol && url.host === current.host;
  } catch {
    return false;
  }
};

const isAbsoluteUrl = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value);

const isNgrokHost = (hostname: string): boolean =>
  /(^|\.)ngrok(?:-free)?\.(?:app|dev|io)$/i.test(hostname);

export const addRuntimeProxyHeaders = (url: string, headers: Headers): Headers => {
  try {
    if (isNgrokHost(new URL(url).hostname) && !headers.has('ngrok-skip-browser-warning')) {
      headers.set('ngrok-skip-browser-warning', 'openchamber');
    }
  } catch {
    // Relative and non-HTTP runtime paths do not need proxy-specific headers.
  }
  return headers;
};

const appendRuntimeQuery = (url: URL, query?: RuntimeUrlQuery): void => {
  if (!query) return;
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) url.searchParams.append(key, value);
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
};

const hasDirectoryHeader = (headers: HeadersInit | undefined): boolean => {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has('x-opencode-directory');
  const entries: Iterable<[string, string]> = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key] of entries) {
    if (key.toLowerCase() === 'x-opencode-directory') return true;
  }
  return false;
};

const withSpaceDirectory = (input: string | URL | Request, init: RequestInit, directory: string | null | undefined): RequestInit => {
  const spaceHeaders = spaceDirectoryHeaders(directory);
  if (spaceHeaders === null || hasDirectoryHeader(init.headers)) return init;
  if (input instanceof Request && input.headers.has('x-opencode-directory')) return init;
  const own: [string, string][] = !init.headers ? []
    : init.headers instanceof Headers ? Array.from(init.headers.entries())
    : Array.isArray(init.headers) ? init.headers : Object.entries(init.headers);
  return { ...init, headers: [...own, ...Object.entries(spaceHeaders)] };
};

const activeRuntimeServiceRoot = (): string | null => {
  const apiBase = getRuntimeUrlResolver().api('/api');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(apiBase)) return null;
  const base = new URL(apiBase);
  return `${base.origin}${base.pathname.replace(/\/api$/, '')}`;
};

const activeRuntimeServicePath = (url: URL): string | null => {
  try {
    const root = activeRuntimeServiceRoot();
    if (!root) return null;
    const rootUrl = new URL(root);
    if (url.origin !== rootUrl.origin) return null;
    const prefix = rootUrl.pathname.replace(/\/+$/, '');
    if (!prefix) return url.pathname;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
    return url.pathname.slice(prefix.length) || '/';
  } catch {
    return null;
  }
};

const isActiveRuntimeServiceUrl = (url: URL): boolean => {
  const path = activeRuntimeServicePath(url);
  return path !== null && shouldResolveApiPath(path);
};

const shouldResolveFetchInput = (input: string): boolean => {
  if (shouldResolveApiPath(input)) return true;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return false;
  try {
    const url = new URL(input);
    return isCurrentWindowUrl(url) && shouldResolveApiPath(url.pathname);
  } catch {
    return false;
  }
};

const buildRuntimeFetchUrlFromAbsolute = (input: string, query?: RuntimeUrlQuery): string => {
  try {
    const url = new URL(input);
    if (!isCurrentWindowUrl(url)) return input;
    const rewritten = buildRuntimeFetchUrl(`${url.pathname}${url.search}`, query);
    if (!isAbsoluteUrl(rewritten) && (url.protocol === 'http:' || url.protocol === 'https:')) {
      appendRuntimeQuery(url, query);
      return url.toString();
    }
    return url.hash ? `${rewritten}${url.hash}` : rewritten;
  } catch {
    return input;
  }
};

export const buildRuntimeFetchUrl = (input: string, query?: RuntimeUrlQuery): string => {
  if (input === '/health') return getRuntimeUrlResolver().health(query);
  if (input.startsWith('/auth/') || input === '/auth') return getRuntimeUrlResolver().auth(input, query);
  if (shouldResolveApiPath(input)) return getRuntimeUrlResolver().api(input, query);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return buildRuntimeFetchUrlFromAbsolute(input, query);
  return input;
};

const shouldAttachRuntimeAuth = (input: string | URL | Request): boolean => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    return shouldResolveApiPath(raw);
  }

  try {
    return isActiveRuntimeServiceUrl(new URL(raw));
  } catch {
    return false;
  }
};

const mobileRedirectPolicy = (input: string | URL | Request, init?: RequestInit): RequestInit | undefined =>
  Object.keys(getRuntimeExtraHeadersSync()).length > 0 && isCapacitorApp() && shouldAttachRuntimeAuth(input)
    ? { ...init, redirect: 'error' }
    : init;

// external: https://fetch.spec.whatwg.org/#headers-class Headers values are ByteStrings; non-Latin-1 directory hints need marked encoding.
export const isLatin1Safe = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xFF) return false;
  }
  return true;
};

const shouldEncodeHeaderValue = (_key: string, value: string): boolean => !isLatin1Safe(value);

export const sanitizeHeadersForBrowser = (init?: HeadersInit): [string, string][] | undefined => {
  if (!init) return undefined;
  const sourceEntries: [string, string][] = init instanceof Headers
    ? Array.from(init.entries())
    : Array.isArray(init)
      ? init
      : Object.entries(init);
  if (sourceEntries.length === 0) return undefined;
  const entries: [string, string][] = [];
  let dirty = false;
  let encodedDirectoryHint = false;
  for (const [key, value] of sourceEntries) {
    if (shouldEncodeHeaderValue(key, value)) {
      entries.push([key, encodeURIComponent(value)]);
      dirty = true;
      if (key.toLowerCase() === 'x-opencode-directory') encodedDirectoryHint = true;
    } else {
      entries.push([key, value]);
    }
  }
  if (encodedDirectoryHint) {
    entries.push(['x-opencode-directory-encoding', 'uri']);
  }
  return dirty ? entries : undefined;
};

const mergeHeaders = async (inputHeaders?: HeadersInit, initHeaders?: HeadersInit, attachAuth = true): Promise<Headers> => {
  const headers = new Headers(sanitizeHeadersForBrowser(inputHeaders) ?? inputHeaders);
  if (initHeaders) {
    new Headers(sanitizeHeadersForBrowser(initHeaders) ?? initHeaders).forEach((value, key) => headers.set(key, value));
  }
  if (!attachAuth) {
    return headers;
  }
  return buildRuntimeAuthHeaders(headers);
};

const appendPathQuery = (path: string, query?: RuntimeUrlQuery): string => {
  if (!query) return path;
  const url = new URL(path, TUNNEL_PARSE_BASE);
  appendRuntimeQuery(url, query);
  return `${url.pathname}${url.search}`;
};

const extractRelayPath = (input: string | URL | Request, query?: RuntimeUrlQuery): string | null => {
  const raw = input instanceof Request ? input.url : input.toString();
  if (!isAbsoluteUrl(raw)) {
    if (!shouldResolveApiPath(raw)) return null;
    return appendPathQuery(raw, query);
  }
  try {
    const url = new URL(raw);
    if (!isCurrentWindowUrl(url) || !shouldResolveApiPath(url.pathname)) return null;
    appendRuntimeQuery(url, query);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
};

const tryRelayFetch = async (
  input: string | URL | Request,
  requestInit: RequestInit,
  query?: RuntimeUrlQuery,
): Promise<Response | null> => {
  const relay = getActiveRelayTunnel();
  if (!relay) return null;
  const path = extractRelayPath(input, query);
  if (path === null) return null;
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  const headers = await mergeHeaders(inputHeaders, requestInit.headers, true);
  if (input instanceof Request) {
    return relay.fetch(input, { ...requestInit, headers });
  }
  return relay.fetch(path, { ...requestInit, headers });
};

const resolveRuntimeFetchInput = (input: string | URL | Request, query?: RuntimeUrlQuery): string | URL | Request => {
  if (typeof input === 'string') {
    return buildRuntimeFetchUrl(input, query);
  }

  if (input instanceof URL) {
    return buildRuntimeFetchUrl(input.toString(), query);
  }

  const target = buildRuntimeFetchUrl(input.url, query);
  return target === input.url ? input : new Request(target, input);
};

const COALESCE_READ_PATH = /\/api\/(config|path|app\/agents|agent|project|command)(\b|\/|\?|$)/;
const READ_COALESCE = new Map<string, Promise<Response>>();

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/server OpenCode scopes config reads by x-opencode-directory, so coalescing includes that header.
const coalesceReadKey = (method: string, url: string, hasSignal: boolean, headers: Headers): string | null => {
  if (hasSignal) return null;
  if (method !== 'GET') return null;
  if (url.includes('/event')) return null;
  if (url.includes('/api/config/settings')) return null;
  if (!COALESCE_READ_PATH.test(url)) return null;
  return `GET ${url}\u0000${headers.get('x-opencode-directory') ?? ''}`;
};

type RuntimeRequestObserver = (request: { method: string; url: string; status: number | null; durationMs: number }) => void;
let runtimeRequestObserver: RuntimeRequestObserver | null = null;

export const setRuntimeRequestObserver = (observer: RuntimeRequestObserver | null): void => {
  runtimeRequestObserver = observer;
};

export const runtimeFetch = async (rawInput: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> => {
  const { query, directory, ...ownInit } = init;
  const input = rawInput;
  const requestInit = withSpaceDirectory(input, ownInit, directory);

  const relay = getActiveRelayTunnel();
  const relayPath = relay ? extractRelayPath(input, query) : null;

  let doFetch: () => Promise<Response>;
  let url: string;
  let method: string;
  let scopeHeaders: Headers;
  if (relay && relayPath !== null) {
    const inputHeaders = input instanceof Request ? input.headers : undefined;
    const headers = await mergeHeaders(inputHeaders, requestInit.headers, true);
    doFetch = input instanceof Request
      ? () => relay.fetch(input, { ...requestInit, headers })
      : () => relay.fetch(relayPath, { ...requestInit, headers });
    scopeHeaders = headers;
    url = relayPath;
    method = String(requestInit.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  } else {
    const resolvedInput = resolveRuntimeFetchInput(input, query);
    const inputHeaders = resolvedInput instanceof Request ? resolvedInput.headers : undefined;
    const headers = await mergeHeaders(inputHeaders, requestInit.headers, shouldAttachRuntimeAuth(resolvedInput));
    const resolvedUrl =
      resolvedInput instanceof Request ? resolvedInput.url
      : resolvedInput instanceof URL ? resolvedInput.toString()
      : String(resolvedInput);
    addRuntimeProxyHeaders(resolvedUrl, headers);
    const networkInit = mobileRedirectPolicy(resolvedInput, { ...requestInit, headers });
    doFetch = resolvedInput instanceof Request
      ? () => fetch(new Request(resolvedInput, networkInit))
      : () => fetch(resolvedInput, networkInit);
    scopeHeaders = headers;
    url = resolvedUrl;
    method = String(
      requestInit.method ?? (resolvedInput instanceof Request ? resolvedInput.method : 'GET'),
    ).toUpperCase();
  }

  const rawFetch = doFetch;
  const observer = runtimeRequestObserver;
  doFetch = async () => {
    const startedAt = observer ? performance.now() : 0;
    try {
      const response = await rawFetch();
      observeRuntimeAuthResponse(url, response.status);
      observer?.({ method, url, status: response.status, durationMs: performance.now() - startedAt });
      return response;
    } catch (error) {
      observer?.({ method, url, status: null, durationMs: performance.now() - startedAt });
      throw error;
    }
  };

  const hasSignal = requestInit.signal != null || input instanceof Request;

  const key = coalesceReadKey(method, url, hasSignal, scopeHeaders);
  if (!key) return doFetch();

  const existing = READ_COALESCE.get(key);
  if (existing) return existing.then((res) => res.clone());

  const pending = doFetch();
  READ_COALESCE.set(key, pending);
  pending.then(
    () => READ_COALESCE.delete(key),
    () => READ_COALESCE.delete(key),
  );
  return pending.then((res) => res.clone());
};

let runtimeFetchBridgeInstalled = false;
let fetchBypassingRuntimeBridgeImpl: typeof fetch | null = null;

export const fetchBypassingRuntimeBridge = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => (
  (fetchBypassingRuntimeBridgeImpl ?? globalThis.fetch.bind(globalThis))(input, init)
);

export const installRuntimeFetchBridge = (): void => {
  if (runtimeFetchBridgeInstalled || typeof window === 'undefined') return;
  runtimeFetchBridgeInstalled = true;

  const originalFetch = window.fetch.bind(window);
  fetchBypassingRuntimeBridgeImpl = originalFetch;
  const nativeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    originalFetch(input, mobileRedirectPolicy(input, init));
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const relayResponse = await tryRelayFetch(input, init ?? {});
    if (relayResponse) return relayResponse;
    if (typeof input === 'string') {
      if (!shouldResolveFetchInput(input)) {
        try {
          const url = new URL(input);
          if (isActiveRuntimeServiceUrl(url)) {
            const headers = await mergeHeaders(undefined, init?.headers);
            addRuntimeProxyHeaders(url.toString(), headers);
            return nativeFetch(input, { ...init, headers });
          }
        } catch {
          // Non-URL fetch inputs should fall through unchanged.
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(undefined, init?.headers);
      const target = buildRuntimeFetchUrl(input);
      addRuntimeProxyHeaders(target, headers);
      return nativeFetch(target, { ...init, headers });
    }

    if (input instanceof URL) {
      const raw = input.toString();
      if (!shouldResolveFetchInput(raw)) {
        if (isActiveRuntimeServiceUrl(input)) {
          const headers = await mergeHeaders(undefined, init?.headers);
          addRuntimeProxyHeaders(input.toString(), headers);
          return nativeFetch(input, { ...init, headers });
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(undefined, init?.headers);
      const target = buildRuntimeFetchUrl(raw);
      addRuntimeProxyHeaders(target, headers);
      return nativeFetch(target, { ...init, headers });
    }

    if (input instanceof Request) {
      if (!shouldResolveFetchInput(input.url)) {
        try {
          const url = new URL(input.url);
          if (isActiveRuntimeServiceUrl(url)) {
            const headers = await mergeHeaders(input.headers, init?.headers);
            addRuntimeProxyHeaders(url.toString(), headers);
            return nativeFetch(new Request(input, { ...init, headers }));
          }
        } catch {
          // Non-URL request inputs should fall through unchanged.
        }
        return nativeFetch(input, init);
      }
      const headers = await mergeHeaders(input.headers, init?.headers);
      const target = buildRuntimeFetchUrl(input.url);
      addRuntimeProxyHeaders(target, headers);
      const request = target === input.url ? input : new Request(target, input);
      return nativeFetch(new Request(request, { ...init, headers }));
    }

    return nativeFetch(input, init);
  };
};
