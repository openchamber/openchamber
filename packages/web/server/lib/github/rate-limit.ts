import type { GitHubEnvelope } from './contracts.js';
import { gitHubInstanceOfApiHost } from './api-host.js';

interface RateLimitFields {
  request?: unknown;
  response?: unknown;
  headers?: unknown;
  status?: unknown;
  message?: unknown;
  url?: unknown;
  get?: unknown;
  'retry-after'?: unknown;
  'x-ratelimit-reset'?: unknown;
  'x-ratelimit-remaining'?: unknown;
}
const hasAccessibleFields = (value: unknown): value is RateLimitFields => value != null;
const field = (value: GitHubEnvelope['data'], key: keyof RateLimitFields) => hasAccessibleFields(value) ? value[key] : undefined;
const hasHeaderGetter = (value: unknown): value is { get(name: string): GitHubEnvelope['data'] } =>
  typeof field(value, 'get') === 'function';

const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

const rateLimitedUntilByHost = new Map<string, number>();

const hostKeyFor = (value: string | null | undefined) => gitHubInstanceOfApiHost(value) || 'github.com';

export const hostFromError = (error: GitHubEnvelope['data']) => {
  const url = field(field(error, 'request'), 'url') ?? field(field(error, 'response'), 'url');
  if (!url) {
    return 'github.com';
  }
  try {
    return hostKeyFor(new URL(String(url)).hostname);
  } catch {
    return 'github.com';
  }
};

const headerValue = (headers: GitHubEnvelope['data'], name: 'retry-after' | 'x-ratelimit-reset' | 'x-ratelimit-remaining') => {
  if (!headers) return undefined;
  if (hasHeaderGetter(headers)) return headers.get(name);
  return field(headers, name);
};

const parseRetryAfterMs = (error: GitHubEnvelope['data']) => {
  const headers = field(field(error, 'response'), 'headers');
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

export const isGitHubRateLimitError = (error: GitHubEnvelope['data']) => {
  const status = field(error, 'status') ?? field(field(error, 'response'), 'status');
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = headerValue(field(field(error, 'response'), 'headers'), 'x-ratelimit-remaining');
  if (remaining === '0' || remaining === 0) return true;
  if (headerValue(field(field(error, 'response'), 'headers'), 'retry-after') != null) return true;
  const message = String(field(error, 'message') ?? '').toLowerCase();
  return message.includes('rate limit');
};

export const noteGitHubRateLimit = (error: GitHubEnvelope['data'], host?: string | null) => {
  const retryMs = Math.min(parseRetryAfterMs(error) ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  const until = Date.now() + retryMs;
  const hostKey = hostKeyFor(host ?? hostFromError(error));
  const current = rateLimitedUntilByHost.get(hostKey) ?? 0;
  if (until > current) {
    rateLimitedUntilByHost.set(hostKey, until);
    console.warn(`[github] rate limited on ${hostKey} — pausing GitHub PR status calls for ~${Math.round(retryMs / 1000)}s`);
  }
};

export const noteIfGitHubRateLimit = (error: GitHubEnvelope['data'], host?: string | null) => {
  if (!isGitHubRateLimitError(error)) return false;
  noteGitHubRateLimit(error, host);
  return true;
};

export const isGitHubRateLimited = (host?: string | null) => {
  const until = rateLimitedUntilByHost.get(hostKeyFor(host ?? 'github.com')) ?? 0;
  return Date.now() < until;
};
