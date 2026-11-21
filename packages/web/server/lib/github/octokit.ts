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
import { hasProperty } from './contracts.js';
import { isString } from '../shared/guards.js';
import type { AuthJson } from '../source-control/auth-storage.js';

interface EtagEntry {
  etag: string;
  body: ArrayBuffer;
  headers: Headers;
}

export interface SourceControlIdentity {
  provider: string;
  instance: string;
  accountId: string | null | undefined;
}

interface AccountOptions {
  onUnauthorized?: (identity: SourceControlIdentity, persisted: boolean) => void | Promise<void>;
}

type IdentifiedOctokit = Octokit & { openChamberCacheIdentity?: string; openChamberHost?: string };
interface ConditionalHeaders {
  [name: string]: string;
}
type RequestOptions = RequestInit & { headers?: ConditionalHeaders };

const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

const timeoutFetch = (url: string | URL | Request, options: RequestInit = {}, host = '') => {
  if (options.signal) {
    if (host && host !== 'github.com') return fetch(url, { ...options, redirect: 'error' });
    return fetch(url, options);
  }
  if (host && host !== 'github.com') {
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
};

const ETAG_CACHE_MAX_ENTRIES = 300;
const etagCache = new Map<string, EtagEntry>();

const rememberEtag = (key: string, etag: string, body: ArrayBuffer, headers: Headers) => {
  etagCache.delete(key);
  etagCache.set(key, { etag, body, headers });
  if (etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) {
      etagCache.delete(oldest);
    }
  }
};

const createConditionalFetch = (cacheIdentity: string, host = '') => async (url: string | URL | Request, options: RequestOptions = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options, host);
  }

  const cacheKey = `${cacheIdentity}\n${url}`;
  const cached = etagCache.get(cacheKey);
  const headers: ConditionalHeaders = { ...(options.headers || {}) };
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

export function createOctokit(token: AuthJson, accountId = '', host = ''): IdentifiedOctokit {
  const hash = crypto.createHash('sha256')
    .update(accountId)
    .update('\0');
  if (isString(token)) hash.update(token);
  else hash.update(token);
  const cacheIdentity = `github:${hash.digest('base64url')}`;
  const options: ConstructorParameters<typeof Octokit>[0] = { auth: token, request: { fetch: createConditionalFetch(cacheIdentity, host) } };
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (normalizedHost && normalizedHost !== 'github.com') {
    options.baseUrl = `https://${normalizedHost}/api/v3`;
  }
  const octokit = new Octokit(options);
  octokit.hook.error('request', (error: Error) => {
    if (hasProperty(error, 'status') && error.status === 401) forgetGhCliToken(normalizedHost, token);
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

export function getOctokitCacheIdentity(octokit: IdentifiedOctokit | null | undefined) {
  return octokit?.openChamberCacheIdentity || '';
}

export function selectTokenForHost(host: string | null | undefined, { ghToken, storedToken, ghCliActive }: {
  ghToken: string | null; storedToken: string | null | undefined; ghCliActive: boolean;
}) {
  return ghCliActive ? ghToken || storedToken : storedToken;
}

async function resolveHostCredential(host: string) {
  const stored = await getGitHubAuth(host);
  const ghCliActive = await isGhCliActiveForHost(host);
  const ghCliLogin = ghCliActive ? await getGhCliLoginForHost(host) : null;
  const ghToken = ghCliActive && !(await isGhCliDisabledForHost(host))
    ? await getGhCliToken(host, ghCliLogin)
    : null;
  return { stored, ghCliActive, ghCliLogin, ghToken };
}

export async function getOctokitOrNull(host?: string | null) {
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

export async function getGitHubCliCredential(accountId: string | null | undefined, revision?: number) {
  const cliMatch = /^([^#]+)#cli:(\d+)$/.exec(accountId ?? '');
  if (!cliMatch) return null;
  const host = cliMatch[1]?.toLowerCase() ?? '';
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (await isGhCliDisabledForHost(host)) return null;
  if (!(await isGhCliActiveForHost(host))) return null;
  if (revision !== undefined && revision !== 1) return null;
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  if (!login) return null;
  const token = await getGhCliLoginToken(host, login);
  if (!token) return null;
  return {
    credentialId: cliMatch[0],
    accountId,
    credentialRevision: 1,
    providerUserId: `${host}#${login.id}`,
    accessToken: token,
    source: 'cli' as const,
    status: 'valid' as const,
    user: login.profile,
  };
}

export async function getOctokitForHost(host: string | null | undefined, options: AccountOptions = {}) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost || normalizedHost === 'github.com' || !(await isTrustedGitHubHostOrStored(normalizedHost))) {
    return null;
  }
  const { stored, ghCliActive, ghToken } = await resolveHostCredential(normalizedHost);
  if (ghCliActive && ghToken) {
    const octokit = createOctokit(ghToken, '', normalizedHost);
    octokit.hook.error('request', async (error: Error) => {
      const identity = { provider: 'github', instance: normalizedHost, accountId: null };
      Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: false });
      if (hasProperty(error, 'status') && error.status === 401) {
        await options.onUnauthorized?.(identity, false);
        Object.assign(error, { sourceControlInvalidated: true });
      }
      throw error;
    });
    return octokit;
  }
  if (!stored) return null;
  const octokit = createOctokit(stored.accessToken, stored.accountId, normalizedHost);
  octokit.hook.error('request', async (error: Error) => {
    const identity = { provider: 'github', instance: normalizedHost, accountId: stored.accountId };
    Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: true });
    if (hasProperty(error, 'status') && error.status === 401) {
      await options.onUnauthorized?.(identity, true);
      Object.assign(error, { sourceControlInvalidated: true });
    }
    throw error;
  });
  return octokit;
}

export async function getOctokitForAccountId(accountId: string | undefined, options: AccountOptions = {}) {
  const auth = await getGitHubAuthByAccountId(accountId, undefined);
  if (auth) {
    const host = auth.host;
    const octokit = createOctokit(auth.accessToken, accountId, host);
    octokit.hook.error('request', async (error: Error) => {
      const identity = { provider: 'github', instance: host, accountId };
      Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: true });
      if (hasProperty(error, 'status') && error.status === 401) {
        await options.onUnauthorized?.(identity, true);
        Object.assign(error, { sourceControlInvalidated: true });
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
  const host = cliMatch[1]?.toLowerCase() ?? '';
  if (host !== 'github.com' && !(await isTrustedGitHubHostOrStored(host))) return null;
  if (!(await isGhCliActiveForHost(host)) || (await isGhCliDisabledForHost(host))) return null;
  const login = await findGhCliLogin(host, accountId, { createOctokit });
  const token = login ? await getGhCliLoginToken(host, login) : null;
  if (!login || !token) return null;
  const octokit = createOctokit(token, accountId, host);
  octokit.hook.error('request', async (error: Error) => {
    const identity = { provider: 'github', instance: host, accountId };
    Object.assign(error, { sourceControlIdentity: identity, sourceControlPersistedAccount: false });
    if (hasProperty(error, 'status') && error.status === 401) {
      await options.onUnauthorized?.(identity, false);
      Object.assign(error, { sourceControlInvalidated: true });
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
