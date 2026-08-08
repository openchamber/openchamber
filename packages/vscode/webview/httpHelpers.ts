import { sanitizeHeadersForBrowser } from '@openchamber/ui/lib/runtime-fetch';

export const normalizeUrl = (input: string | URL) => {
  try {
    return typeof input === 'string' ? new URL(input, window.location.href) : new URL(input.toString(), window.location.href);
  } catch {
    return null;
  }
};

export const headersToRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  const normalized = new Headers(sanitizeHeadersForBrowser(headers) ?? headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

export const getRequestHeaders = (input?: RequestInfo | URL, init?: RequestInit): Record<string, string> => {
  const headersFromRequest = input instanceof Request ? headersToRecord(input.headers) : {};
  const headersFromInit = headersToRecord(init?.headers);
  return { ...headersFromRequest, ...headersFromInit };
};

export const getRequestDirectoryHint = (url: URL, input?: RequestInfo | URL, init?: RequestInit): string | undefined => {
  const queryDirectory = url.searchParams.get('directory') || undefined;
  if (queryDirectory) return queryDirectory;
  const headers = getRequestHeaders(input, init);
  const directoryEncoding = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-opencode-directory-encoding')?.[1];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-opencode-directory') {
      // headersToRecord marks encoded directory hints so direct/raw percent
      // sequences from other callers are not decoded accidentally.
      if (directoryEncoding !== 'uri') return value;
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return undefined;
};

export const decodeBase64 = (value: string): ArrayBuffer => {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
};

export const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

export const unsupportedWebRouteResponse = (feature: string): Response => {
  return jsonResponse({ error: `${feature} is not supported in VS Code` }, 501);
};

export const pluginConfigErrorStatus = (message: string): number => {
  const lower = message.toLowerCase();
  if (lower.includes('already exists')) return 409;
  if (lower.includes('not found')) return 404;
  if (lower.includes('required') || lower.includes('invalid') || lower.includes('must ')) return 400;
  return 500;
};

export const isNullBodyStatus = (status: number): boolean => status === 204 || status === 205 || status === 304;

export const buildProxiedResponse = (
  proxied: { status: number; headers: Record<string, string>; bodyBase64?: string; bodyText?: string }
): Response => {
  if (isNullBodyStatus(proxied.status)) {
    return new Response(null, { status: proxied.status, headers: proxied.headers });
  }

  if (typeof proxied.bodyText === 'string') {
    return new Response(proxied.bodyText, { status: proxied.status, headers: proxied.headers });
  }

  const body = proxied.bodyBase64 ? decodeBase64(proxied.bodyBase64) : new ArrayBuffer(0);
  return new Response(body, { status: proxied.status, headers: proxied.headers });
};

export const isSseApiPath = (pathname: string) => pathname === '/api/event' || pathname === '/api/global/event';
export const isSessionMessageApiPath = (pathname: string) => /^\/api\/session\/[^/]+\/message$/.test(pathname);
export const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');
export const isLocalRuntimePath = (pathname: string) => isApiPath(pathname) || pathname === '/auth/session';
