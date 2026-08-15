import { getGiteaAuth } from './auth.js';
import { getProviderApiBaseUrl } from '../git-providers/config.js';
import { getEffectiveProviderApiBaseUrl } from '../git-providers/project-config.js';

// Per-request timeout for every Gitea call. Self-hosted instances can hang
// under load; bounding each request lets the caller fail fast and serve
// cached/last-known state instead of holding a socket open.
const REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url, options = {}) => {
  // Respect a caller-provided signal if present; otherwise attach our timeout.
  if (options.signal) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
};

// Conditional-request cache for GET calls: Gitea serves 304 Not Modified for
// matching If-None-Match, so polling unchanged issues/PRs stays cheap. Keyed by
// token+URL so different identities never share responses.
const ETAG_CACHE_MAX_ENTRIES = 300;
const etagCache = new Map();

const rememberEtag = (key, etag, body, headers) => {
  etagCache.delete(key);
  etagCache.set(key, { etag, body, headers });
  if (etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) {
      etagCache.delete(oldest);
    }
  }
};

const createConditionalFetch = (token) => async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options);
  }

  const cacheKey = `${token}\n${url}`;
  const cached = etagCache.get(cacheKey);
  const headers = { ...(options.headers || {}) };
  if (cached?.etag) {
    headers['if-none-match'] = cached.etag;
  }

  const response = await timeoutFetch(url, { ...options, headers });

  if (response.status === 304 && cached) {
    // Touch for LRU and replay the cached success response.
    rememberEtag(cacheKey, cached.etag, cached.body, cached.headers);
    return new Response(cached.body, { status: 200, headers: cached.headers });
  }

  if (response.ok) {
    const etag = response.headers.get('etag');
    if (etag) {
      const body = await response.arrayBuffer();
      rememberEtag(cacheKey, etag, body, response.headers);
      return new Response(body, { status: response.status, headers: response.headers });
    }
  }

  return response;
};

// ---- Own rate-limit cooldown (deliberately NOT shared with github/gitlab) ----
const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
let rateLimitedUntil = 0;

const headerValue = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name];
};

/**
 * Record a cooldown after a Gitea 429. Accepts a fetch Response or any object
 * carrying headers, honoring `Retry-After` (seconds) or `X-RateLimit-Reset`
 * (Unix seconds) when present.
 */
export function noteGiteaRateLimit(error) {
  const headers = error?.headers;
  let retryMs = null;
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) retryMs = secs * 1000;
  }
  if (retryMs === null) {
    // Gitea sends `X-RateLimit-Reset`; check the generic name too for robustness.
    const reset = headerValue(headers, 'x-ratelimit-reset') ?? headerValue(headers, 'ratelimit-reset');
    if (reset !== undefined && reset !== null) {
      const delta = Number(reset) * 1000 - Date.now();
      if (Number.isFinite(delta) && delta > 0) retryMs = delta;
    }
  }
  if (retryMs === null) retryMs = DEFAULT_COOLDOWN_MS;
  retryMs = Math.min(retryMs, MAX_COOLDOWN_MS);
  const until = Date.now() + retryMs;
  if (until > rateLimitedUntil) {
    rateLimitedUntil = until;
    console.warn(`[gitea] rate limited — pausing Gitea calls for ~${Math.round(retryMs / 1000)}s`);
  }
}

export function isGiteaRateLimited() {
  return Date.now() < rateLimitedUntil;
}

// ---- Response helpers ----

const joinApiUrl = (baseUrl, path) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const p = typeof path === 'string' && path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `${base}/api/v1${p}`;
};

const headersToObject = (headers) => {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } else if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      out[key] = value;
    }
  }
  return out;
};

const parsePageInfo = (headers) => {
  const get = (name) => {
    const value = headerValue(headers, name);
    return typeof value === 'string' ? value : '';
  };
  // Gitea paginates list endpoints via the `Link` header (rel="next") and
  // reports the total via `X-Total-Count`.
  const linkHeader = get('link');
  const relNextMatch = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
  const totalRaw = get('x-total-count');
  const total = totalRaw ? Number(totalRaw) : null;
  const parsed = {
    page: null,
    next: null,
    total: total !== null && Number.isFinite(total) ? total : null,
    hasMore: Boolean(relNextMatch),
  };
  if (relNextMatch) {
    parsed.nextUrl = relNextMatch[1];
  }
  return parsed;
};

