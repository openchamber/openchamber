import crypto from 'crypto';
import {
  getLinearClientId,
  getLinearClientSecret,
  getLinearBrokerUrl,
  getLinearRedirectUri,
  getLinearScopes,
} from './auth.js';
import { isPlainObject, isString, readFiniteNumber, readTrimmedString } from './parse.js';

interface BrokerTransaction {
  url: string;
  claimSecret: string | null;
}

interface PendingAuthorization {
  codeVerifier: string;
  redirectUri: string;
  origin: 'desktop' | 'web';
  broker: BrokerTransaction | null;
  expiresAt: number;
}

interface BrokerReceipt extends BrokerTransaction {
  state: string;
}

interface LinearTokenPayload {
  error?: unknown;
  error_description?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface AuthorizationCallback {
  code?: unknown;
  state?: unknown;
  error?: unknown;
  errorDescription?: unknown;
}

type AuthorizationCodeForm = {
  grant_type: string;
  code: string;
  redirect_uri: string;
  client_id: string;
  code_verifier: string;
  client_secret?: string;
};

type RefreshTokenForm = {
  grant_type: string;
  refresh_token: string;
  client_id: string;
  client_secret?: string;
};

type RevokeTokenForm = {
  token: string;
  token_type_hint?: string;
};

export interface LinearTokens {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: number;
  scope: string;
}

export interface LinearAuthorization extends LinearTokens {
  origin: 'desktop' | 'web';
  brokerReceipt?: BrokerReceipt;
}

function hasText(value: unknown): value is string {
  return Boolean(readTrimmedString(value));
}

function hasErrorField(value: unknown): value is { error?: unknown } {
  return value != null;
}

const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;

const pendingByState = new Map<string, PendingAuthorization>();
const brokerPollsByState = new Map<string, Promise<LinearAuthorization | null>>();

class LinearOAuthError extends Error {
  declare code: string;
  declare status?: number;
  declare origin?: string;

  constructor(message: string, code = 'LINEAR_OAUTH_FAILED') {
    super(message);
    this.name = 'LinearOAuthError';
    this.code = code;
  }
}

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function pruneExpiredPending(now = Date.now()) {
  for (const [state, entry] of pendingByState.entries()) {
    if (!entry || entry.expiresAt <= now) {
      pendingByState.delete(state);
    }
  }
}

function normalizeScope(scope: string | unknown[] | null | undefined) {
  if (isString(scope)) {
    return scope.trim();
  }
  if (Array.isArray(scope)) {
    return scope.filter((item) => isString(item) && item.trim()).join(',');
  }
  return '';
}

function readExpiresAt(seconds: number | null, now = Date.now()) {
  if (seconds == null || seconds <= 0) {
    return now + 24 * 60 * 60 * 1000;
  }
  return now + Math.floor(seconds) * 1000;
}

function parseTokenPayload(payload: LinearTokenPayload | null): LinearTokens {
  if (!isPlainObject(payload)) {
    throw new LinearOAuthError('Linear token response was empty');
  }
  if (readTrimmedString(payload.error)) {
    throw new LinearOAuthError(
      readTrimmedString(payload.error_description) || readTrimmedString(payload.error),
      readTrimmedString(payload.error).toUpperCase(),
    );
  }
  const accessToken = readTrimmedString(payload.access_token);
  if (!accessToken) {
    throw new LinearOAuthError('Linear token response was missing access_token');
  }
  return {
    accessToken,
    refreshToken: readTrimmedString(payload.refresh_token) || null,
    tokenType: readTrimmedString(payload.token_type) || 'bearer',
    expiresAt: readExpiresAt(readFiniteNumber(payload.expires_in)),
    scope: isString(payload.scope) || Array.isArray(payload.scope) ? normalizeScope(payload.scope) : '',
  };
}

async function postForm(url: string, body: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const description = isPlainObject(payload)
      ? (readTrimmedString(payload.error_description) || readTrimmedString(payload.error))
      : '';
    const error = new LinearOAuthError(
      description || `Linear token request failed (${response.status})`,
      readTrimmedString(hasErrorField(payload) ? payload.error : undefined).toUpperCase() || 'LINEAR_OAUTH_FAILED',
    );
    error.status = response.status;
    throw error;
  }
  return parseTokenPayload(isPlainObject(payload) ? payload : null);
}

