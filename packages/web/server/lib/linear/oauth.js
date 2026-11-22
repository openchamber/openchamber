import crypto from 'crypto';
import {
  getLinearClientId,
  getLinearClientSecret,
  getLinearBrokerUrl,
  getLinearRedirectUri,
  getLinearScopes,
} from './auth.js';
import { isPlainObject, isString, readFiniteNumber, readTrimmedString } from './parse.js';
import { readBoundedResponseText } from '../shared/response-body.js';

const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;
// A user waits on the callback while the code is exchanged, so the token
// endpoint gets enough room for a slow exchange but still has a deadline.
const LINEAR_TOKEN_TIMEOUT_MS = 15_000;
// Status polling calls the broker every 1.5 seconds while a user waits. The
// deadline is shared by the overlapping polls through brokerPollsByState, so a
// broker that takes a few seconds to answer still completes inside it.
const LINEAR_BROKER_TIMEOUT_MS = 5_000;
// Broker and token JSON answers are a few hundred bytes; the cap matches the
// other bounded auth-body reads (GitLab AUTH_BODY_MAX_BYTES) and keeps an
// operator-configured broker from buffering an unbounded body via .json().
const LINEAR_JSON_RESPONSE_MAX_BYTES = 1024 * 1024;

const pendingByState = new Map();
const brokerPollsByState = new Map();

export class LinearOAuthError extends Error {
  constructor(message, code = 'LINEAR_OAUTH_FAILED') {
    super(message);
    this.name = 'LinearOAuthError';
    this.code = code;
  }
}

// AbortSignal.timeout aborts with a TimeoutError DOMException; a body read cut
// off by the same deadline may surface as an AbortError instead.
function isTimeoutAbort(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

const tokenTimeoutError = () => new LinearOAuthError('Linear token request timed out', 'LINEAR_OAUTH_TIMEOUT');
const brokerTimeoutError = () => new LinearOAuthError('Linear authorization broker request timed out', 'LINEAR_BROKER_TIMEOUT');

async function fetchWithDeadline(url, options, timeoutMs, onTimeout) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal });
    return { response, signal };
  } catch (error) {
    if (isTimeoutAbort(error)) throw onTimeout();
    throw error;
  }
}

async function readJsonWithDeadline(response, signal, onTimeout, onTooLarge) {
  let bounded;
  try {
    bounded = await readBoundedResponseText(response, LINEAR_JSON_RESPONSE_MAX_BYTES);
  } catch (error) {
    if (isTimeoutAbort(error) || signal.aborted) throw onTimeout();
    return null;
  }
  if (bounded.tooLarge) throw onTooLarge();
  try {
    return JSON.parse(bounded.text);
  } catch {
    return null;
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

function normalizeScope(scope) {
  if (isString(scope)) {
    return scope.trim();
  }
  if (Array.isArray(scope)) {
    return scope.filter((item) => isString(item) && item.trim()).join(',');
  }
  return '';
}

function readExpiresAt(expiresIn, now = Date.now()) {
  const seconds = readFiniteNumber(expiresIn);
  if (seconds == null || seconds <= 0) {
    return now + 24 * 60 * 60 * 1000;
  }
  return now + Math.floor(seconds) * 1000;
}

function parseTokenPayload(payload) {
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
    expiresAt: readExpiresAt(payload.expires_in),
    scope: normalizeScope(payload.scope),
  };
}

async function postForm(url, body) {
  const { response, signal } = await fetchWithDeadline(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  }, LINEAR_TOKEN_TIMEOUT_MS, tokenTimeoutError);
  const payload = await readJsonWithDeadline(response, signal, tokenTimeoutError,
    () => new LinearOAuthError('Linear token response exceeded the size limit', 'LINEAR_OAUTH_FAILED'));
  if (!response.ok) {
    const description = isPlainObject(payload)
      ? (readTrimmedString(payload.error_description) || readTrimmedString(payload.error))
      : '';
    const error = new LinearOAuthError(
      description || `Linear token request failed (${response.status})`,
      readTrimmedString(payload?.error).toUpperCase() || 'LINEAR_OAUTH_FAILED',
    );
    error.status = response.status;
    throw error;
  }
  return parseTokenPayload(payload);
}

