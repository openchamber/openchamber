import crypto from 'node:crypto';

import {
  GUEST_ACCOUNT_MAX,
  GUEST_REQUEST_TIMEOUT_MS,
  isGuestRequestPath,
  resolveIntegrationApi,
  resolveIntegrationAuth,
} from '@openchamber/sdk';

import { dropGuestTokens, getGuestAuth, patchGuestAuth } from './auth-store.js';

export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;

const pendingByState = new Map();
const pendingByGuestId = new Map();

export class GuestOAuthError extends Error {
  constructor(message, code = 'GUEST_OAUTH_FAILED') {
    super(message);
    this.name = 'GuestOAuthError';
    this.code = code;
  }
}

export const createPkcePair = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const pruneExpiredPending = (now = Date.now()) => {
  for (const [state, entry] of pendingByState.entries()) {
    if (!entry || entry.expiresAt <= now) {
      pendingByState.delete(state);
      if (entry?.guestId) {
        const current = pendingByGuestId.get(entry.guestId);
        if (current?.state === state) {
          pendingByGuestId.delete(entry.guestId);
        }
      }
    }
  }
};

const dropPendingForGuest = (guestId) => {
  const current = pendingByGuestId.get(guestId);
  if (current?.state) {
    pendingByState.delete(current.state);
  }
  pendingByGuestId.delete(guestId);
};

const rememberPending = (state, entry) => {
  dropPendingForGuest(entry.guestId);
  pendingByState.set(state, entry);
  pendingByGuestId.set(entry.guestId, { ...entry, state });
};

// `state` is the only thing that ties a callback to the click that started
// it. Accepting a callback without it would let any link visited during the
// pending window attach a stranger's account, so a missing state is a refusal.
const takePending = (guestId, state) => {
  const trimmed = readTrimmedString(state);
  if (!trimmed) {
    return null;
  }
  const pending = pendingByState.get(trimmed);
  if (!pending || pending.guestId !== guestId) {
    return null;
  }
  pendingByState.delete(trimmed);
  if (pendingByGuestId.get(guestId)?.state === trimmed) {
    pendingByGuestId.delete(guestId);
  }
  return pending;
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const readExpiresAt = (expiresIn, now = Date.now()) => {
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return now + 24 * 60 * 60 * 1000;
  }
  return now + Math.floor(seconds) * 1000;
};

const parseTokenPayload = (payload) => {
  if (!isPlainObject(payload)) {
    throw new GuestOAuthError('Token response was empty');
  }
  if (readTrimmedString(payload.error)) {
    throw new GuestOAuthError(
      readTrimmedString(payload.error_description) || readTrimmedString(payload.error),
      readTrimmedString(payload.error).toUpperCase() || 'GUEST_OAUTH_FAILED',
    );
  }
  const accessToken = readTrimmedString(payload.access_token);
  if (!accessToken) {
    throw new GuestOAuthError('Token response was missing access_token');
  }
  return {
    accessToken,
    refreshToken: readTrimmedString(payload.refresh_token) || null,
    tokenType: readTrimmedString(payload.token_type) || 'bearer',
    expiresAt: readExpiresAt(payload.expires_in),
  };
};

const readTokenError = (payload, status) => {
  const description = isPlainObject(payload)
    ? (readTrimmedString(payload.error_description) || readTrimmedString(payload.error))
    : '';
  return description || `Token request failed (${status})`;
};

const postForm = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GuestOAuthError(readTokenError(payload, response.status));
  }
  return parseTokenPayload(payload);
};

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GuestOAuthError(readTokenError(payload, response.status));
  }
  return parseTokenPayload(payload);
};

const exchangeAuthorizationCode = async (tokenUrl, formBody, jsonBody) => {
  try {
    return await postForm(tokenUrl, formBody);
  } catch (first) {
    try {
      return await postJson(tokenUrl, jsonBody);
    } catch {
      throw first;
    }
  }
};

export const guestAuthorizationHeader = (token, authorization) => {
  if (authorization === 'bearer') {
    return `Bearer ${token}`;
  }
  if (authorization === 'basic') {
    // `basic` stores the already-encoded `username:token` pair; see saveGuestAccessToken.
    return `Basic ${token}`;
  }
  return token;
};

/** Encodes `username:token` for a `basic` integration. Stored as the access token so requests need no username. */
export const encodeBasicCredential = (username, token) => Buffer.from(`${username}:${token}`, 'utf8').toString('base64');

export const guestRedirectUri = (origin, guestId) => `${origin.replace(/\/+$/, '')}/api/guests/${guestId}/oauth/callback`;

export const toPublicGuestAuth = (entry) => ({
  connected: Boolean(entry?.accessToken),
  account: typeof entry?.account === 'string' ? entry.account : '',
  hasClient: Boolean(entry?.clientId),
  settings: entry?.settings && typeof entry.settings === 'object' ? { ...entry.settings } : {},
});

const readAccountLabel = (payload, name) => {
  if (!isPlainObject(payload) || typeof name !== 'string' || name === '') {
    return '';
  }
  let current = payload;
  for (const part of name.split('.')) {
    if (!isPlainObject(current) || !(part in current)) {
      return '';
    }
    current = current[part];
  }
  return typeof current === 'string' ? current.trim().slice(0, GUEST_ACCOUNT_MAX) : '';
};

