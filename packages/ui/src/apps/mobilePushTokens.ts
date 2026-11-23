import { z } from 'zod';

import type { ApnsTokenPayload } from '@/lib/api/push';
import { isCapacitorApp } from '@/lib/platform';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getRuntimeKey } from '@/lib/runtime-switch';

import {
  RELAY_CONNECT_TIMEOUT_MS,
  connectedRuntimeTunnelFor,
  directCandidates,
  normalizeConnectionUrl,
  pushServerIdOf,
  readConnectionHeaders,
  readConnections,
  readHealthServerId,
  relayCandidateOf,
  requestWithTimeout,
  secureTokenKeyOf,
  type MobileSavedConnection,
} from './mobileConnections';
import { fetchThroughRelayOnce } from './mobileRelayFetch';
import { deleteSecureToken, readSecureToken, writeSecureToken } from './mobileSecureStorage';
import { mobileHeadersForUrl, type MobileRequestHeaders } from './mobileRequestHeaders';

let lastPushTokenForSavedConnections: string | null = null;
let pushRequests: Promise<unknown> = Promise.resolve();

const inPushRequestOrder = <T,>(run: () => Promise<T>): Promise<T> => {
  const next = pushRequests.then(run, run);
  pushRequests = next.catch(() => undefined);
  return next;
};

const MOBILE_PUSH_TOKEN_STORAGE_KEY = 'native-push-token';
const storedPushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.string().optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  pushKey: z.string().optional(),
});

export const loadStoredPushToken = async (): Promise<ApnsTokenPayload | null> => {
  if (!isCapacitorApp()) return null;
  const raw = await readSecureToken(MOBILE_PUSH_TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = storedPushTokenSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

type SavedConnectionRequest = {
  token?: string;
  requestHeaders?: MobileRequestHeaders;
};

type SavedConnectionResponse = { ok: boolean; status: number } | null;

const prepareSavedConnectionRequest = async (connection: MobileSavedConnection): Promise<SavedConnectionRequest | null> => {
  let token: string | undefined;
  if (isCapacitorApp()) {
    if (connection.hasToken) {
      token = await readSecureToken(secureTokenKeyOf(connection));
      if (!token) return null;
    }
  } else {
    token = connection.clientToken;
    if (!token && connection.hasToken) return null;
  }
  try {
    return { token, requestHeaders: await readConnectionHeaders(connection) };
  } catch {
    return null;
  }
};

const requestSavedConnection = async (
  connection: MobileSavedConnection,
  path: string,
  init: RequestInit,
  prepared: SavedConnectionRequest,
): Promise<SavedConnectionResponse> => {
  const baseHeaders = new Headers(init.headers);
  const expectedServerId = pushServerIdOf(connection);
  let lastResponse: SavedConnectionResponse = null;
  for (const candidate of directCandidates(connection)) {
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const proxyHeaders = mobileHeadersForUrl(url, prepared.requestHeaders);
    const redirect = Object.keys(proxyHeaders).length ? 'error' : undefined;
    const candidateHeaders = new Headers(baseHeaders);
    for (const [name, value] of Object.entries(proxyHeaders)) candidateHeaders.set(name, value);
    if (expectedServerId) {
      const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers: candidateHeaders, redirect });
      if (!health?.ok) continue;
      const reported = await readHealthServerId(health);
      if (reported && reported !== expectedServerId) continue;
    }
    if (prepared.token) candidateHeaders.set('Authorization', `Bearer ${prepared.token}`);
    const response = await requestWithTimeout(`${url}${path}`, { ...init, headers: candidateHeaders, redirect });
    if (response) {
      lastResponse = { ok: response.ok, status: response.status };
      if (response.ok) return lastResponse;
    }
  }

  const relay = relayCandidateOf(connection);
  if (!relay) return lastResponse;
  const runtimeTunnel = connectedRuntimeTunnelFor(relay);
  const tunnel = runtimeTunnel ?? createRelayTunnelClient(relay);
  const relayHeaders = new Headers(baseHeaders);
  if (prepared.token) relayHeaders.set('Authorization', `Bearer ${prepared.token}`);
  try {
    const { response } = await fetchThroughRelayOnce(tunnel, path, { ...init, headers: relayHeaders }, RELAY_CONNECT_TIMEOUT_MS);
    return response ? { ok: response.ok, status: response.status } : lastResponse;
  } finally {
    if (!runtimeTunnel) tunnel.close();
  }
};

const sendPushTokenToSavedConnection = async (
  connection: MobileSavedConnection,
  action: 'register' | 'unregister',
  payload: ApnsTokenPayload,
): Promise<boolean> => {
  const prepared = await prepareSavedConnectionRequest(connection);
  if (!prepared) return false;
  const response = await requestSavedConnection(connection, '/api/push/apns-token', {
    method: action === 'register' ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  }, prepared);
  return response?.ok === true;
};

export const syncPushTokenToSavedConnections = async (
  payload: ApnsTokenPayload,
  action: 'register' | 'unregister',
): Promise<boolean> => {
  if (action === 'register') {
    lastPushTokenForSavedConnections = payload.token;
    if (isCapacitorApp()) await writeSecureToken(MOBILE_PUSH_TOKEN_STORAGE_KEY, JSON.stringify(payload));
  } else if (lastPushTokenForSavedConnections === payload.token) {
    lastPushTokenForSavedConnections = null;
  }

  return inPushRequestOrder(async () => {
    const connections = readConnections();
    const runtimeKey = getRuntimeKey();
    const results = await Promise.all(connections.map((connection) =>
      sendPushTokenToSavedConnection(connection, action, payload).catch(() => false)));
    if (action === 'unregister' && isCapacitorApp() && results.every(Boolean)) {
      await deleteSecureToken(MOBILE_PUSH_TOKEN_STORAGE_KEY);
    }
    return connections.some((connection, index) => results[index] && secureTokenKeyOf(connection) === runtimeKey);
  });
};

export const nativePushHasTarget = (activeDelivery: { localOnly: boolean } | null | undefined): boolean => {
  if (activeDelivery?.localOnly !== true) return true;
  const runtimeKey = getRuntimeKey();
  return readConnections().some((connection) => secureTokenKeyOf(connection) !== runtimeKey);
};

export const forgetPushTokenForConnection = async (connection: MobileSavedConnection): Promise<void> => {
  const deviceToken = lastPushTokenForSavedConnections ?? (await loadStoredPushToken())?.token ?? null;
  if (!deviceToken) return;
  const prepared = await prepareSavedConnectionRequest(connection);
  if (!prepared) return;
  void inPushRequestOrder(() => requestSavedConnection(connection, '/api/push/apns-token', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ token: deviceToken }),
  }, prepared)).catch(() => undefined);
};
