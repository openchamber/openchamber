import {
  GUEST_REQUEST_RESPONSE_MAX,
  GUEST_REQUEST_TIMEOUT_MS,
  isGuestRequestPath,
  resolveIntegrationApi,
} from '@openchamber/sdk';

import { dropGuestTokens } from './auth-store.js';
import { resolveHostAccessToken } from './host-session.js';
import { GuestOAuthError, guestAuthorizationHeader, refreshGuestAccessToken, takeUsableGuestAuth } from './oauth.js';
import { readBoundedResponseText } from './response-body.js';
import type { GuestRecord, JsonObject } from './contracts.js';
import type { TrackerRegistry } from '../trackers/tracker-contract.js';
import { isString } from './input-guards.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
type AuthorizedHeaders = { Accept: string; Authorization: string; 'Content-Type'?: string };

export const joinGuestRequestUrl = (apiOrigin: string | null, path: string, query?: JsonObject) => {
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
      if (!isString(value)) {
        return null;
      }
      url.searchParams.set(key, value);
    }
  }
  return url;
};

const readCappedBody = async (response: Response) => {
  const body = await readBoundedResponseText(response, GUEST_REQUEST_RESPONSE_MAX);
  if (body.tooLarge) {
    throw new GuestOAuthError(
      `The API answered with more than ${GUEST_REQUEST_RESPONSE_MAX} bytes. Ask for a smaller page.`,
      'RESPONSE_TOO_LARGE',
    );
  }
  return body.text;
};

const sendAuthorized = async (url: URL, method: string, body: string | undefined, accessToken: string, authorization: string) => {
  const headers: AuthorizedHeaders = {
    Accept: 'application/json',
    Authorization: guestAuthorizationHeader(accessToken, authorization),
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  const request: RequestInit = {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(GUEST_REQUEST_TIMEOUT_MS),
  };
  if (method !== 'GET' && body !== undefined) request.body = body;
  return fetch(url, request);
};

export const proxyGuestRequest = async ({ guest, trackers = null, persistPath, method, path, query, body }: {
  guest: GuestRecord;
  trackers?: TrackerRegistry | null;
  persistPath: string;
  method: string;
  path: string;
  query?: JsonObject | undefined;
  body?: string | undefined;
}) => {
  const api = guest.integration ? resolveIntegrationApi(guest.integration) : null;
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
  const hostToken = await resolveHostAccessToken(guest.integration, trackers);
  const stored = hostToken ? null : await takeUsableGuestAuth(guest, persistPath);
  let accessToken = hostToken ?? stored?.accessToken;
  if (!accessToken) {
    throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
  }

  let response = await sendAuthorized(url, method, body, accessToken, api.authorization);
  if (response.status === 401) {
    const refreshed = hostToken
      ? await resolveHostAccessToken(guest.integration, trackers)
      : await refreshGuestAccessToken({ guest, persistPath }).catch(() => null);
    const refusedWith = accessToken;
    const dropRefused = () => dropGuestTokens(guest.id, persistPath, (current) => current?.accessToken === refusedWith);
    if (!refreshed || refreshed === accessToken) {
      if (!hostToken) {
        await dropRefused();
      }
      throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
    }
    accessToken = refreshed;
    response = await sendAuthorized(url, method, body, accessToken, api.authorization);
    if (response.status === 401) {
      if (!hostToken) {
        await dropGuestTokens(guest.id, persistPath, (current) => current?.accessToken === refreshed);
      }
      throw new GuestOAuthError('Not connected.', 'DISCONNECTED');
    }
  }

  return {
    status: response.status,
    body: await readCappedBody(response),
  };
};