const fetchAccountLabel = async (api, accessToken) => {
  if (!api.account) {
    return { ok: true, account: '' };
  }
  if (!isGuestRequestPath(api.account.path)) {
    return { ok: false, account: '' };
  }
  const url = new URL(api.account.path, `${api.apiOrigin}/`);
  if (url.origin !== api.apiOrigin) {
    return { ok: false, account: '' };
  }
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: guestAuthorizationHeader(accessToken, api.authorization),
    },
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { ok: false, account: '' };
  }
  const payload = await response.json().catch(() => null);
  return { ok: true, account: readAccountLabel(payload, api.account.name) };
};

export const saveGuestAccessToken = async ({ guest, persistPath, token, username }) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'token') {
    throw new GuestOAuthError('This guest does not accept a pasted token.', 'NO_TOKEN_AUTH');
  }
  const api = resolveIntegrationApi(guest.integration);
  const pastedToken = readTrimmedString(token);
  if (!api || !pastedToken) {
    throw new GuestOAuthError('API token is missing.', 'TOKEN_MISSING');
  }
  const pastedUsername = readTrimmedString(username);
  if (api.authorization === 'basic' && !pastedUsername) {
    throw new GuestOAuthError('Username is missing.', 'USERNAME_MISSING');
  }
  const accessToken = api.authorization === 'basic'
    ? encodeBasicCredential(pastedUsername, pastedToken)
    : pastedToken;
  const probed = await fetchAccountLabel(api, accessToken);
  if (api.account && !probed.ok) {
    throw new GuestOAuthError('That API token was refused.', 'TOKEN_INVALID');
  }
  const account = probed.account || (api.authorization === 'basic' ? pastedUsername.slice(0, GUEST_ACCOUNT_MAX) : '');
  await patchGuestAuth(guest.id, {
    accessToken,
    refreshToken: null,
    tokenType: api.authorization,
    expiresAt: null,
    account,
    authorizedAt: Date.now(),
  }, persistPath);
  return { connected: true, account };
};

export const startGuestAuthorization = async ({ guest, persistPath, origin }) => {
  const oauth = guest.integration?.oauth;
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth' || !oauth) {
    throw new GuestOAuthError('This guest does not declare OAuth.', 'NO_INTEGRATION');
  }
  const stored = await getGuestAuth(guest.id, persistPath);
  const clientId = readTrimmedString(stored?.clientId);
  if (!clientId) {
    throw new GuestOAuthError('Client id is missing. Save it in Integrations first.', 'CLIENT_MISSING');
  }
  pruneExpiredPending();
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(32).toString('base64url');
  const redirectUri = guestRedirectUri(origin, guest.id);
  rememberPending(state, {
    guestId: guest.id,
    codeVerifier: verifier,
    redirectUri,
    expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS,
  });

  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (oauth.scopes && oauth.scopes.length > 0) {
    url.searchParams.set('scope', oauth.scopes.join(' '));
  }

  return {
    authorizationUrl: url.toString(),
    expiresIn: Math.floor(PENDING_AUTHORIZATION_TTL_MS / 1000),
  };
};

export const consumeGuestAuthorization = async ({ guest, persistPath, code, state, error, errorDescription }) => {
  pruneExpiredPending();
  if (readTrimmedString(error)) {
    dropPendingForGuest(guest.id);
    throw new GuestOAuthError(readTrimmedString(errorDescription) || readTrimmedString(error));
  }
  const pending = takePending(guest.id, state);
  if (!pending) {
    throw new GuestOAuthError('Authorization state was missing or expired.', 'STATE_MISMATCH');
  }
  const stored = await getGuestAuth(guest.id, persistPath);
  const clientId = readTrimmedString(stored?.clientId);
  const clientSecret = readTrimmedString(stored?.clientSecret);
  if (!clientId || !code) {
    throw new GuestOAuthError('Authorization code or client credentials were missing.');
  }
  const tokens = await exchangeAuthorizationCode(
    guest.integration.oauth.tokenUrl,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: pending.codeVerifier,
    },
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
    },
  );
  let account = '';
  try {
    const api = resolveIntegrationApi(guest.integration);
    if (api) {
      const probed = await fetchAccountLabel(api, tokens.accessToken);
      account = probed.account;
    }
  } catch {
    account = '';
  }
  await patchGuestAuth(guest.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
    account,
    authorizedAt: Date.now(),
  }, persistPath);
  return { connected: true, account };
};

export const refreshGuestAccessToken = async ({ guest, persistPath }) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth' || !guest.integration?.oauth) {
    return null;
  }
  const stored = await getGuestAuth(guest.id, persistPath);
  const refreshToken = readTrimmedString(stored?.refreshToken);
  const clientId = readTrimmedString(stored?.clientId);
  const clientSecret = readTrimmedString(stored?.clientSecret);
  if (!refreshToken || !clientId) {
    return null;
  }
  const tokens = await postForm(guest.integration.oauth.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  await patchGuestAuth(guest.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
  }, persistPath);
  return tokens.accessToken;
};

export const disconnectGuestAuth = async (guestId, persistPath) => {
  await dropGuestTokens(guestId, persistPath);
};

export const clearGuestPendingForTests = () => {
  pendingByState.clear();
  pendingByGuestId.clear();
};
