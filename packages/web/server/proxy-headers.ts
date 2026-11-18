export const BROWSER_FETCH_METADATA_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];

const filteredRequestHeaders = new Set([
  'authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
  ...BROWSER_FETCH_METADATA_HEADERS,
]);

const filteredResponseHeaders = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'www-authenticate',
  'content-encoding',
]);

export const collectForwardProxyHeaders = (requestHeaders: IncomingHttpHeaders | null | undefined, authHeaders: { Authorization?: string } = {}) => {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(requestHeaders || {})) {
    if (!value) continue;
    const normalizedKey = key.toLowerCase();
    if (filteredRequestHeaders.has(normalizedKey)) continue;
    headers[normalizedKey] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (authHeaders.Authorization) {
    headers.Authorization = authHeaders.Authorization;
  }

  return headers;
};

export const shouldForwardProxyResponseHeader = (key: string | null | undefined) => {
  if (!isString(key) || key.trim().length === 0) {
    return false;
  }

  return !filteredResponseHeaders.has(key.toLowerCase());
};

interface HeaderResponse {
  setHeader: (key: string, value: string) => void;
}

const isHeaderResponse = (value: { setHeader?: unknown } | null | undefined): value is HeaderResponse =>
  typeof value?.setHeader === 'function';

export const applyForwardProxyResponseHeaders = (responseHeaders: Pick<Headers, 'entries'> | null | undefined, response: HeaderResponse | null | undefined) => {
  if (!responseHeaders || !isHeaderResponse(response)) {
    return;
  }

  for (const [key, value] of responseHeaders.entries()) {
    if (!shouldForwardProxyResponseHeader(key)) {
      continue;
    }
    response.setHeader(key, value);
  }
};
import type { IncomingHttpHeaders } from 'node:http';
import { isString } from './lib/shared/guards.js';
