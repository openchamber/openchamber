import crypto from 'node:crypto';
import { Octokit } from '@octokit/rest';
import {
  getGitHubAuth,
  getGitHubAuthByAccountId,
  githubAccountId,
  githubCliAccountId,
  isGhCliActive,
  isGhCliDisabled,
} from './auth.js';
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
// limit, so polling unchanged PRs/checks becomes rate-limit-free. Keyed by a
// credential digest plus URL so raw tokens do not become cache keys.
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

const createConditionalFetch = (cacheIdentity) => async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options);
  }

  const cacheKey = `${cacheIdentity}\n${url}`;
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

/** Create an Octokit instance with per-request timeout + ETag revalidation. */
export function createOctokit(token, accountId = '') {
  const cacheIdentity = `github:${crypto.createHash('sha256')
    .update(accountId)
    .update('\0')
    .update(token)
    .digest('base64url')}`;
  const octokit = new Octokit({ auth: token, request: { fetch: createConditionalFetch(cacheIdentity) } });
  Object.defineProperty(octokit, 'openChamberCacheIdentity', {
    value: cacheIdentity,
  });
  return octokit;
}

export function getOctokitCacheIdentity(octokit) {
  return octokit?.openChamberCacheIdentity || '';
}

export async function getOctokitOrNull() {
  const auth = await getGitHubAuth();
  const ghToken = !isGhCliDisabled() ? getGhCliToken() : null;
  const token = isGhCliActive() ? ghToken || auth?.accessToken : auth?.accessToken || ghToken;
  if (!token) {
    return null;
  }
  const accountId = token === auth?.accessToken ? auth.accountId : '';
  return createOctokit(token, accountId);
}

export async function getOctokitForAccountId(accountId, options = {}) {
  const auth = await getGitHubAuthByAccountId(accountId);
  if (auth) {
    const octokit = createOctokit(auth.accessToken, accountId);
    octokit.hook.error('request', async (error) => {
      const identity = { provider: 'github', instance: 'github.com', accountId };
      error.sourceControlIdentity = identity;
      error.sourceControlPersistedAccount = true;
      if (error.status === 401) {
        await options.onUnauthorized?.(identity, true);
        error.sourceControlInvalidated = true;
      }
      throw error;
    });
    return {
      accountId,
      credentialRevision: auth.credentialRevision,
      providerUserId: auth.providerUserId,
      source: auth.source,
      user: auth.user,
      octokit,
    };
  }
  if (!accountId.startsWith('github.com#cli:') || isGhCliDisabled()) return null;
  const token = getGhCliToken();
  if (!token) return null;
  const octokit = createOctokit(token, accountId);
  let response;
  try {
    response = await octokit.rest.users.getAuthenticated();
  } catch (error) {
    if (error?.status === 401) {
      const identity = { provider: 'github', instance: 'github.com', accountId };
      await options.onUnauthorized?.(identity, false);
      error.sourceControlIdentity = identity;
      error.sourceControlPersistedAccount = false;
      error.sourceControlInvalidated = true;
    }
    throw error;
  }
  if (githubCliAccountId(response.data.id) !== accountId) {
    await options.onUnauthorized?.({ provider: 'github', instance: 'github.com', accountId }, false);
    return null;
  }
  octokit.hook.error('request', async (error) => {
    const identity = { provider: 'github', instance: 'github.com', accountId };
    error.sourceControlIdentity = identity;
    error.sourceControlPersistedAccount = false;
    if (error.status === 401) {
      await options.onUnauthorized?.(identity, false);
      error.sourceControlInvalidated = true;
    }
    throw error;
  });
  return {
    accountId,
    credentialRevision: 1,
    providerUserId: githubAccountId(response.data.id),
    source: 'cli',
    user: response.data,
    octokit,
  };
}