async function readJsonResponse(response, signal, fallbackMessage) {
  const payload = await readJsonWithDeadline(response, signal, brokerTimeoutError,
    () => new LinearOAuthError(`${fallbackMessage}: response exceeded the size limit`, 'LINEAR_BROKER_FAILED'));
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

function brokerCallbackUrl(brokerUrl) {
  return `${brokerUrl.replace(/\/+$/, '')}/callback`;
}

async function registerBrokerTransaction({ brokerUrl, state, claimSecret }) {
  const { response, signal } = await fetchWithDeadline(`${brokerUrl}/start`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, claimSecret }),
  }, LINEAR_BROKER_TIMEOUT_MS, brokerTimeoutError);
  const payload = await readJsonResponse(response, signal, 'Could not start Linear authorization broker');
  const redirectUri = readTrimmedString(payload.redirectUri);
  if (!redirectUri || redirectUri !== brokerCallbackUrl(brokerUrl)) {
    throw new LinearOAuthError('Linear authorization broker returned an unexpected callback URL', 'LINEAR_BROKER_FAILED');
  }
  return redirectUri;
}

export async function startAuthorization({ origin } = {}) {
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

async function pollBrokerState(state, pending) {
  const { response, signal } = await fetchWithDeadline(`${pending.broker.url}/poll`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, claimSecret: pending.broker.claimSecret }),
  }, LINEAR_BROKER_TIMEOUT_MS, brokerTimeoutError);
  if (response.status === 202) {
    return null;
  }
  const payload = await readJsonResponse(response, signal, 'Could not read Linear authorization result');
  const status = readTrimmedString(payload.status);
  if (status === 'complete') {
    const result = await consumeAuthorizationCallback({ code: payload.code, state });
    return {
      ...result,
      brokerReceipt: { state, ...pending.broker },
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

export async function completeAuthorizationBroker(receipt) {
  if (!receipt?.url || !receipt?.state || !receipt?.claimSecret) return false;
  const { response } = await fetchWithDeadline(`${receipt.url}/complete`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: receipt.state, claimSecret: receipt.claimSecret }),
  }, LINEAR_BROKER_TIMEOUT_MS, brokerTimeoutError);
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
      poll = pollBrokerState(state, pending).finally(() => brokerPollsByState.delete(state));
      brokerPollsByState.set(state, poll);
    }
    const result = await poll;
    if (result) return result;
  }
  return null;
}

function failAuthorization(message, code, origin) {
  const error = new LinearOAuthError(message, code);
  if (origin) {
    error.origin = origin;
  }
  return error;
}

export async function consumeAuthorizationCallback({ code, state, error, errorDescription }) {
  pruneExpiredPending();
  const pending = readTrimmedString(state) ? pendingByState.get(state) : null;

  if (readTrimmedString(error)) {
    if (readTrimmedString(state)) pendingByState.delete(state);
    throw failAuthorization(
      readTrimmedString(errorDescription) || readTrimmedString(error),
      readTrimmedString(error).toUpperCase(),
      pending?.origin,
    );
  }
  if (!readTrimmedString(code)) {
    if (readTrimmedString(state)) pendingByState.delete(state);
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

  const body = {
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
    pendingByState.delete(state);
    return {
      ...tokens,
      origin: pending.origin,
    };
  } catch (caught) {
    if (caught instanceof Error) {
      caught.origin = pending.origin;
    }
    throw caught;
  }
}

export async function refreshAccessToken(refreshToken) {
  const token = readTrimmedString(refreshToken);
  if (!token) {
    throw new LinearOAuthError('refresh_token is required', 'MISSING_REFRESH_TOKEN');
  }
  const body = {
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

export async function revokeToken(token, tokenTypeHint) {
  const value = readTrimmedString(token);
  if (!value) {
    return false;
  }
  const body = { token: value };
  if (tokenTypeHint === 'access_token' || tokenTypeHint === 'refresh_token') {
    body.token_type_hint = tokenTypeHint;
  }
  try {
    const response = await fetch(LINEAR_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(LINEAR_TOKEN_TIMEOUT_MS),
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
