import {
  getLinearAuth,
  getLinearAuthByWorkspaceId,
  setLinearAuth,
  clearLinearAuth,
  isLinearAccessTokenStale,
  readLinearVaultToken,
} from './auth.js';
import { refreshAccessToken } from './oauth.js';
import { isPlainObject, readTrimmedString } from './parse.js';
import { readBoundedResponseText } from '../shared/response-body.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
// GraphQL calls run inside request handlers and background tracked-item
// refreshes. Without a deadline a stalled connection holds those open forever.
const LINEAR_GRAPHQL_TIMEOUT_MS = 10_000;
// List/search pages request 50 issue summaries with labels, parent data, and 20
// child states each. Get/update also include a description, 50 comments, and up
// to 100 subissues. Give these data responses more room than OAuth JSON while
// keeping each in-flight response bounded, matching the repo's 16 MiB catalog cap.
const LINEAR_GRAPHQL_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const VIEWER_QUERY = '{ viewer { id name displayName email avatarUrl } organization { id name urlKey } }';
// Linear file URLs in GraphQL need this header or the browser cannot load
// uploads.linear.app images (comment screenshots, description images).
const LINEAR_PUBLIC_FILE_URL_TTL_SECONDS = '3600';

export class LinearApiError extends Error {
  constructor(message, status, options = {}) {
    super(message);
    this.name = 'LinearApiError';
    this.status = status;
    this.userError = options.userError === true;
  }
}

// AbortSignal.timeout aborts with a TimeoutError DOMException; a body read cut
// off by the same deadline may surface as an AbortError instead.
function isTimeoutAbort(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

function graphqlTimeoutError() {
  return new LinearApiError('Linear GraphQL request timed out', 504);
}

function readGraphqlError(payload) {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors.length > 0 && isPlainObject(errors[0]) ? errors[0] : null;
  if (!first) {
    return { message: '', userError: false, status: 502 };
  }
  const extensions = isPlainObject(first.extensions) ? first.extensions : null;
  const presentable = extensions ? readTrimmedString(extensions.userPresentableMessage) : '';
  let constraint = '';
  const validationErrors = extensions && Array.isArray(extensions.validationErrors)
    ? extensions.validationErrors
    : [];
  for (const entry of validationErrors) {
    if (!isPlainObject(entry) || !isPlainObject(entry.constraints)) continue;
    for (const value of Object.values(entry.constraints)) {
      const text = readTrimmedString(value);
      if (text) {
        constraint = text;
        break;
      }
    }
    if (constraint) break;
  }
  const message = presentable || constraint || readTrimmedString(first.message);
  const code = extensions ? readTrimmedString(extensions.code) : '';
  const userError = extensions?.userError === true
    || code === 'INVALID_INPUT'
    || code === 'INPUT_ERROR'
    || /^entity not found/i.test(message)
    || /^argument validation/i.test(message);
  return {
    message,
    userError,
    status: userError ? 400 : 502,
  };
}

function readIdentity(payload) {
  const data = isPlainObject(payload) ? payload.data : null;
  const viewer = isPlainObject(data) ? data.viewer : null;
  if (!isPlainObject(viewer) || !readTrimmedString(viewer.id)) {
    return null;
  }
  const organization = isPlainObject(data) ? data.organization : null;
  const organizationId = isPlainObject(organization) ? readTrimmedString(organization.id) : '';
  const organizationName = isPlainObject(organization) ? readTrimmedString(organization.name) : '';
  return {
    user: {
      id: viewer.id.trim(),
      name: readTrimmedString(viewer.name) || null,
      displayName: readTrimmedString(viewer.displayName) || null,
      email: readTrimmedString(viewer.email) || null,
      avatarUrl: readTrimmedString(viewer.avatarUrl) || null,
    },
    organization: organizationId && organizationName
      ? {
        id: organizationId,
        name: organizationName,
        urlKey: readTrimmedString(organization.urlKey) || null,
      }
      : null,
  };
}

// Callers pass either a bare token string (OAuth, sent as Bearer) or an
// authorization object from getValidLinearAuthorization: vault (apiKey)
// credentials send the resolved personal key bare, without Bearer (#304).
function normalizeAuthorization(input) {
  if (isPlainObject(input)) {
    const token = readTrimmedString(input.token);
    if (!token) {
      return null;
    }
    return { token, source: (input.source === 'vault' || input.kind === 'apiKey') ? 'vault' : 'oauth' };
  }
  const token = readTrimmedString(input);
  return token ? { token, source: 'oauth' } : null;
}

export async function fetchLinearGraphql(authorization, query, variables) {
  const authz = normalizeAuthorization(authorization);
  if (!authz) {
    throw new LinearApiError('Linear is not connected', 401);
  }
  const token = authz.token;

  const body = { query };
  if (isPlainObject(variables)) {
    body.variables = variables;
  }

  const signal = AbortSignal.timeout(LINEAR_GRAPHQL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authz.source === 'vault' ? token : `Bearer ${token}`,
        'public-file-urls-expire-in': LINEAR_PUBLIC_FILE_URL_TTL_SECONDS,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isTimeoutAbort(error)) throw graphqlTimeoutError();
    throw error;
  }
  let payload;
  let bodyTooLarge = false;
  try {
    const bounded = await readBoundedResponseText(response, LINEAR_GRAPHQL_RESPONSE_MAX_BYTES);
    bodyTooLarge = bounded.tooLarge;
    if (!bodyTooLarge) {
      const text = bounded.text.charCodeAt(0) === 0xfeff
        ? bounded.text.slice(1)
        : bounded.text;
      payload = JSON.parse(text);
    }
  } catch (error) {
    if (isTimeoutAbort(error) || signal.aborted) throw graphqlTimeoutError();
    payload = null;
  }
  if (response.status === 401) {
    throw new LinearApiError('Linear token expired or revoked', 401);
  }
  if (!response.ok) {
    throw new LinearApiError(`Linear GraphQL request failed (${response.status})`, response.status);
  }
  if (bodyTooLarge) {
    throw new LinearApiError('Linear GraphQL response exceeded the size limit', 502);
  }
  if (!isPlainObject(payload)) {
    throw new LinearApiError('Linear GraphQL response was not JSON', 502);
  }
  const data = isPlainObject(payload.data) ? payload.data : null;
  if (!data) {
    const graphqlError = readGraphqlError(payload);
    throw new LinearApiError(
      graphqlError.message || 'Linear GraphQL response did not include data',
      graphqlError.status,
      { userError: graphqlError.userError },
    );
  }
  return data;
}

