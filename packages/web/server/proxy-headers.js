// Browser request metadata carries the page origin and the browser's fetch
// classification. OpenCode 2.2.6 rejects `/api` requests that pair a
// cross-site `Sec-Fetch-Site` with an untrusted `Origin`, and packaged clients
// (`openchamber-ui://app`, `capacitor://localhost`) are not on its trust list.
// This proxy is the server-to-server hop, so none of these headers belong
// upstream.
const browserRequestMetadataHeaders = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);

const filteredRequestHeaders = new Set([
  ...browserRequestMetadataHeaders,
  // Client credentials for the OpenChamber server (UI client tokens) must
  // never reach the managed OpenCode upstream — it only accepts its own auth,
  // so a forwarded client bearer turns every upstream response into a 401.
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

export const collectForwardProxyHeaders = (requestHeaders, authHeaders = {}) => {
  const headers = {};

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

/**
 * Removes browser request metadata from an outgoing proxy request.
 *
 * `http-proxy` copies the incoming request headers wholesale, so the catch-all
 * `/api` proxy needs this in its `proxyReq` hook. The fetch-based paths use
 * `collectForwardProxyHeaders`, which drops the same names.
 */
export const stripBrowserRequestMetadataHeaders = (request) => {
  for (const name of browserRequestMetadataHeaders) {
    request.removeHeader(name);
  }
};

export const shouldForwardProxyResponseHeader = (key) => {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return false;
  }

  return !filteredResponseHeaders.has(key.toLowerCase());
};

export const applyForwardProxyResponseHeaders = (responseHeaders, response) => {
  if (!responseHeaders || typeof response?.setHeader !== 'function') {
    return;
  }

  for (const [key, value] of responseHeaders.entries()) {
    if (!shouldForwardProxyResponseHeader(key)) {
      continue;
    }
    response.setHeader(key, value);
  }
};
