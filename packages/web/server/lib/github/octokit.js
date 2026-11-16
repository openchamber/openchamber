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
import { findGhCliLogin, getGhCliLoginToken } from './gh-cli-logins.js';
import { isTrustedGitHubHostOrStored } from './host-trust.js';

const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url, options = {}, host = '') => {
  if (options.signal) {
    if (host && host !== 'github.com') return fetch(url, { ...options, redirect: 'error' });
    return fetch(url, options);
  }
  if (host && host !== 'github.com') {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
};

// external: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate Authenticated conditional requests returning 304 consume no primary REST quota.
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
  octokit.hook.error('request', (error) => {
    if (error?.status === 401) forgetGhCliToken(normalizedHost, token);
    throw error;
  });
  Object.defineProperty(octokit, 'openChamberCacheIdentity', {
    value: cacheIdentity,
  });
  Object.defineProperty(octokit, 'openChamberHost', {
    value: normalizedHost || 'github.com',
  });
  return octokit;
}

export function getOctokitCacheIdentity(octokit) {
  return octokit?.openChamberCacheIdentity || '';
}

export function selectTokenForHost(host, { ghToken, storedToken, ghCliActive }) {
  return ghCliActive ? ghToken || storedToken : storedToken;
}

async function resolveHostCredential(host) {
  const stored = await getGitHubAuth(host);
  const ghCliActive = await isGhCliActiveForHost(host);
  const ghCliLogin = ghCliActive ? await getGhCliLoginForHost(host) : null;
  const ghToken = ghCliActive && !(await isGhCliDisabledForHost(host))
    ? await getGhCliToken(host, ghCliLogin)
    : null;
  return { stored, ghCliActive, ghCliLogin, ghToken };
}

export async function getOctokitOrNull(host) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com' && !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
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
  const token = await getGhCliLoginToken(host, login);
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
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId);
  if (!cliMatch) return null;
  const host = cliMatch[1].toLowerCase();
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (!(await isGhCliActiveForHost(host)) || (await isGhCliDisabledForHost(host))) return null;
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  const token = login ? await getGhCliLoginToken(host, login) : null;
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
