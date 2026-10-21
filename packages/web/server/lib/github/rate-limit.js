// Lightweight, per-host GitHub rate-limit gate.
//
// Octokit is configured without the throttling plugin, so a primary or
// secondary rate limit surfaces as a thrown 403/429. Resolving PR status for
// many worktrees fans out dozens of calls; once GitHub starts limiting, every
// further call wastes a round-trip and the cache masks the failure. When we
// detect a rate-limit response we record a cooldown for that host and skip
// GitHub work on it until the window passes, so the burst stops and the reason
// is visible in the logs. Cooldowns are keyed per host: an enterprise instance
// exhausting its quota must not pause github.com polling (or vice versa).

const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

// hostKey -> timestamp until which that host stays on cooldown.
const rateLimitedUntilByHost = new Map();

// github.com and its REST root (api.github.com) are one host; every other
// instance keys by its own hostname.
export const hostKeyFor = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'github.com' || normalized === 'api.github.com') {
    return 'github.com';
  }
  return normalized;
};

// Octokit errors carry the request URL, so the host can be derived instead of
// threading it through every catch site. Unparseable or absent URLs fall back
// to github.com.
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
  // Octokit/fetch headers can be a plain object or a Headers instance.
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

/** True when an Octokit error represents a primary or secondary rate limit. */
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

/**
 * Record a cooldown after a detected rate-limit response.
 *
 * `host` pins the cooldown to one instance; when omitted it is derived from
 * the error's request URL.
 */
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

/**
 * Convenience: note the error if it is a rate-limit error. Returns whether it
 * was. `host` optionally pins the cooldown to a specific instance.
 */
export const noteIfGitHubRateLimit = (error, host) => {
  if (!isGitHubRateLimitError(error)) return false;
  noteGitHubRateLimit(error, host);
  return true;
};

/** True when `host` (default github.com) is currently on cooldown. */
export const isGitHubRateLimited = (host) => {
  const until = rateLimitedUntilByHost.get(hostKeyFor(host ?? 'github.com')) ?? 0;
  return Date.now() < until;
};
