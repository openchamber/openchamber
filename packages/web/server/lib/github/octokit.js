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
// Byte bounds for the cache (triage on #848): a per-entry cap so one
// oversized GitHub answer is never retained, and a total budget so the
// cache's worst-case retained bytes are bounded regardless of how many
// entries accumulate. Only body bytes are counted.
const ETAG_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const ETAG_CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const etagCache = new Map();
let etagCacheTotalBytes = 0;

const rememberEtag = (key, etag, body, headers) => {
  const size = body?.byteLength ?? 0;
  if (size > ETAG_CACHE_MAX_ENTRY_BYTES) {
    return;
  }
  const existing = etagCache.get(key);
  if (existing) {
    etagCacheTotalBytes -= existing.body?.byteLength ?? 0;
    etagCache.delete(key);
  }
  etagCache.set(key, { etag, body, headers });
  etagCacheTotalBytes += size;
  while (etagCache.size > ETAG_CACHE_MAX_ENTRIES || etagCacheTotalBytes > ETAG_CACHE_MAX_TOTAL_BYTES) {
    const oldest = etagCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    etagCacheTotalBytes -= etagCache.get(oldest)?.body?.byteLength ?? 0;
    etagCache.delete(oldest);
  }
};

// Reads a response body while holding at most the per-entry cap plus one
// stream chunk in memory. A body that ends within the cap comes back as a
// single ArrayBuffer, ready to retain. A body that crosses the cap comes
// back as a stream that first replays the captured prefix and then
// continues the original body, so the caller still receives every byte
// without the cache ever materializing the whole response (#1373: an
// absent or understated Content-Length must not defeat the cap).
const readBodyUpToEtagCap = async (response) => {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const body = await response.arrayBuffer();
    return { body, oversize: body.byteLength > ETAG_CACHE_MAX_ENTRY_BYTES };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > ETAG_CACHE_MAX_ENTRY_BYTES) {
      const prefix = [...chunks, value];
      let index = 0;
      const remainder = new ReadableStream({
        async pull(controller) {
          if (index < prefix.length) {
            controller.enqueue(prefix[index]);
            index += 1;
            return;
          }
          const next = await reader.read();
          if (next.done) {
            controller.close();
          } else if (next.value?.byteLength) {
            controller.enqueue(next.value);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { remainder };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: merged.buffer, oversize: false };
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
      // Oversized answers are returned whole but never retained: with a
      // declared length over the per-entry cap, pass the response through
      // unbuffered; otherwise read the body under the cap (an absent or
      // understated Content-Length is decided by the streamed bytes, not
      // by buffering the whole response first).
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > ETAG_CACHE_MAX_ENTRY_BYTES) {
        return response;
      }
      const result = await readBodyUpToEtagCap(response);
      // The responses rebuilt below carry this code's bytes, not the
      // declared ones: a Content-Length that disagrees with them (the
      // understated case, or the still-unknown streamed length) must not
      // travel with the new body.
      const headers = new Headers(response.headers);
      if (result.remainder || declaredLength !== result.body.byteLength) {
        headers.delete('content-length');
      }
      if (result.remainder) {
        return new Response(result.remainder, { status: response.status, headers });
      }
      if (!result.oversize) {
        rememberEtag(cacheKey, etag, result.body, response.headers);
      }
      return new Response(result.body, { status: response.status, headers });
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
  // The gh CLI login is used only after the user switched to it in Settings:
  // its token carries every scope ever granted to gh, so it is never picked
  // up silently when OpenChamber has no account of its own.
  const ghToken = isGhCliActive() && !isGhCliDisabled() ? getGhCliToken() : null;
  const token = ghToken || auth?.accessToken;
  if (!token) {
    return null;
  }
  const accountId = token === auth?.accessToken ? auth.accountId : '';
  return createOctokit(token, accountId);
}

/**
 * The gh CLI account as a credential record shaped like a persisted one, for
 * Git transport. Same consent rule as getOctokitForAccountId: only while the
 * user has switched to the gh account, and only when gh is still signed in
 * as that same GitHub user. The CLI credential has no revisions beyond 1.
 */
export async function getGitHubCliCredential(accountId, revision) {
  if (!accountId.startsWith('github.com#cli:') || !isGhCliActive() || isGhCliDisabled()) return null;
  if (revision !== undefined && revision !== 1) return null;
  const token = getGhCliToken();
  if (!token) return null;
  let response;
  try {
    response = await createOctokit(token, accountId).rest.users.getAuthenticated();
  } catch (error) {
    if (error?.status === 401) return null;
    throw error;
  }
  if (githubCliAccountId(response.data.id) !== accountId) return null;
  return {
    credentialId: accountId,
    accountId,
    credentialRevision: 1,
    providerUserId: githubAccountId(response.data.id),
    accessToken: token,
    source: 'cli',
    status: 'valid',
    user: response.data,
  };
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
  // An exact CLI account id is not consent: the gh token is used only while
  // the user has switched to the gh account in Settings.
  if (!accountId.startsWith('github.com#cli:') || !isGhCliActive() || isGhCliDisabled()) return null;
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
