import crypto from 'node:crypto';
import { Octokit } from '@octokit/rest';
import {
  getGitHubAuth,
  getGitHubAuthByAccountId,
  isGhCliActive,
  isGhCliDisabled,
} from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';
import { isTrustedGitHubHost } from './host-trust.js';

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

/**
 * Create an Octokit instance with per-request timeout + ETag revalidation.
 *
 * `host` targets a specific GitHub Enterprise API root. github.com (or omitted)
 * keeps Octokit's default `api.github.com` base URL. The cache identity stays
 * keyed by credential digest only: the request URL inside the cache carries the
 * host, so one host's 304 replay can never serve another host's body.
 */
export function createOctokit(token, accountId = '', host = '') {
  const cacheIdentity = `github:${crypto.createHash('sha256')
    .update(accountId)
    .update('\0')
    .update(token)
    .digest('base64url')}`;
  const options = { auth: token, request: { fetch: createConditionalFetch(cacheIdentity) } };
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com') {
    options.baseUrl = `https://${normalizedHost}/api/v3`;
  }
  const octokit = new Octokit(options);
  Object.defineProperty(octokit, 'openChamberCacheIdentity', {
    value: cacheIdentity,
  });
  return octokit;
}

export function getOctokitCacheIdentity(octokit) {
  return octokit?.openChamberCacheIdentity || '';
}

/**
 * Pick the token for a host. github.com (or an omitted host) keeps the
 * existing gh-token/stored-token fallback. An enterprise host must NOT fall
 * back to the stored OAuth token: that token is always a github.com credential
 * (the device flow is hardcoded to github.com), so sending it to another
 * instance's API root 401s there and can leak the token to whatever host a
 * local remote names. Only the host-pinned gh token belongs on an enterprise
 * host, and it is taken without the github.com CLI switch: a stored gh login
 * for that host is itself the consent, matching getOctokitForAccountId.
 */
export function selectTokenForHost(host, { ghToken, storedToken, ghCliActive }) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost || normalizedHost === 'github.com') {
    return ghCliActive ? ghToken || storedToken : storedToken;
  }
  return ghToken;
}

export async function getOctokitOrNull(host) {
  // Never mint a token for a host the user never authenticated with: the only
  // credential for an enterprise host is gh's host-pinned token, and sending
  // it to an arbitrary remote host would leak it there. This gate runs before
  // ANY token lookup, so a direct caller with a client-supplied host cannot
  // bypass repo resolution. github.com (and an omitted host) is always fine.
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com' && !isTrustedGitHubHost(normalizedHost)) {
    return null;
  }
  const auth = await getGitHubAuth();
  // On github.com the gh CLI login is used only after the user switched to it
  // in Settings: its token carries every scope ever granted to gh, so it is
  // never picked up silently when OpenChamber has no account of its own. A
  // trusted enterprise host takes its host-pinned gh token without that
  // switch, matching getOctokitForAccountId and getOctokitForHost; a host gh
  // login is the consent. isGhCliDisabled() still applies to both.
  const enterpriseHost = Boolean(normalizedHost && normalizedHost !== 'github.com');
  const ghToken = !isGhCliDisabled() && (enterpriseHost || isGhCliActive()) ? getGhCliToken(host) : null;
  const token = selectTokenForHost(normalizedHost, {
    ghToken,
    storedToken: auth?.accessToken,
    ghCliActive: isGhCliActive(),
  });
  if (!token) {
    return null;
  }
  const accountId = token === auth?.accessToken ? auth.accountId : '';
  return createOctokit(token, accountId, normalizedHost);
}

/**
 * The gh CLI account as a credential record shaped like a persisted one, for
 * Git transport. Same consent rule as getOctokitForAccountId: a
 * `github.com#cli:` account resolves only while the user has switched to gh in
 * Settings, while a trusted enterprise host's `<host>#cli:` account uses that
 * host's host-pinned gh token without the switch. gh must still be signed in
 * as that same user. The CLI credential has no revisions beyond 1.
 */
export async function getGitHubCliCredential(accountId, revision) {
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId ?? '');
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !isTrustedGitHubHost(host)) return null;
  if (isGhCliDisabled()) return null;
  if (host === 'github.com' && !isGhCliActive()) return null;
  if (revision !== undefined && revision !== 1) return null;
  const token = getGhCliToken(host);
  if (!token) return null;
  let response;
  try {
    response = await createOctokit(token, accountId, host).rest.users.getAuthenticated();
  } catch (error) {
    if (error?.status === 401) return null;
    throw error;
  }
  if (`${host}#cli:${response.data.id}` !== accountId) return null;
  return {
    credentialId: accountId,
    accountId,
    credentialRevision: 1,
    providerUserId: `${host}#${response.data.id}`,
    accessToken: token,
    source: 'cli',
    status: 'valid',
    user: response.data,
  };
}

/**
 * The host-pinned gh-token Octokit for a GitHub Enterprise host, or null when
 * gh cannot supply a token for it. github.com is served by the account layer.
 * Only trusted hosts are accepted, so a client-supplied host can never pick
 * which token the server sends where.
 */
export async function getOctokitForHost(host, options = {}) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost || normalizedHost === 'github.com' || !isTrustedGitHubHost(normalizedHost)) {
    return null;
  }
  if (isGhCliDisabled()) return null;
  const token = getGhCliToken(normalizedHost);
  if (!token) return null;
  const octokit = createOctokit(token, '', normalizedHost);
  octokit.hook.error('request', async (error) => {
    const identity = { provider: 'github', instance: normalizedHost, accountId: null };
    error.sourceControlIdentity = identity;
    error.sourceControlPersistedAccount = false;
    if (error.status === 401) {
      await options.onUnauthorized?.(identity, false);
      error.sourceControlInvalidated = true;
    }
    throw error;
  });
  return octokit;
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
  // An exact CLI account id is not consent. On github.com the gh token is used
  // only while the user has switched to the gh account in Settings. An
  // enterprise host has no other credential: `<host>#cli:<id>` resolves through
  // the trust gate with the host-pinned gh token, no switch involved.
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId);
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !isTrustedGitHubHost(host)) return null;
  if (isGhCliDisabled()) return null;
  if (host === 'github.com' && !isGhCliActive()) return null;
  const token = getGhCliToken(host);
  if (!token) return null;
  const octokit = createOctokit(token, accountId, host);
  let response;
  try {
    response = await octokit.rest.users.getAuthenticated();
  } catch (error) {
    if (error?.status === 401) {
      const identity = { provider: 'github', instance: host, accountId };
      await options.onUnauthorized?.(identity, false);
      error.sourceControlIdentity = identity;
      error.sourceControlPersistedAccount = false;
      error.sourceControlInvalidated = true;
    }
    throw error;
  }
  if (`${host}#cli:${response.data.id}` !== accountId) {
    await options.onUnauthorized?.({ provider: 'github', instance: host, accountId }, false);
    return null;
  }
  octokit.hook.error('request', async (error) => {
    const identity = { provider: 'github', instance: host, accountId };
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
    providerUserId: `${host}#${response.data.id}`,
    source: 'cli',
    user: response.data,
    octokit,
  };
}
