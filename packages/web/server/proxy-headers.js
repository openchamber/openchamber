const filteredRequestHeaders = new Set([
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

  for (const [key, value] of responseHeaders.entries()) {
    if (!shouldForwardProxyResponseHeader(key)) {
      continue;
    }
    response.setHeader(key, value);
  }
};
