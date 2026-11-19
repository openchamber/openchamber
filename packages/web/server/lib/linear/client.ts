import {
  getLinearAuth,
  getLinearAuthByWorkspaceId,
  setLinearAuth,
  clearLinearAuth,
  isLinearAccessTokenStale,
} from './auth.js';
import { refreshAccessToken } from './oauth.js';
import { isPlainObject, readTrimmedString } from './parse.js';
import type { LinearAuth, LinearOrganization, LinearUser } from './auth.js';

interface LinearGraphqlPayload {
  data?: unknown;
  errors?: unknown;
}

interface LinearIdentity {
  user: LinearUser;
  organization: LinearOrganization | null;
}

export interface LinearGraphqlVariables {
  first?: number;
  after?: unknown;
  filter?: unknown;
  id?: string;
  input?: { stateId?: string; issueId?: string; body?: string };
  term?: string;
}

interface LinearGraphqlRequest {
  query: string;
  variables?: LinearGraphqlVariables;
}

function isViewer(value: unknown): value is { id: string; name?: unknown; displayName?: unknown; email?: unknown; avatarUrl?: unknown } {
  return isPlainObject(value) && Boolean(readTrimmedString(value.id));
}

function canReadRefreshError(value: unknown): value is { code?: unknown; status?: unknown } {
  return value != null;
}

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const VIEWER_QUERY = '{ viewer { id name displayName email avatarUrl } organization { id name urlKey } }';
const LINEAR_PUBLIC_FILE_URL_TTL_SECONDS = '3600';

class LinearApiError extends Error {
  status: number;
  userError: boolean;

  constructor(message: string, status: number, options: { userError?: boolean } = {}) {
    super(message);
    this.name = 'LinearApiError';
    this.status = status;
    this.userError = options.userError === true;
  }
}

function readGraphqlError(payload: LinearGraphqlPayload) {
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

function readIdentity(payload: LinearGraphqlPayload): LinearIdentity | null {
  const data = isPlainObject(payload) ? payload.data : null;
  const viewer = isPlainObject(data) ? data.viewer : null;
  if (!isViewer(viewer)) {
    return null;
  }
  const organization: { id?: unknown; name?: unknown; urlKey?: unknown } | null = isPlainObject(data) && isPlainObject(data.organization) ? data.organization : null;
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
        urlKey: readTrimmedString(organization?.urlKey) || null,
      }
      : null,
  };
}

export async function fetchLinearGraphql(accessToken: string | null | undefined, query: string, variables?: LinearGraphqlVariables) {
  const token = readTrimmedString(accessToken);
  if (!token) {
    throw new LinearApiError('Linear is not connected', 401);
  }

  const body: LinearGraphqlRequest = { query };
  if (isPlainObject(variables)) {
    body.variables = variables;
  }

  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'public-file-urls-expire-in': LINEAR_PUBLIC_FILE_URL_TTL_SECONDS,
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 401) {
    throw new LinearApiError('Linear token expired or revoked', 401);
  }
  if (!response.ok) {
    throw new LinearApiError(`Linear GraphQL request failed (${response.status})`, response.status);
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

export async function fetchLinearIdentity(accessToken: string) {
  const data = await fetchLinearGraphql(accessToken, VIEWER_QUERY);
  const identity = readIdentity({ data });
  if (!identity) {
    throw new LinearApiError('Linear GraphQL response did not include a viewer', 502);
  }
  return identity;
}

const inFlightRefreshByWorkspace = new Map<string, Promise<string | null>>();

async function refreshWorkspaceAuth(auth: LinearAuth) {
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

export async function getValidLinearAccessToken(workspaceId?: string | null) {
  const auth = workspaceId
    ? getLinearAuthByWorkspaceId(workspaceId)
    : getLinearAuth();
  if (!auth?.accessToken) {
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
      if (canReadRefreshError(error) && (error.code === 'INVALID_GRANT' || error.status === 400 || error.status === 401)) {
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
