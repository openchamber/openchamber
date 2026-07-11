// Lightweight, process-global GitHub rate-limit gate.
//
// Octokit is configured without the throttling plugin, so a primary or
// secondary rate limit surfaces as a thrown 403/429. Resolving PR status for
// many worktrees fans out dozens of calls; once GitHub starts limiting, every
// further call wastes a round-trip and the cache masks the failure. When we
// detect a rate-limit response we record a cooldown and skip GitHub work until
// it passes, so the burst stops and the reason is visible in the logs.

const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

let rateLimitedUntil = 0;

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

/** Record a cooldown after a detected rate-limit response. */
export const noteGitHubRateLimit = (error) => {
  const retryMs = Math.min(parseRetryAfterMs(error) ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  const until = Date.now() + retryMs;
  if (until > rateLimitedUntil) {
    rateLimitedUntil = until;
    console.warn(`[github] rate limited — pausing GitHub PR status calls for ~${Math.round(retryMs / 1000)}s`);
  }
};

/** Convenience: note the error if it is a rate-limit error. Returns whether it was. */
export const noteIfGitHubRateLimit = (error) => {
  if (!isGitHubRateLimitError(error)) return false;
  noteGitHubRateLimit(error);
  return true;
};

export const isGitHubRateLimited = () => Date.now() < rateLimitedUntil;
