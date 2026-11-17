const filteredRequestHeaders = new Set([
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

  const groupedHeaders = new Map();

  for (const [key, value] of responseHeaders.entries()) {
    if (!shouldForwardProxyResponseHeader(key)) {
      continue;
    }

    const normalizedKey = key.toLowerCase();
    const header = groupedHeaders.get(normalizedKey);
    if (header) {
      header.values.push(value);
    } else {
      groupedHeaders.set(normalizedKey, { key, values: [value] });
    }
  }

  const setCookies = responseHeaders.getSetCookie?.();
  if (setCookies?.length > 0) {
    groupedHeaders.set('set-cookie', { key: 'set-cookie', values: setCookies });
  }

  for (const { key, values } of groupedHeaders.values()) {
    response.setHeader(key, values.length === 1 ? values[0] : values);
  }
};
