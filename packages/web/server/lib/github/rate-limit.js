
const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

const rateLimitedUntilByHost = new Map();

const hostKeyFor = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'github.com' || normalized === 'api.github.com') {
    return 'github.com';
  }
  return normalized;
};

export const hostFromError = (error) => {
  const url = error?.request?.url ?? error?.response?.url;
  if (!url) {
    return 'github.com';
  }
  try {
    return hostKeyFor(new URL(String(url)).hostname);
  } catch {
    return 'github.com';
  }
};

const headerValue = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name];
};

const parseRetryAfterMs = (error) => {
  const headers = error?.response?.headers;
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  const reset = headerValue(headers, 'x-ratelimit-reset');
  if (reset !== undefined && reset !== null) {
    const delta = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(delta) && delta > 0) return delta;
  }
  return null;
};

export const isGitHubRateLimitError = (error) => {
  const status = error?.status ?? error?.response?.status;
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = headerValue(error?.response?.headers, 'x-ratelimit-remaining');
  if (remaining === '0' || remaining === 0) return true;
  if (headerValue(error?.response?.headers, 'retry-after') != null) return true;
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('rate limit');
};

export const noteGitHubRateLimit = (error, host) => {
  const retryMs = Math.min(parseRetryAfterMs(error) ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  const until = Date.now() + retryMs;
  const hostKey = hostKeyFor(host ?? hostFromError(error));
  const current = rateLimitedUntilByHost.get(hostKey) ?? 0;
  if (until > current) {
    rateLimitedUntilByHost.set(hostKey, until);
    console.warn(`[github] rate limited on ${hostKey} — pausing GitHub PR status calls for ~${Math.round(retryMs / 1000)}s`);
  }
};

export const noteIfGitHubRateLimit = (error, host) => {
  if (!isGitHubRateLimitError(error)) return false;
  noteGitHubRateLimit(error, host);
  return true;
};

export const isGitHubRateLimited = (host) => {
  const until = rateLimitedUntilByHost.get(hostKeyFor(host ?? 'github.com')) ?? 0;
  return Date.now() < until;
};
