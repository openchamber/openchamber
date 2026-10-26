import { z } from 'zod';

import {
  resolveHostRequestErrorCode,
  type GuestConnection,
  type GuestRequest,
  type GuestRequestResult,
  type GuestSettings,
  type HostRequestErrorCode,
} from '@openchamber/sdk';

import { runtimeFetch } from '@/lib/runtime-fetch';

const SETTING_KEY = /^[a-z][a-z0-9-]*$/;

const statusSchema = z.object({
  connected: z.boolean(),
  account: z.string(),
  hasClient: z.boolean(),
  settings: z.record(z.string().regex(SETTING_KEY), z.string()),
  redirectUri: z.string().optional(),
});

const startSchema = z.object({
  authorizationUrl: z.string().min(1),
});

const requestResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string(),
});

const requestFailureSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
});

export type GuestRequestProxyResult =
  | { ok: true; result: GuestRequestResult }
  | { ok: false; code: HostRequestErrorCode; message: string };

const requestFailed = (code: HostRequestErrorCode, message: string): GuestRequestProxyResult => ({
  ok: false,
  code,
  message,
});

export const parseGuestRequestProxyResponse = async (
  response: Response,
): Promise<GuestRequestProxyResult> => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = requestFailureSchema.safeParse(body);
    if (!parsed.success) {
      return requestFailed('HOST_REJECTED', 'Request failed.');
    }
    return requestFailed(
      resolveHostRequestErrorCode(parsed.data.error),
      parsed.data.message ?? parsed.data.error,
    );
  }
  const parsed = requestResultSchema.safeParse(body);
  if (!parsed.success) {
    return requestFailed('HOST_REJECTED', 'Request failed.');
  }
  return { ok: true, result: parsed.data };
};

export type GuestOauthStatus = {
  connection: GuestConnection;
  settings: GuestSettings;
  hasClient: boolean;
  redirectUri: string;
};

const toStatus = (parsed: z.infer<typeof statusSchema>): GuestOauthStatus => ({
  connection: { connected: parsed.connected, account: parsed.account },
  settings: parsed.settings,
  hasClient: parsed.hasClient,
  redirectUri: parsed.redirectUri ?? '',
});

const parseStatus = async (response: Response): Promise<GuestOauthStatus | null> => {
  if (!response.ok) {
    return null;
  }
  const parsed = statusSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? toStatus(parsed.data) : null;
};

export const loadGuestOauthStatus = async (guestId: string): Promise<GuestOauthStatus | null> => {
  try {
    return await parseStatus(await runtimeFetch(`/api/guests/${guestId}/oauth/status`));
  } catch {
    return null;
  }
};

type GuestOauthClientBody = {
  clientId: string;
  clientSecret?: string;
};

export const saveGuestOauthClient = async (
  guestId: string,
  clientId: string,
  clientSecret?: string,
): Promise<GuestOauthStatus | null> => {
  const body: GuestOauthClientBody = { clientId };
  if (clientSecret) {
    body.clientSecret = clientSecret;
  }
  try {
    return await parseStatus(await runtimeFetch(`/api/guests/${guestId}/oauth/client`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  } catch {
    return null;
  }
};

export const saveGuestAccessToken = async (
  guestId: string,
  token: string,
  username?: string,
): Promise<GuestOauthStatus | null> => {
  try {
    return await parseStatus(await runtimeFetch(`/api/guests/${guestId}/token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(username ? { token, username } : { token }),
    }));
  } catch {
    return null;
  }
};

export const saveGuestSettings = async (
  guestId: string,
  settings: GuestSettings,
): Promise<GuestOauthStatus | null> => {
  try {
    return await parseStatus(await runtimeFetch(`/api/guests/${guestId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }));
  } catch {
    return null;
  }
};

export const startGuestOauth = async (guestId: string): Promise<string | null> => {
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/oauth/start`, { method: 'POST' });
    if (!response.ok) {
      return null;
    }
    const parsed = startSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.authorizationUrl : null;
  } catch {
    return null;
  }
};

export const disconnectGuestOauth = async (guestId: string): Promise<GuestOauthStatus | null> => {
  try {
    return await parseStatus(await runtimeFetch(`/api/guests/${guestId}/oauth`, { method: 'DELETE' }));
  } catch {
    return null;
  }
};

export const AUTHORIZATION_WATCH_MS = 3 * 60_000;
export const AUTHORIZATION_POLL_MS = 1_500;

export const guestAuthorizationCompleted = (
  previous: GuestOauthStatus['connection'],
  next: GuestOauthStatus['connection'],
): boolean => {
  if (!next.connected) {
    return false;
  }
  if (!previous.connected) {
    return true;
  }
  return next.account !== previous.account;
};

export const proxyGuestRequest = async (
  guestId: string,
  request: GuestRequest,
): Promise<GuestRequestProxyResult> => {
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return parseGuestRequestProxyResponse(response);
  } catch {
    return requestFailed('HOST_REJECTED', 'Request failed.');
  }
};