async function readJsonResponse(response: Response, fallbackMessage: string) {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isPlainObject(payload) && readTrimmedString(payload.error)
      ? readTrimmedString(payload.error)
      : `${fallbackMessage} (${response.status})`;
    const error = new LinearOAuthError(message, 'LINEAR_BROKER_FAILED');
    error.status = response.status;
    throw error;
  }
  if (!isPlainObject(payload)) {
    throw new LinearOAuthError(`${fallbackMessage}: invalid response`, 'LINEAR_BROKER_FAILED');
  }
  return payload;
}

function brokerCallbackUrl(brokerUrl: string) {
  return `${brokerUrl.replace(/\/+$/, '')}/callback`;
}

async function registerBrokerTransaction({ brokerUrl, state, claimSecret }: { brokerUrl: string; state: string; claimSecret: string | null }) {
  const response = await fetch(`${brokerUrl}/start`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, claimSecret }),
  });
  const payload = await readJsonResponse(response, 'Could not start Linear authorization broker');
  const redirectUri = readTrimmedString(payload.redirectUri);
  if (!redirectUri || redirectUri !== brokerCallbackUrl(brokerUrl)) {
    throw new LinearOAuthError('Linear authorization broker returned an unexpected callback URL', 'LINEAR_BROKER_FAILED');
  }
  return redirectUri;
}

export async function startAuthorization({ origin }: { origin?: string } = {}) {
  const clientId = getLinearClientId();
  if (!clientId) {
    throw new LinearOAuthError(
      'Linear OAuth client not configured. Set OPENCHAMBER_LINEAR_CLIENT_ID.',
      'LINEAR_CLIENT_ID_MISSING',
    );
  }

  pruneExpiredPending();
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(32).toString('base64url');
  const brokerUrl = getLinearBrokerUrl();
  const configuredRedirectUri = getLinearRedirectUri();
  const usesBroker = configuredRedirectUri === brokerCallbackUrl(brokerUrl);
  const claimSecret = usesBroker ? crypto.randomBytes(32).toString('base64url') : null;
  const redirectUri = usesBroker
    ? await registerBrokerTransaction({ brokerUrl, state, claimSecret })
    : configuredRedirectUri;
  const scope = getLinearScopes();
  pendingByState.set(state, {
    codeVerifier: verifier,
    redirectUri,
    origin: origin === 'desktop' ? 'desktop' : 'web',
    broker: usesBroker ? { url: brokerUrl, claimSecret } : null,
    expiresAt: Date.now() + PENDING_AUTHORIZATION_TTL_MS,
  });

  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('actor', 'user');
  url.searchParams.set('prompt', 'consent');

  return {
    authorizationUrl: url.toString(),
    expiresIn: Math.floor(PENDING_AUTHORIZATION_TTL_MS / 1000),
    scope,
  };
}

async function pollBrokerState(state: string, broker: BrokerTransaction): Promise<LinearAuthorization | null> {
  const response = await fetch(`${broker.url}/poll`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, claimSecret: broker.claimSecret }),
  });
  if (response.status === 202) {
    return null;
  }
  const payload = await readJsonResponse(response, 'Could not read Linear authorization result');
  const status = readTrimmedString(payload.status);
  if (status === 'complete') {
    const result = await consumeAuthorizationCallback({ code: payload.code, state });
    return {
      ...result,
      brokerReceipt: { state, ...broker },
    };
  }
  if (status === 'failed') {
    return consumeAuthorizationCallback({
      state,
      error: payload.error,
      errorDescription: payload.errorDescription,
    });
  }
  throw new LinearOAuthError('Linear authorization broker returned an unexpected result', 'LINEAR_BROKER_FAILED');
}

