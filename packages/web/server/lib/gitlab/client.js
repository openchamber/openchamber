import { getGitLabAuth, getGitLabDefaultBaseUrl } from './auth.js';

// Per-request timeout for every GitLab call. GitLab REST can hang under load
// (especially self-hosted instances); bounding each request lets the caller
// fail fast and serve cached/last-known state instead of holding a socket open.
const REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url, options = {}) => {
  // Respect a caller-provided signal if present; otherwise attach our timeout.
  if (options.signal) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
};

// Conditional-request cache for GET calls: GitLab serves 304 Not Modified for
// matching If-None-Match without consuming a fresh rate-limit token, so
// polling unchanged issues/MRs stays cheap. Keyed by token+URL so different
// identities never share responses. GitLab (unlike GitHub) does not attach
// `ETag` to every endpoint, but when it does we revalidate exactly like
// github/octokit.js.
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

// ---- Own rate-limit cooldown (deliberately NOT shared with github/rate-limit.js) ----
const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
let rateLimitedUntil = 0;

const headerValue = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name];
};

/**
 * Record a cooldown after a GitLab 429. Accepts a fetch Response or any object
 * carrying headers (response, `retry-after` seconds, or `RateLimit-Reset`
 * Unix seconds).
 */
export function noteGitLabRateLimit(error) {
  const headers = error?.headers;
  let retryMs = null;
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) retryMs = secs * 1000;
  }
  if (retryMs === null) {
    const reset = headerValue(headers, 'ratelimit-reset');
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
    console.warn(`[gitlab] rate limited — pausing GitLab calls for ~${Math.round(retryMs / 1000)}s`);
  }
}

export function isGitLabRateLimited() {
  return Date.now() < rateLimitedUntil;
}

// ---- Response helpers ----

const joinApiUrl = (baseUrl, path) => {
  const base = String(baseUrl || getGitLabDefaultBaseUrl()).replace(/\/+$/, '');
  const p = typeof path === 'string' && path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `${base}/api/v4${p}`;
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
  const pageHeader = get('x-page');
  const nextPage = get('x-next-page');
  const totalPages = get('x-total-pages');
  const linkHeader = get('link');
  const relNextMatch = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
  const page = pageHeader ? Number(pageHeader) : null;
  const next = nextPage ? Number(nextPage) : null;
  const total = totalPages ? Number(totalPages) : null;
  const hasMore = next != null ? next > 0 : Boolean(relNextMatch);
  const parsed = { page, next, total, hasMore };
  if (relNextMatch) {
    parsed.nextUrl = relNextMatch[1];
  }
  return parsed;
};

const parseData = async (response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const encodeProject = (pathWithNamespace) => encodeURIComponent(String(pathWithNamespace));

/**
 * Create a raw-fetch GitLab REST v4 client. `request` never throws for HTTP
 * error statuses — it returns `{ status, headers, data, page }` so callers can
 * branch on status codes. On 429 it also sets `error: 'GitLab rate limited'`
 * and records a module-level cooldown.
 */
export function createGitLabClient({ token, baseUrl }) {
  const effectiveBaseUrl = normalizeBaseForClient(baseUrl);

  const request = async (path, options = {}) => {
    const method = (typeof options.method === 'string' ? options.method : 'GET').toUpperCase();
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const body = options.body;
    const callerSignal = options.signal;

    if (isGitLabRateLimited()) {
      return { status: 429, headers: {}, data: null, page: null, error: 'GitLab rate limited' };
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

    const headers = {
      'PRIVATE-TOKEN': token,
      accept: 'application/json',
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

    // Follow a project-move redirect exactly once. GitLab redirects
    // (301/302/308) come with a `Location` for the new project URL; a manual
    // redirect keeps our PRIVATE-TOKEN header across the hop.
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
      data: await parseData(response),
      page: parsePageInfo(response.headers),
    };

    if (response.status === 429) {
      noteGitLabRateLimit(response);
      result.error = 'GitLab rate limited';
    }

    return result;
  };

  return {
    request,
    baseUrl: effectiveBaseUrl,
    user: () => request('/user'),
    project: (pathWithNamespace) => request(`/projects/${encodeProject(pathWithNamespace)}`),
    issues: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues`, { query: params }),
    issue: (pathWithNamespace, iid) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}`),
    issueNotes: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}/notes`, { query: params }),
    createIssueNote: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}/notes`, { method: 'POST', body: { body } }),
    createIssue: (pathWithNamespace, params) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues`, { method: 'POST', body: params }),
    updateIssue: (pathWithNamespace, iid, params) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}`, { method: 'PUT', body: params }),
    mergeRequests: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests`, { query: params }),
    mergeRequest: (pathWithNamespace, iid) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}`),
    mergeRequestDiffs: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/diffs`, { query: params }),
    mergeRequestCommits: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/commits`, { query: params }),
    mergeRequestNotes: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/notes`, { query: params }),
    createMrNote: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/notes`, { method: 'POST', body: { body } }),
    approveMr: (pathWithNamespace, iid) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/approve`, { method: 'POST' }),
    milestones: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/milestones`, { query: params }),
    createMergeRequest: (pathWithNamespace, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests`, { method: 'POST', body }),
    updateMergeRequest: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}`, { method: 'PUT', body }),
    mergeMergeRequest: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/merge`, { method: 'PUT', body }),
    branches: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/repository/branches`, { query: params }),
    // Project members (direct + inherited) are the assignable/mentionable user
    // set. `members/all` includes inherited group members; `query` filters
    // server-side by username/name/email.
    members: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/members/all`, { query: params }),
    labels: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/labels`, { query: params }),
    tags: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/repository/tags`, { query: params }),
  };
}

function normalizeBaseForClient(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return getGitLabDefaultBaseUrl();
  }
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Picks the current account (from auth.js) token + base URL, or null. */
export function getGitLabClientOrNull() {
  const auth = getGitLabAuth();
  if (!auth?.accessToken) {
    return null;
  }
  return createGitLabClient({ token: auth.accessToken, baseUrl: auth.baseUrl });
}