const parseData = async (response, raw) => {
  const text = await response.text();
  if (raw) {
    return text;
  }
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Create a raw-fetch Gitea/Forgejo REST v1 client. `request` never throws for
 * HTTP error statuses — it returns `{ status, headers, data, page }` so callers
 * can branch on status codes. On 429 it also sets `error: 'Gitea rate limited'`
 * and records a module-level cooldown.
 */
export function createGiteaClient({ token, baseUrl }) {
  const effectiveBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';

  const request = async (path, options = {}) => {
    const method = (typeof options.method === 'string' ? options.method : 'GET').toUpperCase();
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const body = options.body;
    const callerSignal = options.signal;
    const raw = options.raw === true;

    if (isGiteaRateLimited()) {
      return { status: 429, headers: {}, data: null, page: null, error: 'Gitea rate limited' };
    }

    let url = joinApiUrl(effectiveBaseUrl, path);
    const qs = new URLSearchParams();
    let hasQuery = false;
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      qs.set(key, String(value));
      hasQuery = true;
    }
    if (hasQuery) {
      url += `${url.includes('?') ? '&' : '?'}${qs.toString()}`;
    }

    // Gitea/Forgejo PAT auth: `Authorization: token <pat>`.
    const headers = {
      Authorization: `token ${token}`,
      accept: raw ? 'text/plain' : 'application/json',
    };
    const fetchOptions = {
      method,
      headers,
      redirect: 'manual',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }
    if (callerSignal) {
      fetchOptions.signal = callerSignal;
    }

    const conditionalFetch = createConditionalFetch(token);

    let response = await conditionalFetch(url, fetchOptions);

    // Follow redirects (301/302/308) exactly once. Gitea serves them for moved
    // repos/users; a manual redirect keeps our Authorization header across the hop.
    let redirects = 0;
    while (
      (response.status === 301 || response.status === 302 || response.status === 308)
      && headerValue(response.headers, 'location')
      && redirects < 1
    ) {
      const location = headerValue(response.headers, 'location');
      const nextUrl = new URL(location, url).toString();
      response = await conditionalFetch(nextUrl, fetchOptions);
      redirects += 1;
    }

    const result = {
      status: response.status,
      headers: headersToObject(response.headers),
      data: await parseData(response, raw),
      page: parsePageInfo(response.headers),
    };

    if (response.status === 429) {
      noteGiteaRateLimit(response);
      result.error = 'Gitea rate limited';
    }

    return result;
  };

  return {
    request,
    baseUrl: effectiveBaseUrl,
    user: () => request('/user'),
    repo: (owner, repo) => request(`/repos/${owner}/${repo}`),
    issues: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/issues`, { query: params }),
    issue: (owner, repo, number) =>
      request(`/repos/${owner}/${repo}/issues/${number}`),
    issueComments: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/issues/${number}/comments`, { query: params }),
    createIssueComment: (owner, repo, number, body) =>
      request(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }),
    createIssue: (owner, repo, params) =>
      request(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: params }),
    updateIssue: (owner, repo, number, params) =>
      request(`/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body: params }),
    milestones: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/milestones`, { query: params }),
    repoLabels: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/labels`, { query: params }),
    pullRequests: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls`, { query: params }),
    pullRequest: (owner, repo, number) =>
      request(`/repos/${owner}/${repo}/pulls/${number}`),
    pullRequestDiff: (owner, repo, number) =>
      request(`/repos/${owner}/${repo}/pulls/${number}.diff`, { raw: true }),
    pullRequestFiles: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/files`, { query: params }),
    pullRequestCommits: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/commits`, { query: params }),
    pullRequestReviews: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { query: params }),
    createPullReview: (owner, repo, number, params) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { method: 'POST', body: params }),
    commitStatuses: (owner, repo, sha, params = {}) =>
      request(`/repos/${owner}/${repo}/commits/${sha}/statuses`, { query: params }),
    createPullRequest: (owner, repo, body) =>
      request(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body }),
    updatePullRequest: (owner, repo, number, body) =>
      request(`/repos/${owner}/${repo}/pulls/${number}`, { method: 'PATCH', body }),
    mergePullRequest: (owner, repo, number, body) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/merge`, { method: 'POST', body }),
    branches: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/branches`, { query: params }),
    // Assignable users (collaborators with role access + org members) are the
    // mention/assign candidate set; Gitea mirrors the GitHub assignees route.
    assignees: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/assignees`, { query: params }),
    tags: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/tags`, { query: params }),
  };
}

/** Picks the current account (from auth.js) token + base URL, or null. A per-project override replaces the account's base URL for that project. */
export function getGiteaClientOrNull(directory) {
  const auth = getGiteaAuth();
  if (!auth?.accessToken || !auth?.baseUrl) {
    return null;
  }
  let baseUrl = auth.baseUrl;
  if (directory) {
    const effectiveBaseUrl = getEffectiveProviderApiBaseUrl('gitea', directory);
    // Only a per-project override replaces the account's base URL; without one
    // the effective value is just the global default, which stored accounts
    // (an explicit baseUrl is required) already outrank.
    if (effectiveBaseUrl !== null && effectiveBaseUrl !== getProviderApiBaseUrl('gitea')) {
      baseUrl = effectiveBaseUrl;
    }
  }
  return createGiteaClient({ token: auth.accessToken, baseUrl });
}
