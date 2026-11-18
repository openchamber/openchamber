import crypto from 'node:crypto';

import {
  GUEST_ACCOUNT_MAX,
  GUEST_REQUEST_TIMEOUT_MS,
  guestToolLinkSettingIds,
  isGuestRequestPath,
  resolveIntegrationApi,
  resolveIntegrationAuth,
} from '@openchamber/sdk';

import { dropGuestTokens, getGuestAuth, patchGuestAuth } from './auth-store.js';
import type { GuestAuthEntry } from './auth-store.js';
import type { IntegrationContribution } from '@openchamber/sdk';
import type { GuestRecord, JsonValue } from './contracts.js';
import { isString, isJsonObject as isPlainObject } from './input-guards.js';

const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;

type CredentialTarget = NonNullable<GuestAuthEntry['target']>;
type PendingAuthorization = { guestId: string; codeVerifier: string; redirectUri: string; target: CredentialTarget; expiresAt: number };
type GuestAuthOptions = { guest: GuestRecord; persistPath: string };
type Integration = IntegrationContribution | undefined;
const pendingByState = new Map<string, PendingAuthorization>();
const pendingByGuestId = new Map<string, PendingAuthorization & { state: string }>();

export class GuestOAuthError extends Error {
  code: string;
  constructor(message: string, code = 'GUEST_OAUTH_FAILED') {
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

const dropPendingForGuest = (guestId: string) => {
  const current = pendingByGuestId.get(guestId);
  if (current?.state) {
    pendingByState.delete(current.state);
  }
  pendingByGuestId.delete(guestId);
};

const rememberPending = (state: string, entry: PendingAuthorization) => {
  dropPendingForGuest(entry.guestId);
  pendingByState.set(state, entry);
  pendingByGuestId.set(entry.guestId, { ...entry, state });
};

const takePending = (guestId: string, state: string | undefined) => {
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

const readTrimmedString = (value: JsonValue | undefined) => (isString(value) ? value.trim() : '');

const readExpiresAt = (expiresIn: JsonValue | undefined, now = Date.now()) => {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return now + 24 * 60 * 60 * 1000;
  }
  return now + Math.floor(seconds) * 1000;
};

const parseTokenPayload = (payload: JsonValue) => {
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

const readTokenError = (payload: JsonValue, status: number) => {
  const description = isPlainObject(payload)
    ? (readTrimmedString(payload.error_description) || readTrimmedString(payload.error))
    : '';
  return description || `Token request failed (${status})`;
};

const postForm = async (url: string, body: Record<string, string | undefined>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(Object.entries(body).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])).toString(),
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  });
  const payload: JsonValue = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GuestOAuthError(readTokenError(payload, response.status));
  }
  return parseTokenPayload(payload);
};

const postJson = async (url: string, body: Record<string, JsonValue | undefined>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  });
  const payload: JsonValue = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GuestOAuthError(readTokenError(payload, response.status));
  }
  return parseTokenPayload(payload);
};

