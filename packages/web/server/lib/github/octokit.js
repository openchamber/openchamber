import crypto from 'node:crypto';
import { Octokit } from '@octokit/rest';
import {
  getGitHubAuth,
  getGitHubAuthByAccountId,
  getGhCliLoginForHost,
  isGhCliActiveForHost,
  isGhCliDisabledForHost,
} from './auth.js';
import { forgetGhCliToken, getGhCliToken } from './gh-cli-credential.js';
import { findGhCliLogin } from './gh-cli-logins.js';
import { isTrustedGitHubHostOrStored } from './host-trust.js';

// Per-request timeout for every GitHub call. Octokit v22 uses native fetch,
// which has no built-in timeout — without this, a stuck connection hangs until
// some outer bound (the PR-status route's 12s overall budget) fires, and a
// single slow request can eat the whole budget. Bounding each request lets the
// caller fail fast and fall back to cached state instead.
const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url, options = {}, host = '') => {
  // Refuse redirects for a named enterprise host: the credential goes to the
  // instance only, so a redirect never carries it to another origin (the same
  // rule as GitLab's client). github.com keeps the previous default and follows
  // redirects, exactly as before this change.
  if (options.signal) {
    if (host && host !== 'github.com') return fetch(url, { ...options, redirect: 'error' });
    return fetch(url, options);
  }
  if (host && host !== 'github.com') {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
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

const createConditionalFetch = (cacheIdentity, host = '') => async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options, host);
  }

  const cacheKey = `${cacheIdentity}\n${url}`;
  const cached = etagCache.get(cacheKey);
  const headers = { ...(options.headers || {}) };
  if (cached?.etag) {
    headers['if-none-match'] = cached.etag;
  }

  const response = await timeoutFetch(url, { ...options, headers }, host);

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
 * uses Octokit's default `api.github.com` base URL. The cache identity is the
 * credential digest only: the request URL inside the cache carries the host, so
 * one host's 304 replay can never serve another host's body.
 */
export function createOctokit(token, accountId = '', host = '') {
  const cacheIdentity = `github:${crypto.createHash('sha256')
    .update(accountId)
    .update('\0')
    .update(token)
    .digest('base64url')}`;
  const options = { auth: token, request: { fetch: createConditionalFetch(cacheIdentity, host) } };
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com') {
    options.baseUrl = `https://${normalizedHost}/api/v3`;
  }
  const octokit = new Octokit(options);
  // A refused token that came from gh is asked from gh again next time.
  octokit.hook.error('request', (error) => {
    if (error?.status === 401) forgetGhCliToken(normalizedHost, token);
    throw error;
  });
  Object.defineProperty(octokit, 'openChamberCacheIdentity', {
    value: cacheIdentity,
  });
  // The host it talks to, for checks of what it answers (routes.js).
  Object.defineProperty(octokit, 'openChamberHost', {
    value: normalizedHost || 'github.com',
  });
  return octokit;
}

export function getOctokitCacheIdentity(octokit) {
  return octokit?.openChamberCacheIdentity || '';
}

/**
 * Pick the token for a host. The stored credential — github.com's OAuth token on
 * github.com, a stored per-host personal access token on a trusted enterprise
 * host — is the preference. The gh token is used only while that instance's CLI
 * is explicitly active: the github.com Settings switch on github.com, the
 * instance's own activation on an enterprise host. The stored github.com OAuth
 * token is always a github.com credential (the device flow is hardcoded to
 * github.com) — the caller scopes which stored token belongs to which host, so
 * that token never becomes a candidate for another instance's API root.
 */
export function selectTokenForHost(host, { ghToken, storedToken, ghCliActive }) {
  return ghCliActive ? ghToken || storedToken : storedToken;
}

/**
 * The one source of the credential decision for a host. The stored per-host
 * credential is the preference; the host's gh token is used only while that
 * instance's gh login is active (the same rule as GitLab). Every entry point
 * that answers "what credential does this host use" asks this, so the policy
 * cannot drift between callers.
 */
async function resolveHostCredential(host) {
  const stored = await getGitHubAuth(host);
  const ghCliActive = await isGhCliActiveForHost(host);
  // The login the instance's switch is on for. Null keeps gh's own active
  // login, which is what earlier releases always used.
  const ghCliLogin = ghCliActive ? await getGhCliLoginForHost(host) : null;
  const ghToken = ghCliActive && !(await isGhCliDisabledForHost(host))
    ? await getGhCliToken(host, ghCliLogin)
    : null;
  return { stored, ghCliActive, ghCliLogin, ghToken };
}

