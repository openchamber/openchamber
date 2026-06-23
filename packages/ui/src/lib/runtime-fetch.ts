import { buildRuntimeAuthHeaders } from './runtime-auth';
import { getRuntimeUrlResolver, isOpenChamberInternalPath, type RuntimeUrlQuery } from './runtime-url';

export interface RuntimeFetchOptions extends RequestInit {
  query?: RuntimeUrlQuery;
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

const appendRuntimeQuery = (url: URL, query?: RuntimeUrlQuery): void => {
  if (!query) return;
  const entries = query instanceof URLSearchParams ? Array.from(query.entries()) : Object.entries(query);
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
};

const isActiveRuntimeServiceUrl = (url: URL): boolean => {
  try {
    const apiBase = getRuntimeUrlResolver().api('/api');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(apiBase)) return false;
    const base = new URL(apiBase);
    if (url.origin !== base.origin) return false;
    return shouldResolveApiPath(url.pathname);
  } catch {
    return false;
  }
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

// In proxy-bypass mode the SDK talks to OpenCode upstream via absolute
// URLs (e.g. http://127.0.0.1:4096/config, /session, /project). Those
// paths DON'T start with /api/ — `shouldResolveApiPath('/config')` is false.
// But the runtime-url resolver still considers them "active runtime service"
// because they target the OpenCode upstream base. We need to attach auth to
// ANY URL going to the OpenCode base, not just /api/* paths — otherwise the
// SDK calls fail with 401 and the UI shows empty lists.
const isRuntimeUpstreamUrl = (raw: string): boolean => {
  if (!isAbsoluteUrl(raw)) return false;
  try {
    const apiBase = getRuntimeUrlResolver().api('/api');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(apiBase)) return false;
    const base = new URL(apiBase);
    return new URL(raw).origin === base.origin;
  } catch {
    return false;
  }
};

const shouldAttachRuntimeAuth = (input: string | URL | Request): boolean => {
const raw = input instanceof Request ? input.url : input.toString();
if (!isAbsoluteUrl(raw)) {
return shouldResolveApiPath(raw);
}
  // Absolute URL: any path targeting the OpenCode upstream origin gets auth,
  // BUT only if the path is NOT an OpenChamber-internal path (those get
  // rewritten to page origin by runtimeFetch and don't need auth).
  try {
    if (isOpenChamberInternalPath(new URL(raw).pathname)) return false;
  } catch {
    // ignore parse errors
  }
return isRuntimeUpstreamUrl(raw);
};