export async function completeAuthorizationBroker(receipt: BrokerReceipt | null | undefined) {
  if (!receipt?.url || !receipt?.state || !receipt?.claimSecret) return false;
  const response = await fetch(`${receipt.url}/complete`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: receipt.state, claimSecret: receipt.claimSecret }),
  });
  if (!response.ok) {
    throw new LinearOAuthError(`Could not acknowledge Linear authorization result (${response.status})`, 'LINEAR_BROKER_FAILED');
  }
  return true;
}

export async function pollAuthorizationBroker() {
  pruneExpiredPending();
  for (const [state, pending] of pendingByState.entries()) {
    if (!pending?.broker) continue;
    let poll = brokerPollsByState.get(state);
    if (!poll) {
      poll = pollBrokerState(state, pending.broker).finally(() => brokerPollsByState.delete(state));
      brokerPollsByState.set(state, poll);
    }
    const result = await poll;
    if (result) return result;
  }
  return null;
}

function failAuthorization(message: string, code: string, origin?: string) {
  const error = new LinearOAuthError(message, code);
  if (origin) {
    error.origin = origin;
  }
  return error;
}

export async function consumeAuthorizationCallback({ code, state, error, errorDescription }: AuthorizationCallback): Promise<LinearAuthorization> {
  pruneExpiredPending();
  const pending = hasText(state) ? pendingByState.get(state) : null;

  if (readTrimmedString(error)) {
    if (hasText(state)) pendingByState.delete(state);
    throw failAuthorization(
      readTrimmedString(errorDescription) || readTrimmedString(error),
      readTrimmedString(error).toUpperCase(),
      pending?.origin,
    );
  }
  if (!hasText(code)) {
    if (hasText(state)) pendingByState.delete(state);
    throw failAuthorization(
      'Linear did not return an authorization code.',
      'MISSING_CODE',
      pending?.origin,
    );
  }
  if (!pending?.codeVerifier) {
    throw failAuthorization(
      'This authorization session has expired or is unknown to the running app. Return to OpenChamber and click Connect again.',
      'UNKNOWN_STATE',
    );
  }

  const body: AuthorizationCodeForm = {
    grant_type: 'authorization_code',
    code: code.trim(),
    redirect_uri: pending.redirectUri,
    client_id: getLinearClientId(),
    code_verifier: pending.codeVerifier,
  };
  const clientSecret = getLinearClientSecret();
  if (clientSecret) {
    body.client_secret = clientSecret;
  }

  try {
    const tokens = await postForm(LINEAR_TOKEN_URL, body);
    if (hasText(state)) pendingByState.delete(state);
    return {
      ...tokens,
      origin: pending.origin,
    };
  } catch (caught) {
    if (caught instanceof Error) {
      Object.assign(caught, { origin: pending.origin });
    }
    throw caught;
  }
}

export async function refreshAccessToken(refreshToken: string | null | undefined) {
  const token = readTrimmedString(refreshToken);
  if (!token) {
    throw new LinearOAuthError('refresh_token is required', 'MISSING_REFRESH_TOKEN');
  }
  const body: RefreshTokenForm = {
    grant_type: 'refresh_token',
    refresh_token: token,
    client_id: getLinearClientId(),
  };
  const clientSecret = getLinearClientSecret();
  if (clientSecret) {
    body.client_secret = clientSecret;
  }
  return postForm(LINEAR_TOKEN_URL, body);
}

export async function revokeToken(token: string | null | undefined, tokenTypeHint?: string) {
  const value = readTrimmedString(token);
  if (!value) {
    return false;
  }
  const body: RevokeTokenForm = { token: value };
  if (tokenTypeHint === 'access_token' || tokenTypeHint === 'refresh_token') {
    body.token_type_hint = tokenTypeHint;
  }
  try {
    const response = await fetch(LINEAR_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export function clearPendingAuthorizationsForTests() {
  pendingByState.clear();
  brokerPollsByState.clear();
}
