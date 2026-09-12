import {
  GUEST_REQUEST_RESPONSE_MAX,
  GUEST_REQUEST_TIMEOUT_MS,
  isGuestRequestPath,
  resolveIntegrationApi,
} from '@openchamber/sdk';

import { dropGuestTokens, getGuestAuth } from './auth-store.js';
import { resolveHostAccessToken } from './host-session.js';
import { GuestOAuthError, guestAuthorizationHeader, refreshGuestAccessToken } from './oauth.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const joinGuestRequestUrl = (apiOrigin, path, query) => {
  if (!isGuestRequestPath(path)) {
    return null;
  }
  let url;
  try {
    url = new URL(path, `${apiOrigin}/`);
  } catch {
    return null;
  }
  if (url.origin !== apiOrigin) {
    return null;
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        return null;
      }
      url.searchParams.set(key, value);
    }
  }
  return url;
};

const readCappedBody = async (response) => {
  const text = await response.text();
  if (text.length <= GUEST_REQUEST_RESPONSE_MAX) {
    return text;
  }
  return text.slice(0, GUEST_REQUEST_RESPONSE_MAX);
};

const sendAuthorized = async (url, method, body, accessToken, authorization) => {
  const headers = {
    Accept: 'application/json',
    Authorization: guestAuthorizationHeader(accessToken, authorization),
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, {
    method,
    headers,
    body: method === 'GET' || body === undefined ? undefined : body,
    redirect: 'manual',
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  });
};

export const proxyGuestRequest = async ({ guest, persistPath, method, path, query, body }) => {
  const api = resolveIntegrationApi(guest.integration ?? {});
  if (!api) {
    throw new GuestOAuthError('This guest does not declare an API origin.', 'NO_INTEGRATION');
  }
  if (!METHODS.has(method)) {
    throw new GuestOAuthError('Unsupported request method.', 'BAD_METHOD');
  }
  const url = joinGuestRequestUrl(api.apiOrigin, path, query);
  if (!url) {
    throw new GuestOAuthError('Request path must stay on the declared apiOrigin.', 'BAD_PATH');
  }
  const hostToken = await resolveHostAccessToken(guest.integration);
  const stored = await getGuestAuth(guest.id, persistPath);
  let accessToken = hostToken ?? stored?.accessToken;
  if (!accessToken) {
    throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
  }

  let response = await sendAuthorized(url, method, body, accessToken, api.authorization);
  if (response.status === 401) {
    const refreshed = hostToken
      ? await resolveHostAccessToken(guest.integration)
      : await refreshGuestAccessToken({ guest, persistPath }).catch(() => null);
    if (!refreshed || refreshed === accessToken) {
      if (!hostToken) {
        await dropGuestTokens(guest.id, persistPath);
      }
      throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
    }
    accessToken = refreshed;
    response = await sendAuthorized(url, method, body, accessToken, api.authorization);
    if (response.status === 401) {
      if (!hostToken) {
        await dropGuestTokens(guest.id, persistPath);
      }
      throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
    }
  }

  return {
    status: response.status,
    body: await readCappedBody(response),
  };
};