export async function fetchLinearIdentity(authorization) {
  const data = await fetchLinearGraphql(authorization, VIEWER_QUERY);
  const identity = readIdentity({ data });
  if (!identity) {
    throw new LinearApiError('Linear GraphQL response did not include a viewer', 502);
  }
  return identity;
}

const inFlightRefreshByWorkspace = new Map();

async function refreshWorkspaceAuth(auth) {
  const tokens = await refreshAccessToken(auth.refreshToken);
  const next = setLinearAuth({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || auth.refreshToken,
    tokenType: tokens.tokenType,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope || auth.scope,
    user: auth.user,
    organization: auth.organization,
    workspaceId: auth.workspaceId,
  }, { activate: false });
  return next.accessToken;
}

export async function getValidLinearAccessToken(workspaceId) {
  const auth = workspaceId
    ? getLinearAuthByWorkspaceId(workspaceId)
    : getLinearAuth();
  if (!auth) {
    return null;
  }
  if (auth.tokenReference) {
    // Vault credential: resolve at call time; the key lives in memory only.
    // An unresolvable reference is a connect error, not a silent 401 loop.
    const outcome = await readLinearVaultToken(auth.tokenReference);
    if (!outcome?.ok) {
      throw new LinearApiError(
        `Linear vault credential could not be read (${outcome?.reason || 'vault-unavailable'})`,
        502,
      );
    }
    return outcome.value;
  }
  if (!auth.accessToken) {
    return null;
  }
  if (!isLinearAccessTokenStale(auth.expiresAt)) {
    return auth.accessToken;
  }
  if (!auth.refreshToken) {
    clearLinearAuth(auth.workspaceId);
    return null;
  }
  const key = auth.workspaceId;
  const pending = inFlightRefreshByWorkspace.get(key);
  if (pending) {
    return pending;
  }
  const promise = refreshWorkspaceAuth(auth)
    .catch((error) => {
      if (error?.code === 'INVALID_GRANT' || error?.status === 400 || error?.status === 401) {
        clearLinearAuth(auth.workspaceId);
        return null;
      }
      throw error;
    })
    .finally(() => {
      inFlightRefreshByWorkspace.delete(key);
    });
  inFlightRefreshByWorkspace.set(key, promise);
  return promise;
}

/**
 * The authorization for the current (or named) workspace: `{ token, source }`
 * where source is 'vault' for a 1Password API-key credential (token sent
 * bare) or 'oauth' (token sent as Bearer). Null when not connected.
 */
export async function getValidLinearAuthorization(workspaceId) {
  const auth = workspaceId
    ? getLinearAuthByWorkspaceId(workspaceId)
    : getLinearAuth();
  if (!auth) {
    return null;
  }
  const token = await getValidLinearAccessToken(workspaceId);
  if (!token) {
    return null;
  }
  return {
    token,
    source: auth.tokenReference ? 'vault' : 'oauth',
    workspaceId: auth.workspaceId,
  };
}