export async function getOctokitOrNull(host) {
  // Never mint a token for a host the user never authenticated with: sending a
  // github.com credential to an arbitrary remote host would leak it there. This
  // gate runs before ANY token lookup, so a direct caller with a client-supplied
  // host cannot bypass repo resolution. github.com (and an omitted host) is
  // always fine.
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com' && !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  // The stored credential is per host: github.com's active OAuth token, or the
  // active per-host token of a trusted enterprise host. resolveHostCredential
  // decides which token the host uses (stored, or gh while its CLI is active).
  const { stored, ghCliActive, ghToken } = await resolveHostCredential(normalizedHost);
  const token = selectTokenForHost(normalizedHost, {
    ghToken,
    storedToken: stored?.accessToken,
    ghCliActive,
  });
  if (!token) {
    return null;
  }
  const accountId = token === stored?.accessToken ? stored.accountId : '';
  return createOctokit(token, accountId, normalizedHost);
}

/**
 * The gh CLI account as a credential record shaped like a persisted one, for
 * Git transport. Same consent rule as getOctokitForAccountId: a
 * `github.com#cli:` account resolves only while the user has switched to gh in
 * Settings, while a trusted enterprise host's `<host>#cli:` account uses that
 * host's gh login only after the instance itself was activated. The id names the
 * exact login, so a host with several gh accounts hands out the one asked for;
 * gh must still hold that account's token. The CLI credential has no revisions
 * beyond 1.
 */
export async function getGitHubCliCredential(accountId, revision) {
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId ?? '');
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (await isGhCliDisabledForHost(host)) return null;
  if (!(await isGhCliActiveForHost(host))) return null;
  if (revision !== undefined && revision !== 1) return null;
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  if (!login) return null;
  const token = await getGhCliToken(host, login.login);
  if (!token) return null;
  return {
    credentialId: accountId,
    accountId,
    credentialRevision: 1,
    providerUserId: `${host}#${login.id}`,
    accessToken: token,
    source: 'cli',
    status: 'valid',
    user: login.profile,
  };
}

/**
 * The host-pinned Octokit for a GitHub Enterprise host, or null when the host is
 * untrusted or has neither a stored credential nor an activated gh login. The
 * stored per-host credential is the preference, and the host's gh token is used
 * only while the instance's gh login is active, like GitLab and
 * getOctokitForAccountId. github.com is served by the account layer.
 */
export async function getOctokitForHost(host, options = {}) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost || normalizedHost === 'github.com' || !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  const { stored, ghCliActive, ghToken } = await resolveHostCredential(normalizedHost);
  if (ghCliActive && ghToken) {
    const octokit = createOctokit(ghToken, '', normalizedHost);
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
  if (!stored) return null;
  const octokit = createOctokit(stored.accessToken, stored.accountId, normalizedHost);
  octokit.hook.error('request', async (error) => {
    const identity = { provider: 'github', instance: normalizedHost, accountId: stored.accountId };
    error.sourceControlIdentity = identity;
    error.sourceControlPersistedAccount = true;
    if (error.status === 401) {
      await options.onUnauthorized?.(identity, true);
      error.sourceControlInvalidated = true;
    }
    throw error;
  });
  return octokit;
}

export async function getOctokitForAccountId(accountId, options = {}) {
  const auth = await getGitHubAuthByAccountId(accountId);
  if (auth) {
    const host = auth.host;
    const octokit = createOctokit(auth.accessToken, accountId, host);
    octokit.hook.error('request', async (error) => {
      const identity = { provider: 'github', instance: host, accountId };
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
  // An exact CLI account id is not consent on its own: a `<host>#cli:<id>` id
  // uses that host's gh token only while the instance's gh login is active and
  // gh holds a login whose account is that id. Otherwise it resolves to nothing,
  // never to another account stored for the host, which may be a different
  // person (as on GitLab). An untrusted host never resolves at all.
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId);
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (!(await isGhCliActiveForHost(host)) || (await isGhCliDisabledForHost(host))) return null;
  // The login this id names, which is not necessarily the host's active gh
  // account: each gh account is a credential of its own. A token GitHub refuses
  // is reported on the first request through the returned client, below.
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  const token = login ? await getGhCliToken(host, login.login) : null;
  if (!login || !token) return null;
  const octokit = createOctokit(token, accountId, host);
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
    providerUserId: `${host}#${login.id}`,
    source: 'cli',
    user: login.profile,
    octokit,
  };
}
