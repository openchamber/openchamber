import { Octokit } from '@octokit/rest';
import { getGitHubAuth, isGhCliActive, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';

// Per-request timeout for every GitHub call. Octokit v22 uses native fetch,
// which has no built-in timeout — without this, a stuck connection hangs until
// some outer bound (the PR-status route's 12s overall budget) fires, and a
// single slow request can eat the whole budget. Bounding each request lets the
// caller fail fast and fall back to cached state instead.
const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url, options = {}) => {
  // Respect a caller-provided signal if present; otherwise attach our timeout.
  if (options.signal) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
};

// Conditional-request cache for GET calls: GitHub serves 304 Not Modified for
// matching If-None-Match WITHOUT counting the request against the REST rate
// limit, so polling unchanged PRs/checks becomes rate-limit-free. Keyed by
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

/**
 * Create an Octokit instance with per-request timeout + ETag revalidation.
 *
 * `host` targets a specific GitHub Enterprise API root. github.com (or omitted)
 * keeps Octokit's default `api.github.com` base URL.
 */
export function createOctokit(token, host) {
  const options = { auth: token, request: { fetch: createConditionalFetch(token) } };
  if (host && host !== 'github.com') {
    options.baseUrl = `https://${host}/api/v3`;
  }
  return new Octokit(options);
}

/**
 * Pick the token for a host. github.com (or an omitted host) keeps the
 * existing gh-token/stored-token fallback. An enterprise host must NOT fall
 * back to the stored OAuth token: that token is always a github.com credential
 * (the device flow is hardcoded to github.com), so sending it to another
 * instance's API root 401s there and can leak the token to whatever host a
 * local remote names. Only the host-pinned gh token belongs on an enterprise
 * host.
 */
export function selectTokenForHost(host, { ghToken, storedToken, ghCliActive }) {
  if (!host || host === 'github.com') {
    return ghCliActive ? ghToken || storedToken : storedToken || ghToken;
  }
  return ghToken;
}

export function getOctokitOrNull(host) {
  const storedToken = getGitHubAuth()?.accessToken;
  const ghToken = !isGhCliDisabled() ? getGhCliToken(host) : null;
  const token = selectTokenForHost(host, {
    ghToken,
    storedToken,
    ghCliActive: isGhCliActive(),
  });
  if (!token) {
    return null;
  }
  return createOctokit(token, host);
}