const exchangeAuthorizationCode = async (tokenUrl: string, formBody: Record<string, string | undefined>, jsonBody: Record<string, JsonValue | undefined>) => {
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

export const guestAuthorizationHeader = (token: string, authorization: string) => {
  if (authorization === 'bearer') {
    return `Bearer ${token}`;
  }
  if (authorization === 'basic') {
    return `Basic ${token}`;
  }
  return token;
};

export const encodeBasicCredential = (username: string, token: string) => Buffer.from(`${username}:${token}`, 'utf8').toString('base64');

export const guestRedirectUri = (origin: string, guestId: string) => `${origin.replace(/\/+$/, '')}/api/guests/${guestId}/oauth/callback`;

export const toPublicGuestAuth = (entry: GuestAuthEntry | null | undefined, integration: Integration) => {
  const stored = entry?.settings ?? {};
  const declared = integration?.settings ?? [];
  const secretIds = new Set(declared.filter((field) => field.secret).map((field) => field.id));
  const publicIds = new Set(declared.filter((field) => !field.secret).map((field) => field.id));
  return {
    connected: Boolean(entry?.accessToken),
    account: entry?.account ?? '',
    hasClient: integration ? Boolean(usableClientCredentials(entry, integration).clientId) : Boolean(entry?.clientId),
    settings: Object.fromEntries(Object.entries(stored).filter(([key]) => publicIds.has(key))),
    secretsSet: Object.keys(stored).filter((key) => secretIds.has(key) && stored[key]),
  };
};

export const toolLinkSettingsOf = (entry: GuestAuthEntry | null | undefined, guest: GuestRecord) => {
  const visible = toPublicGuestAuth(entry, guest.integration).settings;
  return Object.fromEntries(guestToolLinkSettingIds(guest.tools)
    .flatMap((id) => {
      const value = visible[id];
      return Object.hasOwn(visible, id) && isString(value) && value !== '' ? [[id, value]] : [];
    }));
};

const readAccountLabel = (payload: JsonValue, name: string | undefined) => {
  if (!isPlainObject(payload) || name === undefined || name === '') {
    return '';
  }
  let current: JsonValue | undefined = payload;
  for (const part of name.split('.')) {
    if (!isPlainObject(current) || !(part in current)) {
      return '';
    }
    current = current[part];
  }
  return isString(current) ? current.trim().slice(0, GUEST_ACCOUNT_MAX) : '';
};

const fetchAccountLabel = async (api: NonNullable<ReturnType<typeof resolveIntegrationApi>>, accessToken: string) => {
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
  const payload: JsonValue = await response.json().catch(() => null);
  return { ok: true, account: readAccountLabel(payload, api.account.name) };
};

export const credentialTarget = (integration: Integration) => {
  const api = integration ? resolveIntegrationApi(integration) : null;
  if (!api) {
    return null;
  }
  const target: CredentialTarget = { apiOrigin: api.apiOrigin };
  if (integration?.oauth) {
    target.authorizeUrl = integration.oauth.authorizeUrl;
    target.tokenUrl = integration.oauth.tokenUrl;
  }
  return target;
};

const sameTarget = (a: CredentialTarget | null | undefined, b: CredentialTarget | null | undefined) => !!(a && b)
  && a.apiOrigin === b.apiOrigin
  && (a.authorizeUrl ?? null) === (b.authorizeUrl ?? null)
  && (a.tokenUrl ?? null) === (b.tokenUrl ?? null);

export const storedTokensUsable = (stored: GuestAuthEntry | null, integration: Integration) => (
  !!stored?.accessToken && sameTarget(stored.target, credentialTarget(integration))
);

const usableClientCredentials = (stored: GuestAuthEntry | null | undefined, integration: Integration) => {
  if (!sameTarget(stored?.clientTarget, credentialTarget(integration))) {
    return { clientId: '', clientSecret: '' };
  }
  return {
    clientId: readTrimmedString(stored?.clientId),
    clientSecret: readTrimmedString(stored?.clientSecret),
  };
};

export const takeUsableGuestAuth = async (guest: GuestRecord, persistPath: string) => {
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

export const saveGuestOAuthClient = async ({ guest, persistPath, clientId, clientSecret }: GuestAuthOptions & { clientId: string; clientSecret?: string | undefined }) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth') {
    throw new GuestOAuthError('This guest does not declare OAuth.', 'NO_INTEGRATION');
  }
  const id = readTrimmedString(clientId);
  const secret = readTrimmedString(clientSecret);
  if (!id) {
    throw new GuestOAuthError('Client id is missing.', 'CLIENT_MISSING');
  }
  const clientTarget = credentialTarget(guest.integration);
  if (!clientTarget) throw new GuestOAuthError('This guest does not declare OAuth.', 'NO_INTEGRATION');
  return patchGuestAuth(guest.id, (current) => {
    const next: GuestAuthEntry = { clientId: id, clientTarget };
    if (secret) {
      next.clientSecret = secret;
    } else if (readTrimmedString(current?.clientId) !== id || !sameTarget(current?.clientTarget, clientTarget)) {
      next.clientSecret = undefined;
    }
    return next;
  }, persistPath);
};

export const saveGuestAccessToken = async ({ guest, persistPath, token, username }: GuestAuthOptions & { token: string; username?: string | undefined }) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'token') {
    throw new GuestOAuthError('This guest does not accept a pasted token.', 'NO_TOKEN_AUTH');
  }
  const api = guest.integration ? resolveIntegrationApi(guest.integration) : null;
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
  const target = credentialTarget(guest.integration);
  if (!target) throw new GuestOAuthError('API token is missing.', 'TOKEN_MISSING');
  await patchGuestAuth(guest.id, {
    accessToken,
    refreshToken: null,
    tokenType: api.authorization,
    expiresAt: null,
    account,
    authorizedAt: Date.now(),
    target,
  }, persistPath);
  return { connected: true, account };
};

export const startGuestAuthorization = async ({ guest, persistPath, origin }: GuestAuthOptions & { origin: string }) => {
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
  const target = credentialTarget(guest.integration);
  if (!target) throw new GuestOAuthError('This guest does not declare OAuth.', 'NO_INTEGRATION');
  rememberPending(state, {
    guestId: guest.id,
    codeVerifier: verifier,
    redirectUri,
    target,
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

export const consumeGuestAuthorization = async ({ guest, persistPath, code, state, error, errorDescription }: GuestAuthOptions & { code?: string; state?: string; error?: string; errorDescription?: string }) => {
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
    requiredTokenUrl(pending.target),
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
    const api = guest.integration ? resolveIntegrationApi(guest.integration) : null;
    if (api) {
      const probed = await fetchAccountLabel(api, tokens.accessToken);
      account = probed.account;
    }
  } catch {
    account = '';
  }
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

const requiredTokenUrl = (target: CredentialTarget): string => {
  if (target.tokenUrl === undefined) throw new Error('OAuth credential target has no token URL');
  return target.tokenUrl;
};

export const refreshGuestAccessToken = async ({ guest, persistPath }: GuestAuthOptions) => {
  if (resolveIntegrationAuth(guest.integration ?? {}) !== 'oauth' || !guest.integration?.oauth) {
    return null;
  }
  const stored = await takeUsableGuestAuth(guest, persistPath);
  const refreshToken = readTrimmedString(stored?.refreshToken);
  const { clientId, clientSecret } = usableClientCredentials(stored, guest.integration);
  if (!refreshToken || !clientId || !stored) {
    return null;
  }
  const target = stored.target;
  if (!target) throw new Error('Usable OAuth credentials have no target');
  const previousAccessToken = stored.accessToken;
  const tokens = await postForm(requiredTokenUrl(target), {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
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

export const disconnectGuestAuth = async (guestId: string, persistPath: string) => {
  await dropGuestTokens(guestId, persistPath);
};

export const clearGuestPendingForTests = () => {
  pendingByState.clear();
  pendingByGuestId.clear();
};

export { exchangeAuthorizationCode, postForm as postTokenForm };