// In proxy-bypass mode the OpenCode SDK has its baseUrl set to the
// external OpenCode upstream. But some OpenChamber code calls the SDK
// for OpenChamber-internal endpoints (e.g. /fs/home, /path,
// /session-folders, /project/current, /config/settings).
// Those calls arrive at runtimeFetch as absolute URLs to :4096 with
// OpenChamber-internal paths — and 401 because OpenCode upstream
// doesn't have them.
//
// This helper detects that case and rewrites the URL to the page
// origin (with the /api/ prefix inserted if missing) so the request
// reaches OpenChamber Express instead.
const rewriteOpenChamberInternalUrl = (input: string | URL | Request): string | URL | Request => {
  if (typeof window === 'undefined') return input;
  let raw: string;
  try {
    if (typeof input === 'string') raw = input;
    else if (input instanceof URL) raw = input.toString();
    else raw = input.url;
  } catch {
    return input;
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return input;
  try {
    const url = new URL(raw);
    if (url.origin === window.location.origin) return input;
    if (!isOpenChamberInternalPath(url.pathname + url.search)) return input;
    // OpenChamber Express serves the /api/* form. If the URL doesn't
    // already start with /api/, insert it before the pathname.
    const apiPrefix = url.pathname.startsWith('/api/') || url.pathname === '/api' ? '' : '/api';
    return `${window.location.origin}${apiPrefix}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return input;
  }
};

// Headers API only accepts ISO-8859-1 (Latin-1) characters. Any value containing
// characters outside \u0000-\u00FF causes "Failed to construct/set 'Headers':
// String contains non ISO-8859-1 code point." Encode those values so they round-trip
// safely through the browser's Headers API. Directory hints get an explicit marker
// only when encoded, so plain ASCII paths remain compatible with routes that read
// the header directly.
export const isLatin1Safe = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xFF) return false;
  }
  return true;
};

const shouldEncodeHeaderValue = (_key: string, value: string): boolean => !isLatin1Safe(value);

export const sanitizeHeadersForBrowser = (init?: HeadersInit): [string, string][] | undefined => {
  if (!init) return undefined;
  // Normalize any HeadersInit shape into a plain array of entries so we can
  // safely inspect and re-encode non-Latin-1 values.
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

// ---------------------------------------------------------------------------
// In-flight read coalescing
//
// On cold start two independent data layers (the sync bootstrap and the config
// store) fire the SAME idempotent reads — providers, config, path, agents,
// project — concurrently, with no shared dedup. That saturates the single
// OpenCode process and delays everything queued behind it (e.g. createSession).
// Coalesce genuinely-concurrent identical GETs to those read endpoints so
// OpenCode does the work once; every caller gets an independent `clone()`.
//
// Scope is deliberately tight: GET only, an allowlist of read paths, never an
// event stream, and never a request carrying an AbortSignal (so one caller
// aborting can't cancel the shared fetch for the others). The entry is removed
// as soon as the request settles, so this only ever shares overlapping in-flight
// requests — it never serves a stale/cached response.
// ---------------------------------------------------------------------------
const COALESCE_READ_PATH = /\/api\/(config|path|app\/agents|agent|project|command)(\b|\/|\?|$)/;
const READ_COALESCE = new Map<string, Promise<Response>>();

const coalesceReadKey = (method: string, url: string, hasSignal: boolean): string | null => {
  if (hasSignal) return null;
  if (method !== 'GET') return null;
  if (url.includes('/event')) return null;
  if (!COALESCE_READ_PATH.test(url)) return null;
  return `GET ${url}`;
};

export const runtimeFetch = async (input: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> => {
  const { query, ...requestInit } = init;
  // Rewrite absolute URLs to OpenCode upstream that target OpenChamber-internal
  // endpoints (e.g. /fs/home, /path, /session-folders) back to the page origin
  // (where OpenChamber Express serves /api/fs/home, /api/path, etc.). The SDK
  // strips /api/ when calling internal endpoints but the Express routes require
  // it, so we re-insert it in the rewrite.
  const rewrittenInput = rewriteOpenChamberInternalUrl(input);
  const resolvedInput = resolveRuntimeFetchInput(rewrittenInput, query);
  const inputHeaders = resolvedInput instanceof Request ? resolvedInput.headers : undefined;
  const headers = await mergeHeaders(inputHeaders, requestInit.headers, shouldAttachRuntimeAuth(resolvedInput));
  const doFetch = (): Promise<Response> =>
    resolvedInput instanceof Request
      ? fetch(new Request(resolvedInput, { ...requestInit, headers }))
      : fetch(resolvedInput, { ...requestInit, headers });

  const url =
    resolvedInput instanceof Request ? resolvedInput.url
    : resolvedInput instanceof URL ? resolvedInput.toString()
    : String(resolvedInput);
  const method = String(
    requestInit.method ?? (resolvedInput instanceof Request ? resolvedInput.method : 'GET'),
  ).toUpperCase();
  // A Request always carries a (possibly default) signal; treat any Request, or
  // an explicit init.signal, as "has signal" and skip coalescing for safety.
  const hasSignal = requestInit.signal != null || resolvedInput instanceof Request;

  const key = coalesceReadKey(method, url, hasSignal);
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

// Cross-origin fetches (e.g. the SDK talking to an external OpenCode upstream
// in proxy-bypass mode) MUST NOT use credentials: 'include' — the browser
// requires Access-Control-Allow-Credentials: true on the response, but the
// OpenCode upstream only sets Access-Control-Allow-Origin. Since we send
// Authorization: Basic (or Bearer) on every cross-origin call, we don't need
// cookies / credentials mode — drop it to keep CORS preflight happy.
const resolveFetchCredentials = (target: string, init?: RequestInit): RequestCredentials | undefined => {
  if (init && typeof init.credentials === 'string') {
    return init.credentials;
  }
  if (typeof window === 'undefined') return init?.credentials;
  try {
    const targetOrigin = new URL(target, window.location.href).origin;
    if (targetOrigin !== window.location.origin) {
      return 'omit';
    }
  } catch {
    // Non-URL target — fall through and let the browser handle it.
  }
  return init?.credentials;
};

export const installRuntimeFetchBridge = (): void => {
  if (runtimeFetchBridgeInstalled || typeof window === 'undefined') return;
  runtimeFetchBridgeInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  const mergedInit = (input: RequestInfo | URL, init?: RequestInit, targetOverride?: string) => {
    const target = targetOverride ?? (typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    return { ...init, credentials: resolveFetchCredentials(target, init) };
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // ALWAYS override credentials for cross-origin calls so the browser
    // doesn't require Access-Control-Allow-Credentials on the preflight.
    // This applies even on the early-return paths below (SDK calls to
    // /config, /session, /global/event, etc. which don't match the
    // shouldResolveFetchInput gate). We send Authorization header explicitly,
    // so we never need cookies / credentials mode cross-origin.
    if (typeof window === 'undefined') {
      return nativeFetch(input, init);
    }
    const resolveTargetOrigin = (): string => {
      try {
        if (typeof input === 'string') return new URL(input, window.location.href).origin;
        if (input instanceof URL) return input.origin;
        if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url, window.location.href).origin;
      } catch {
        // Non-URL fallback
      }
      return '';
    };
    const targetOrigin = resolveTargetOrigin();
    const isCrossOrigin = targetOrigin !== '' && targetOrigin !== window.location.origin;
    const safeInit = isCrossOrigin ? { ...init, credentials: 'omit' as RequestCredentials } : init;

    if (typeof input === 'string') {
      if (!shouldResolveFetchInput(input)) {
        try {
          const url = new URL(input);
          if (isActiveRuntimeServiceUrl(url)) {
            const headers = await mergeHeaders(undefined, init?.headers);
            return nativeFetch(input, { ...mergedInit(input, init), headers });
          }
        } catch {
          // Non-URL fetch inputs should fall through unchanged.
        }
        return nativeFetch(input, safeInit);
      }
      const target = buildRuntimeFetchUrl(input);
      const headers = await mergeHeaders(undefined, init?.headers);
      return nativeFetch(target, { ...mergedInit(input, init, target), headers });
    }

    if (input instanceof URL) {
      const raw = input.toString();
      if (!shouldResolveFetchInput(raw)) {
        if (isActiveRuntimeServiceUrl(input)) {
          const headers = await mergeHeaders(undefined, init?.headers);
          return nativeFetch(input, { ...mergedInit(input, init), headers });
        }
        return nativeFetch(input, safeInit);
      }
      const target = buildRuntimeFetchUrl(raw);
      const headers = await mergeHeaders(undefined, init?.headers);
      return nativeFetch(target, { ...mergedInit(input, init, target), headers });
    }

    if (input instanceof Request) {
      if (!shouldResolveFetchInput(input.url)) {
        try {
          const url = new URL(input.url);
          if (isActiveRuntimeServiceUrl(url)) {
            const headers = await mergeHeaders(input.headers, init?.headers);
            return nativeFetch(new Request(input, { ...mergedInit(input, init), headers }));
          }
        } catch {
          // Non-URL request inputs should fall through unchanged.
        }
        return nativeFetch(input, safeInit);
      }
      const headers = await mergeHeaders(input.headers, init?.headers);
      const target = buildRuntimeFetchUrl(input.url);
      const request = target === input.url ? input : new Request(target, input);
      return nativeFetch(new Request(request, { ...mergedInit(input, init, target), headers }));
    }

    return nativeFetch(input, safeInit);
  };
};
