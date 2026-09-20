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

/** With `integration`, `hasClient` is false for a client entered for endpoints the package no longer names. */
export const toPublicGuestAuth = (entry, integration) => ({
  connected: Boolean(entry?.accessToken),
  account: typeof entry?.account === 'string' ? entry.account : '',
  hasClient: integration ? Boolean(usableClientCredentials(entry, integration).clientId) : Boolean(entry?.clientId),
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

/**
 * The addresses credentials for this integration go to: the API origin and,
 * for OAuth, the authorize and token endpoints.
 * @returns {{ apiOrigin: string, authorizeUrl?: string, tokenUrl?: string } | null}
 */
export const credentialTarget = (integration) => {
  const api = resolveIntegrationApi(integration ?? {});
  if (!api) {
    return null;
  }
  const target = { apiOrigin: api.apiOrigin };
  if (integration?.oauth) {
    target.authorizeUrl = integration.oauth.authorizeUrl;
    target.tokenUrl = integration.oauth.tokenUrl;
  }
  return target;
};

const sameTarget = (a, b) => Boolean(a && b)
  && a.apiOrigin === b.apiOrigin
  && (a.authorizeUrl ?? null) === (b.authorizeUrl ?? null)
  && (a.tokenUrl ?? null) === (b.tokenUrl ?? null);

/**
 * Whether the stored tokens were minted for the integration as it is now.
 * Tokens without a recorded target never count.
 */
export const storedTokensUsable = (stored, integration) => (
  Boolean(stored?.accessToken) && sameTarget(stored.target, credentialTarget(integration))
);

/**
 * The client id and secret, only when they were entered for the endpoints
 * the package names now. Anything else is treated as missing.
 * @returns {{ clientId: string, clientSecret: string }}
 */
export const usableClientCredentials = (stored, integration) => {
  if (!sameTarget(stored?.clientTarget, credentialTarget(integration))) {
    return { clientId: '', clientSecret: '' };
  }
  return {
    clientId: readTrimmedString(stored?.clientId),
    clientSecret: readTrimmedString(stored?.clientSecret),
  };
};

/**
 * Tokens that no longer match the package's addresses are dropped, so the
 * card shows disconnected and nothing is sent to the new addresses.
 * @returns {Promise<object | null>} the stored entry when its tokens are usable
 */
export const takeUsableGuestAuth = async (guest, persistPath) => {
  const stored = await getGuestAuth(guest.id, persistPath);
  if (!stored?.accessToken) {
    return stored;
  }
  if (storedTokensUsable(stored, guest.integration)) {
    return stored;
  }
  await dropGuestTokens(guest.id, persistPath);
  return getGuestAuth(guest.id, persistPath);
};

/**
 * Save the OAuth client the user entered on the Integrations card. The
 * client is bound to the endpoints the package names now. An empty secret
 * keeps the stored one only for the same client id and the same endpoints;
 * a new id or moved endpoints drop the old secret instead of carrying it
 * over. Decided under the store lock against the entry as it is then.
 */
export const saveGuestOAuthClient = async ({ guest, persistPath, clientId, clientSecret }) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth') {
    throw new GuestOAuthError('This guest does not declare OAuth.', 'NO_INTEGRATION');
  }
  const id = readTrimmedString(clientId);
  const secret = readTrimmedString(clientSecret);
  if (!id) {
    throw new GuestOAuthError('Client id is missing.', 'CLIENT_MISSING');
  }
  const clientTarget = credentialTarget(guest.integration);
  return patchGuestAuth(guest.id, (current) => {
    const next = { clientId: id, clientTarget };
    if (secret) {
      next.clientSecret = secret;
    } else if (readTrimmedString(current?.clientId) !== id || !sameTarget(current?.clientTarget, clientTarget)) {
      next.clientSecret = undefined;
    }
    return next;
  }, persistPath);
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
    target: credentialTarget(guest.integration),
  }, persistPath);
  return { connected: true, account };
};

export const startGuestAuthorization = async ({ guest, persistPath, origin }) => {
  const oauth = guest.integration?.oauth;
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth' || !oauth) {
    throw new GuestOAuthError('This guest does not declare OAuth.', 'NO_INTEGRATION');
  }
  const stored = await getGuestAuth(guest.id, persistPath);
  const { clientId } = usableClientCredentials(stored, guest.integration);
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
    // The exchange goes to the endpoints the user saw when they clicked
    // Connect, and only if the package still names the same ones.
    target: credentialTarget(guest.integration),
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
  if (!sameTarget(pending.target, credentialTarget(guest.integration))) {
    throw new GuestOAuthError('The extension changed its endpoints while you were signing in. Review it in Settings → Extensions and connect again.', 'TARGET_CHANGED');
  }
  const stored = await getGuestAuth(guest.id, persistPath);
  const { clientId, clientSecret } = usableClientCredentials(stored, guest.integration);
  if (!clientId || !code) {
    throw new GuestOAuthError('Authorization code or client credentials were missing.');
  }
  const tokens = await exchangeAuthorizationCode(
    pending.target.tokenUrl,
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
  // The client that made this exchange must still be the one on file, for
  // the same endpoints, when the tokens land.
  const saved = await patchGuestAuth(guest.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
    account,
    authorizedAt: Date.now(),
    target: pending.target,
  }, persistPath, (current) => (
    readTrimmedString(current?.clientId) === clientId && sameTarget(current?.clientTarget, pending.target)
  ));
  if (!saved || saved.accessToken !== tokens.accessToken) {
    throw new GuestOAuthError('The client credentials changed while you were signing in. Connect again.', 'TARGET_CHANGED');
  }
  return { connected: true, account };
};

export const refreshGuestAccessToken = async ({ guest, persistPath }) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth' || !guest.integration?.oauth) {
    return null;
  }
  const stored = await takeUsableGuestAuth(guest, persistPath);
  const refreshToken = readTrimmedString(stored?.refreshToken);
  const { clientId, clientSecret } = usableClientCredentials(stored, guest.integration);
  if (!refreshToken || !clientId) {
    return null;
  }
  const target = stored.target;
  const previousAccessToken = stored.accessToken;
  const tokens = await postForm(target.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  // The round trip took time. If the entry moved on meanwhile (a new
  // Connect for other endpoints, a disconnect), this answer belongs to the
  // old entry and is dropped rather than written under the new target.
  const saved = await patchGuestAuth(guest.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
  }, persistPath, (current) => (
    current?.accessToken === previousAccessToken
    && readTrimmedString(current?.refreshToken) === refreshToken
    && sameTarget(current?.target, target)
  ));
  if (!saved || saved.accessToken !== tokens.accessToken) {
    return null;
  }
  return tokens.accessToken;
};

export const disconnectGuestAuth = async (guestId, persistPath) => {
  await dropGuestTokens(guestId, persistPath);
};

export const clearGuestPendingForTests = () => {
  pendingByState.clear();
  pendingByGuestId.clear();
};
