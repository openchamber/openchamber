
import { Capacitor } from '@capacitor/core';
import React from 'react';
import { z } from 'zod';

import { useI18n } from '@/lib/i18n';
import type { PairingConnectionPayload, PairingEndpointCandidate } from '@/lib/connectionPayload';
import { isCapacitorApp } from '@/lib/platform';
import { adoptRelayTunnel, getActiveRelayDescriptor, getActiveRelayTunnel, isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient, isRelayLimitReached } from '@/lib/relay/tunnel-client';
import { addRuntimeProxyHeaders, fetchBypassingRuntimeBridge, runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

import { recordMobileConnectDebug } from './mobileConnectionDebug';
import { KEYCHAIN_ACCESS_WHEN_UNLOCKED, MOBILE_SECURE_STORAGE_PREFIX, deleteSecureHeaders, deleteSecureToken, logDetail, logStorage, nativeSecure, readSecureToken, withTimeout, writeSecureToken } from './mobileSecureStorage';
import { fetchThroughRelayOnce, fetchThroughRelayWithRetry } from './mobileRelayFetch';
import { mobileHeadersForUrl, mobileRequestHeadersSchema, type MobileRequestHeaders } from './mobileRequestHeaders';

const MOBILE_CONNECTIONS_STORAGE_KEY = 'openchamber.mobile.connections.v1';
export const MOBILE_CONNECTIONS_CHANGED_EVENT = 'openchamber:mobile-connections-changed';

const notifyConnectionsChanged = (): void => void window.dispatchEvent(new Event(MOBILE_CONNECTIONS_CHANGED_EVENT));
const MOBILE_DEVICE_ID_STORAGE_KEY = 'openchamber.mobile.deviceId';
const mobileHeadersKeySchema = z.string().startsWith(`${MOBILE_SECURE_STORAGE_PREFIX}headers.`);

const pushServerIdSchema = z.string().trim().min(1);

const getMobileDeviceId = (): string => {
  try {
    const existing = window.localStorage.getItem(MOBILE_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
    const generated = crypto.randomUUID();
    window.localStorage.setItem(MOBILE_DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return crypto.randomUUID();
  }
};

const mobileClientDedupeKey = (): string => `mobile:${getMobileDeviceId()}`;

const mobileDevicePlatform = (): string | undefined => {
  try {
    const platform = Capacitor.getPlatform();
    return platform === 'ios' || platform === 'android' ? platform : undefined;
  } catch {
    return undefined;
  }
};
const MOBILE_CONNECTIONS_LIMIT = 12;
const MOBILE_CONNECT_TIMEOUT_MS = 8000;
const MOBILE_NATIVE_HTTP_TIMEOUT_MS = 2500;
const MOBILE_FAST_PROBE_TIMEOUT_MS = 2500;

export const createMobilePasswordOperationTracker = () => {
  let current = 0;
  return {
    begin: (): number => {
      current += 1;
      return current;
    },
    cancel: (): void => {
      current += 1;
    },
    isCurrent: (operation: number): boolean => operation === current,
  };
};

export type MobileRelayConfig = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

type MobileTransportCandidate =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig };

export type MobileSavedConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  serverId?: string;
  pushServerId?: string;
  lastUsedAt: number;
  hasToken?: boolean;
  clientToken?: string;
  requestHeadersKey?: string;
  requestHeaders?: MobileRequestHeaders;
};

type MobilePendingConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  serverId?: string;
  relay?: MobileRelayConfig;
  relayGrant?: string;
  requestHeaders?: MobileRequestHeaders;
};

type MobileConnectInput = {
  id?: string;
  url?: string;
  candidates?: MobileTransportCandidate[];
  clientToken?: string;
  label?: string;
  relay?: MobileRelayConfig;
  relayGrant?: string;
  requestHeaders?: Record<string, string>;
};

type MobileFetchResponse = {
  ok: boolean;
  status: number;
  source: 'native-http' | 'browser-fetch';
  json: () => Promise<unknown>;
};

type MobileSessionStatus = {
  authenticated?: boolean;
  disabled?: boolean;
  scope?: string;
};

type PairingRedeemResponse = {
  ok?: boolean;
  clientToken?: unknown;
  client?: { label?: unknown } | null;
  server?: { label?: unknown; url?: unknown } | null;
};


export const normalizeConnectionUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
};

const getConnectionLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const getConnectionStorageKey = (url: string): string => {
  try {
    return normalizeConnectionUrl(url);
  } catch {
    return url.trim().replace(/\/+$/g, '');
  }
};

const isSameConnectionUrl = (left: string, right: string): boolean =>
  getConnectionStorageKey(left) === getConnectionStorageKey(right);


const relayConnectionRuntimeKey = (relay: MobileRelayConfig): string =>
  `relay:${relay.serverId}@${relay.relayUrl.trim()}`;

const canonicalRelayUrl = (relay: MobileRelayConfig): string => `relay://${relay.serverId}`;

export const directCandidates = (connection: { candidates: MobileTransportCandidate[] }): Array<{ kind: 'direct'; url: string }> =>
  connection.candidates.filter((c): c is { kind: 'direct'; url: string } => c.kind === 'direct');

export const relayCandidateOf = (connection: { candidates: MobileTransportCandidate[] }): MobileRelayConfig | null => {
  const found = connection.candidates.find((c) => c.kind === 'relay');
  return found && found.kind === 'relay' ? found.relay : null;
};

export const connectionDisplayUrl = (connection: { candidates: MobileTransportCandidate[] }): string => {
  const direct = directCandidates(connection)[0];
  if (direct) return direct.url;
  const relay = relayCandidateOf(connection);
  return relay ? canonicalRelayUrl(relay) : '';
};

type MobileConnectionIdentity = { candidates: MobileTransportCandidate[]; serverId?: string; pushServerId?: string };

const authServerIdOf = (connection: MobileConnectionIdentity): string | null =>
  connection.serverId || relayCandidateOf(connection)?.serverId || null;

export const pushServerIdOf = (connection: MobileConnectionIdentity): string | null =>
  authServerIdOf(connection) || connection.pushServerId || null;

export const secureTokenKeyOf = (connection: MobileConnectionIdentity): string => {
  const relay = relayCandidateOf(connection);
  if (relay) return relayConnectionRuntimeKey(relay);
  if (connection.serverId) return `server:${connection.serverId}`;
  const direct = directCandidates(connection)[0];
  return direct ? getConnectionStorageKey(direct.url) : '';
};

const isSameDevice = (a: MobileConnectionIdentity, b: MobileConnectionIdentity): boolean => {
  const aServerId = authServerIdOf(a);
  const bServerId = authServerIdOf(b);
  if (aServerId && bServerId) return aServerId === bServerId;
  return candidateSetsMatch(a.candidates, b.candidates);
};

const candidateSetsMatch = (a: MobileTransportCandidate[], b: MobileTransportCandidate[]): boolean => {
  const aRelay = a.find((c) => c.kind === 'relay');
  const aServerId = aRelay && aRelay.kind === 'relay' ? aRelay.relay.serverId : null;
  const aUrls = new Set(a.filter((c) => c.kind === 'direct').map((c) => getConnectionStorageKey((c as { url: string }).url)));
  return b.some((c) => {
    if (c.kind === 'relay') return aServerId !== null && c.relay.serverId === aServerId;
    return aUrls.has(getConnectionStorageKey(c.url));
  });
};

const directCandidatesFromUrl = (url: string): MobileTransportCandidate[] => {
  const normalized = (() => {
    try {
      return normalizeConnectionUrl(url);
    } catch {
      return '';
    }
  })();
  return normalized ? [{ kind: 'direct', url: normalized }] : [];
};

const buildCandidatesFromInput = (input: MobileConnectInput): MobileTransportCandidate[] => {
  if (input.candidates && input.candidates.length > 0) return input.candidates;
  const list: MobileTransportCandidate[] = [];
  if (typeof input.url === 'string' && input.url.trim() && !/^relay:\/\//i.test(input.url.trim())) {
    list.push(...directCandidatesFromUrl(input.url));
  }
  if (input.relay) list.push({ kind: 'relay', relay: input.relay });
  return list;
};

const parseRelayConfig = (value: unknown): MobileRelayConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.relayUrl !== 'string' || !record.relayUrl.trim()) return null;
  if (typeof record.serverId !== 'string' || !record.serverId.trim()) return null;
  const jwk = record.hostEncPubJwk;
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  const key = jwk as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return null;
  if (typeof key.x !== 'string' || !key.x || typeof key.y !== 'string' || !key.y) return null;
  return {
    relayUrl: record.relayUrl,
    serverId: record.serverId,
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
  };
};


const logConnect = (step: string, detail: Record<string, unknown> = {}): void => {
  const serialized = logDetail(detail);
  console.info('[mobile-connect]', step, serialized);
  recordMobileConnectDebug(step, serialized);
};

export const logMobileConnectEvent = (step: string, detail: Record<string, unknown> = {}): void => {
  logConnect(step, detail);
};

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const getJsonRequestData = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') return body ?? undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

const nativeHttpRequest = async (url: string, init?: RequestInit): Promise<MobileFetchResponse | null> => {
  if (!isCapacitorApp()) return null;
  try {
    const { CapacitorHttp } = await import('@capacitor/core');
    const requestHeaders = addRuntimeProxyHeaders(url, new Headers(init?.headers));
    const response = await CapacitorHttp.request({
      url,
      method: init?.method || 'GET',
      headers: Object.fromEntries(requestHeaders.entries()),
      data: getJsonRequestData(init?.body),
      disableRedirects: init?.redirect === 'error',
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      source: 'native-http',
      json: async () => parseMaybeJson(response.data),
    };
  } catch (error) {
    logConnect('native-http:failed', { url, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
};

const browserFetchRequest = async (url: string, init?: RequestInit): Promise<MobileFetchResponse | null> => {
  const response = await fetchBypassingRuntimeBridge(url, init).catch((error) => {
    logConnect('browser-fetch:failed', { url, error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (!response) return null;
  return { ok: response.ok, status: response.status, source: 'browser-fetch', json: () => response.json() };
};

const raceWithTimeout = async <T,>(timeoutMs: number, operation: Promise<T | null>, onTimeout?: () => void): Promise<T | null> => {
  let timeoutId: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => {
      onTimeout?.();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

export const requestWithTimeout = async (
  url: string,
  init?: RequestInit,
  options?: { totalTimeoutMs?: number },
): Promise<MobileFetchResponse | null> => {
  const total = options?.totalTimeoutMs ?? MOBILE_CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  const native = await raceWithTimeout(
    Math.min(MOBILE_NATIVE_HTTP_TIMEOUT_MS, total),
    nativeHttpRequest(url, init),
  );
  if (native) return native;

  const controller = new AbortController();
  const remainingMs = Math.max(500, total - (Date.now() - startedAt));
  return raceWithTimeout(
    remainingMs,
    browserFetchRequest(url, { ...init, signal: controller.signal }),
    () => controller.abort(),
  );
};

const readSessionStatus = async (response: { json: () => Promise<unknown> } | null): Promise<MobileSessionStatus | null> => {
  if (!response) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  return {
    authenticated: typeof record.authenticated === 'boolean' ? record.authenticated : undefined,
    disabled: typeof record.disabled === 'boolean' ? record.disabled : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
};

export const readHealthServerId = async (response: MobileFetchResponse): Promise<string | undefined> => {
  const payload = await response.json().catch(() => null);
  const reported = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).serverId : null;
  return typeof reported === 'string' && reported ? reported : undefined;
};


export const RELAY_CONNECT_TIMEOUT_MS = 15_000;

type RelayProbeOutcome = 'ok' | 'needs-login' | 'auth-failed' | 'unreachable' | 'relay-limit';

type HeldRelayTunnel = { client: ReturnType<typeof createRelayTunnelClient>; owned: boolean };

const releaseHeldRelayTunnel = (tunnel: HeldRelayTunnel | undefined): void => {
  if (tunnel?.owned) tunnel.client.close();
};

type RelayProbeResult = {
  outcome: RelayProbeOutcome;
  tunnel?: HeldRelayTunnel;
};

const relaySessionOutcome = async (session: Response, token: string | undefined): Promise<RelayProbeOutcome> => {
  if (session.status === 401) return token ? 'auth-failed' : 'needs-login';
  if (!session.ok && session.status !== 404) return 'auth-failed';
  const status = await readSessionStatus(session);
  if (status && status.disabled !== true && status.authenticated === false) {
    return token ? 'auth-failed' : 'needs-login';
  }
  return 'ok';
};

const probeRelaySession = async (
  relay: MobileRelayConfig,
  token?: string,
  grant?: string,
  timeoutMs: number = RELAY_CONNECT_TIMEOUT_MS,
  options?: { keepTunnel?: boolean },
): Promise<RelayProbeResult> => {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const runtimeTunnel = connectedRuntimeTunnelFor(relay);
  if (runtimeTunnel) {
    const { response: session, failure } = await fetchThroughRelayOnce(runtimeTunnel, '/auth/session', { headers }, timeoutMs);
    logConnect('relay:session', { shared: true, ok: session?.ok === true, status: session?.status ?? null, hasToken: Boolean(token), error: failure });
    if (session) {
      const outcome = await relaySessionOutcome(session, token);
      return outcome === 'ok' && options?.keepTunnel ? { outcome, tunnel: { client: runtimeTunnel, owned: false } } : { outcome };
    }
  }
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(grant ? { grant } : {}),
  });
  try {
    const { response: session, failure } = await fetchThroughRelayWithRetry(tunnel, '/auth/session', { headers }, timeoutMs);
    logConnect('relay:session', { shared: false, ok: session?.ok === true, status: session?.status ?? null, hasToken: Boolean(token), error: failure });
    const outcome = session
      ? await relaySessionOutcome(session, token)
      : isRelayLimitReached(tunnel.getStatus()) ? 'relay-limit' : 'unreachable';
    if (outcome === 'ok' && options?.keepTunnel) return { outcome, tunnel: { client: tunnel, owned: true } };
    tunnel.close();
    return { outcome };
  } catch (error) {
    tunnel.close();
    throw error;
  }
};

const switchToRelayRuntime = (
  relay: MobileRelayConfig,
  clientToken: string | null,
  grant?: string,
  runtimeKey?: string,
  liveTunnel?: ReturnType<typeof createRelayTunnelClient>,
): void => {
  const apiBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const descriptor = {
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(grant ? { grant } : {}),
  };
  if (liveTunnel) {
    adoptRelayTunnel(descriptor, liveTunnel);
  }
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken,
    runtimeKey: runtimeKey ?? relayConnectionRuntimeKey(relay),
    relay: descriptor,
  });
};


const parseCandidate = (value: unknown): MobileTransportCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.kind === 'direct') {
    return typeof c.url === 'string' && c.url.trim() ? { kind: 'direct', url: c.url } : null;
  }
  if (c.kind === 'relay') {
    const relay = parseRelayConfig(c.relay);
    return relay ? { kind: 'relay', relay } : null;
  }
  return null;
};

const migrateLegacyCandidates = (c: Record<string, unknown>): MobileTransportCandidate[] => {
  if (c.mode === 'relay') {
    const relay = parseRelayConfig(c.relay);
    return relay ? [{ kind: 'relay', relay }] : [];
  }
  return typeof c.url === 'string' ? directCandidatesFromUrl(c.url) : [];
};

export const readConnections = (): MobileSavedConnection[] => {
  if (typeof window === 'undefined') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(window.localStorage.getItem(MOBILE_CONNECTIONS_STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const native = isCapacitorApp();
  return parsed
    .flatMap((item): MobileSavedConnection[] => {
      if (!item || typeof item !== 'object') return [];
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string') return [];
      const candidates = Array.isArray(c.candidates)
        ? c.candidates.map(parseCandidate).filter((x): x is MobileTransportCandidate => Boolean(x))
        : migrateLegacyCandidates(c);
      if (candidates.length === 0) return [];
      const inlineToken = typeof c.clientToken === 'string' && c.clientToken.trim() ? c.clientToken : undefined;
      const label = typeof c.label === 'string' && c.label.trim() ? c.label : getConnectionLabel(connectionDisplayUrl({ candidates }));
      const base: MobileSavedConnection = {
        id: c.id,
        label,
        candidates,
        serverId: typeof c.serverId === 'string' && c.serverId.trim() ? c.serverId : undefined,
        pushServerId: pushServerIdSchema.safeParse(c.pushServerId).data,
        lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : 0,
        requestHeadersKey: native ? mobileHeadersKeySchema.safeParse(c.requestHeadersKey).data : undefined,
        requestHeaders: native ? undefined : mobileRequestHeadersSchema.safeParse(c.requestHeaders).data,
      };
      if (native) return [{ ...base, hasToken: Boolean(c.hasToken) || Boolean(inlineToken) }];
      return [{ ...base, clientToken: inlineToken, hasToken: Boolean(inlineToken) }];
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
};

const serializeCandidate = (c: MobileTransportCandidate): unknown =>
  c.kind === 'relay'
    ? { kind: 'relay', relay: { relayUrl: c.relay.relayUrl, serverId: c.relay.serverId, hostEncPubJwk: c.relay.hostEncPubJwk } }
    : { kind: 'direct', url: c.url };

const writeConnections = (connections: MobileSavedConnection[]): boolean => {
  if (typeof window === 'undefined') return false;
  const native = isCapacitorApp();
  const serialized = connections.slice(0, MOBILE_CONNECTIONS_LIMIT).map((c) => {
    const shared = {
      id: c.id,
      label: c.label,
      candidates: c.candidates.map(serializeCandidate),
      serverId: c.serverId,
      pushServerId: c.pushServerId,
      lastUsedAt: c.lastUsedAt,
    };
    return native
      ? { ...shared, hasToken: Boolean(c.hasToken || c.clientToken), requestHeadersKey: c.requestHeadersKey }
      : { ...shared, clientToken: c.clientToken, requestHeaders: c.requestHeaders };
  });
  try {
    window.localStorage.setItem(MOBILE_CONNECTIONS_STORAGE_KEY, JSON.stringify(serialized));
    notifyConnectionsChanged();
    return true;
  } catch (error) {
    console.warn('[mobile-storage] failed to persist connection metadata', error);
    return false;
  }
};

const upsertConnectionInList = (
  connections: MobileSavedConnection[],
  draft: { id?: string; label: string; candidates: MobileTransportCandidate[]; serverId?: string; pushServerId?: string; clientToken?: string; hasToken?: boolean },
): MobileSavedConnection[] => {
  const existing = (draft.id ? connections.find((item) => item.id === draft.id) : undefined)
    ?? connections.find((item) => isSameDevice(item, draft));
  const native = isCapacitorApp();
  const next: MobileSavedConnection = {
    id: draft.id || existing?.id || crypto.randomUUID(),
    label: draft.label,
    candidates: draft.candidates,
    serverId: draft.serverId ?? existing?.serverId,
    pushServerId: draft.pushServerId ?? existing?.pushServerId,
    requestHeadersKey: existing?.requestHeadersKey,
    requestHeaders: existing?.requestHeaders,
    lastUsedAt: Date.now(),
    ...(native
      ? { hasToken: draft.hasToken ?? (Boolean(draft.clientToken) || existing?.hasToken || false) }
      : { clientToken: draft.clientToken ?? existing?.clientToken, hasToken: Boolean(draft.clientToken ?? existing?.clientToken) }),
  };
  return [
    next,
    ...connections.filter((item) => item.id !== next.id && !isSameDevice(item, next)),
  ].slice(0, MOBILE_CONNECTIONS_LIMIT);
};


class MobileHeaderStorageError extends Error {
  constructor() { super('Mobile header storage unavailable'); }
}

export const readConnectionHeaders = async (connection?: MobileSavedConnection): Promise<MobileRequestHeaders | undefined> => {
  if (!connection) return undefined;
  if (!isCapacitorApp()) return connection.requestHeaders;
  const prefixedKey = connection.requestHeadersKey;
  if (!prefixedKey) return undefined;
  const data = await withTimeout(nativeSecure.internalGetItem({ prefixedKey, sync: false }).then((result) => result.data), null);
  if (!data) throw new MobileHeaderStorageError();
  try {
    const headers = mobileRequestHeadersSchema.parse(JSON.parse(data));
    normalizeConnectionUrl(headers.url);
    mobileHeadersForUrl(headers.url, headers);
    return headers;
  } catch {
    throw new MobileHeaderStorageError();
  }
};

export const loadMobileConnectionHeaders = async (id: string): Promise<MobileRequestHeaders | undefined> =>
  readConnectionHeaders(readConnections().find((connection) => connection.id === id));

const resolveConnectionHeaders = async (
  input: MobileConnectInput,
  candidates: MobileTransportCandidate[],
  saved?: MobileSavedConnection,
): Promise<MobileRequestHeaders | undefined> => {
  if (input.requestHeaders === undefined) return readConnectionHeaders(saved);
  const url = normalizeConnectionUrl(input.url || connectionDisplayUrl({ candidates }));
  const values = mobileHeadersForUrl(url, { url, values: input.requestHeaders });
  return Object.keys(values).length ? { url, values } : undefined;
};


export const migrateLegacyInlineTokenRecords = async (
  records: unknown[],
  migrateToken: (url: string, token: string) => Promise<boolean>,
): Promise<{ records: unknown[]; migrated: number; failed: number }> => {
  let migrated = 0;
  let failed = 0;
  const next = await Promise.all(records.map(async (item) => {
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : null;
    const token = typeof record.clientToken === 'string' ? record.clientToken.trim() : '';
    if (!url || !token) return item;
    if (!await migrateToken(url, token)) {
      failed += 1;
      return item;
    }
    migrated += 1;
    const { clientToken: _removed, ...metadata } = record;
    void _removed;
    return { ...metadata, hasToken: true };
  }));
  return { records: next, migrated, failed };
};

const migrateLegacyInlineTokens = async (): Promise<void> => {
  if (typeof window === 'undefined' || !isCapacitorApp()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(window.localStorage.getItem(MOBILE_CONNECTIONS_STORAGE_KEY) || '[]');
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const legacy = parsed.filter((item): item is { url: string; clientToken: string } =>
    Boolean(item) && typeof item === 'object'
    && typeof (item as { url?: unknown }).url === 'string'
    && typeof (item as { clientToken?: unknown }).clientToken === 'string'
    && Boolean((item as { clientToken: string }).clientToken.trim()));
  if (legacy.length === 0) return;
  logStorage('secure:migrate-start', { count: legacy.length });
  const result = await migrateLegacyInlineTokenRecords(parsed, async (url, token) => {
    const key = getConnectionStorageKey(url);
    if (!await writeSecureToken(key, token)) return false;
    return await readSecureToken(key) === token;
  });
  if (result.migrated > 0) {
    try {
      window.localStorage.setItem(MOBILE_CONNECTIONS_STORAGE_KEY, JSON.stringify(result.records));
    } catch (error) {
      console.warn('[mobile-storage] failed to finalize secure token migration', error);
      return;
    }
  }
  logStorage('secure:migrate-done', { migrated: result.migrated, failed: result.failed });
};

export const loadMobileConnections = async (): Promise<MobileSavedConnection[]> => {
  await migrateLegacyInlineTokens();
  return readConnections();
};

const persistMobileConnection = async (
  connection: { id?: string; label: string; candidates: MobileTransportCandidate[]; serverId?: string; pushServerId?: string; clientToken?: string; requestHeaders?: MobileRequestHeaders | null },
): Promise<MobileSavedConnection[]> => {
  let newHeadersKey: string | undefined;
  if (isCapacitorApp() && connection.requestHeaders) {
    const prefixedKey = `${MOBILE_SECURE_STORAGE_PREFIX}headers.${crypto.randomUUID()}`;
    const ok = await withTimeout(nativeSecure.internalSetItem({ prefixedKey, data: JSON.stringify(connection.requestHeaders), sync: false, access: KEYCHAIN_ACCESS_WHEN_UNLOCKED }).then(() => true), false);
    if (!ok) throw new MobileHeaderStorageError();
    newHeadersKey = prefixedKey;
  }
  const previous = readConnections();
  const next = upsertConnectionInList(previous, connection);
  if (connection.requestHeaders !== undefined) {
    next[0].requestHeadersKey = newHeadersKey;
    next[0].requestHeaders = isCapacitorApp() ? undefined : connection.requestHeaders ?? undefined;
  }
  if (!writeConnections(next)) {
    if (newHeadersKey) await deleteSecureHeaders(newHeadersKey);
    throw new MobileHeaderStorageError();
  }
  for (const item of previous) {
    if (item.requestHeadersKey && !next.some((saved) => saved.requestHeadersKey === item.requestHeadersKey)) {
      await deleteSecureHeaders(item.requestHeadersKey);
    }
  }
  return next;
};

export const upsertMobileConnection = async (
  connection: Parameters<typeof persistMobileConnection>[0],
): Promise<MobileSavedConnection[]> => {
  const next = await persistMobileConnection(connection);
  if (isCapacitorApp() && connection.clientToken) {
    await writeSecureToken(secureTokenKeyOf(next[0]), connection.clientToken);
    notifyConnectionsChanged();
  }
  return next;
};

const deleteMobileConnection = async (id: string): Promise<MobileSavedConnection[]> => {
  const connections = readConnections();
  const removed = connections.find((connection) => connection.id === id) ?? null;
  const next = connections.filter((connection) => connection.id !== id);
  if (!writeConnections(next)) throw new MobileHeaderStorageError();
  if (removed?.requestHeadersKey) await deleteSecureHeaders(removed.requestHeadersKey);
  if (removed && isCapacitorApp()) await deleteSecureToken(secureTokenKeyOf(removed));
  if (removed) writeLastTransport(secureTokenKeyOf(removed), null);
  return next;
};

type ChosenTransport =
  | { kind: 'direct'; url: string; serverId?: string }
  | { kind: 'relay'; relay: MobileRelayConfig; tunnel?: HeldRelayTunnel };

const directServerIdOf = (transport: ChosenTransport): string | undefined => (transport.kind === 'direct' ? transport.serverId : undefined);

type ProbeResult =
  | { status: 'ok'; transport: ChosenTransport }
  | { status: 'needs-login' }
  | { status: 'unreachable' }
  | { status: 'relay-limit' };

const RELAY_RACE_HEADSTART_MS = 1_500;

const MOBILE_LAST_TRANSPORT_STORAGE_KEY = 'openchamber.mobile.lastTransport.v1';

const lastTransportSchema = z.enum(['direct', 'relay']);

const readLastTransports = (): Map<string, z.infer<typeof lastTransportSchema>> => {
  const transports = new Map<string, z.infer<typeof lastTransportSchema>>();
  if (typeof window === 'undefined') return transports;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(MOBILE_LAST_TRANSPORT_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return transports;
    for (const [runtimeKey, value] of Object.entries(parsed)) {
      const kind = lastTransportSchema.safeParse(value);
      if (kind.success) transports.set(runtimeKey, kind.data);
    }
  } catch {
    // An unreadable record reads as none.
  }
  return transports;
};

const writeLastTransport = (runtimeKey: string, kind: ChosenTransport['kind'] | null): void => {
  const next = readLastTransports();
  if (kind) next.set(runtimeKey, kind);
  else next.delete(runtimeKey);
  try {
    window.localStorage.setItem(MOBILE_LAST_TRANSPORT_STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Without the record the next launch gives direct its head start, as before.
  }
};

const probeConnectionCandidates = async (
  candidates: MobileTransportCandidate[],
  token: string | undefined,
  options?: { fast?: boolean; requestHeaders?: MobileRequestHeaders; relayFirst?: boolean; expectedServerId?: string },
): Promise<ProbeResult> => {
  const requestOptions = options?.fast ? { totalTimeoutMs: MOBILE_FAST_PROBE_TIMEOUT_MS } : undefined;
  const expectedServerId = options?.expectedServerId ?? relayCandidateOf({ candidates })?.serverId ?? null;
  const relayCandidate = candidates.find((c): c is Extract<MobileTransportCandidate, { kind: 'relay' }> => c.kind === 'relay') ?? null;
  const directList = candidates.filter((c): c is Extract<MobileTransportCandidate, { kind: 'direct' }> => c.kind === 'direct');

  const probeDirectChain = async (): Promise<ProbeResult> => {
    const directProbes = directList.map((candidate) => {
      const url = normalizeConnectionUrl(candidate.url) || candidate.url;
      const headers = mobileHeadersForUrl(url, options?.requestHeaders);
      const redirect: RequestRedirect | undefined = Object.keys(headers).length ? 'error' : undefined;
      const health = requestWithTimeout(`${url}/health`, { method: 'GET', headers: mobileHeadersForUrl(url, options?.requestHeaders), redirect }, requestOptions);
      return { url, headers, redirect, health };
    });
    for (const probe of directProbes) {
      const { url, headers, redirect } = probe;
      if (token) headers.Authorization = `Bearer ${token}`;
      const health = await probe.health;
      logConnect('probe:direct:health', { url, ok: health?.ok === true, status: health?.status ?? null, source: health?.source ?? null });
      if (!health?.ok) continue;
      const reportedServerId = await readHealthServerId(health);
      if (expectedServerId && reportedServerId && reportedServerId !== expectedServerId) {
        logConnect('probe:server-id-mismatch', { url });
        continue;
      }
      const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: token ? 'omit' : 'include', headers, redirect }, requestOptions);
      logConnect('probe:direct:session', { url, ok: session?.ok === true, status: session?.status ?? null, source: session?.source ?? null, hasToken: Boolean(token) });
      if (session?.status === 401) return { status: 'needs-login' };
      if (!session || (!session.ok && session.status !== 404)) continue;
      const status = await readSessionStatus(session);
      if (status && status.disabled !== true && status.authenticated === false) return { status: 'needs-login' };
      const authDisabled = status?.disabled === true;
      if (!token && isCapacitorApp() && !authDisabled && status?.scope !== 'client') return { status: 'needs-login' };
      return { status: 'ok', transport: { kind: 'direct', url, serverId: reportedServerId } };
    }
    return { status: 'unreachable' };
  };

  const probeRelay = async (): Promise<ProbeResult> => {
    if (!relayCandidate) return { status: 'unreachable' };
    const { outcome, tunnel } = await probeRelaySession(
      relayCandidate.relay,
      token,
      undefined,
      options?.fast ? MOBILE_FAST_PROBE_TIMEOUT_MS : MOBILE_CONNECT_TIMEOUT_MS,
      { keepTunnel: true },
    );
    if (outcome === 'ok') return { status: 'ok', transport: { kind: 'relay', relay: relayCandidate.relay, tunnel } };
    if (outcome === 'needs-login' || outcome === 'auth-failed') return { status: 'needs-login' };
    if (outcome === 'relay-limit') return { status: 'relay-limit' };
    return { status: 'unreachable' };
  };

  if (!relayCandidate) return probeDirectChain();
  if (directList.length === 0) return probeRelay();

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let relayCancelled = false;
    let headstartTimer: number | undefined;
    let directResult: ProbeResult | null = null;
    let relayResult: ProbeResult | null = null;

    const closeUnusedRelayTunnel = (result: ProbeResult | null) => {
      if (result?.status === 'ok' && result.transport.kind === 'relay') releaseHeldRelayTunnel(result.transport.tunnel);
    };
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const startRelayProbe = () => {
      if (relayCancelled || settled) return;
      if (headstartTimer !== undefined) {
        window.clearTimeout(headstartTimer);
        headstartTimer = undefined;
      }
      void probeRelay().then((result) => {
        relayResult = result;
        if (settled || relayCancelled) {
          closeUnusedRelayTunnel(result);
          return;
        }
        if (result.status === 'ok' || result.status === 'needs-login') {
          finish(result);
          return;
        }
        if (directResult) finish(result);
      });
    };

    void probeDirectChain().then((result) => {
      directResult = result;
      if (settled) return;
      if (result.status === 'ok' || result.status === 'needs-login') {
        relayCancelled = true;
        if (headstartTimer !== undefined) window.clearTimeout(headstartTimer);
        closeUnusedRelayTunnel(relayResult);
        finish(result);
        return;
      }
      if (relayResult) {
        finish(relayResult);
        return;
      }
      startRelayProbe();
    });

    if (options?.relayFirst) startRelayProbe();
    else headstartTimer = window.setTimeout(startRelayProbe, RELAY_RACE_HEADSTART_MS);
  });
};

const switchToTransport = (
  transport: ChosenTransport,
  token: string | null,
  options?: { runtimeKey?: string; grant?: string; requestHeaders?: MobileRequestHeaders },
): void => {
  autoConnectSuppressed = false;
  if (options?.runtimeKey) writeLastTransport(options.runtimeKey, transport.kind);
  if (transport.kind === 'relay') {
    switchToRelayRuntime(transport.relay, token, options?.grant, options?.runtimeKey, transport.tunnel?.client);
  } else {
    switchRuntimeEndpoint({ apiBaseUrl: transport.url, clientToken: token, runtimeKey: options?.runtimeKey, requestHeaders: mobileHeadersForUrl(transport.url, options?.requestHeaders) });
  }
  scheduleCandidateRefresh();
};

export const getAutoConnectTargetLabel = (): string | null => {
  const candidate = readConnections()[0];
  return candidate?.label?.trim() ? candidate.label : null;
};

export type AutoConnectOutcome =
  | { status: 'connected' }
  | { status: 'no-candidate' }
  | { status: 'unreachable'; label: string }
  | { status: 'relay-limit'; label: string }
  | { status: 'needs-login'; label: string };

let autoConnectSuppressed = false;

export const suppressAutoConnectUntilManualConnect = (): void => {
  autoConnectSuppressed = true;
};

let connectionSelectionGeneration = 0;
let notificationSwitchCount = 0;

const connectSavedConnection = async (
  candidate: MobileSavedConnection,
  options: { fast: boolean; skipIfConnected?: boolean; selectionGeneration?: number; allowDuringNotificationSwitch?: boolean; expectedServerId?: string },
): Promise<AutoConnectOutcome> => {
  let token: string | undefined;
  if (isCapacitorApp()) {
    if (candidate.hasToken) {
      token = await readSecureToken(secureTokenKeyOf(candidate));
      if (!token) return { status: 'no-candidate' };
    }
  } else {
    token = candidate.clientToken;
    if (!token && candidate.hasToken) return { status: 'no-candidate' };
  }

  let requestHeaders: MobileRequestHeaders | undefined;
  try {
    requestHeaders = await readConnectionHeaders(candidate);
  } catch {
    return { status: 'unreachable', label: candidate.label };
  }
  const relayFirst = readLastTransports().get(secureTokenKeyOf(candidate)) === 'relay';
  const result = await probeConnectionCandidates(candidate.candidates, token, { fast: options.fast, requestHeaders, relayFirst, expectedServerId: options.expectedServerId });
  logConnect('auto-connect:probe', { status: result.status, candidates: candidate.candidates.map((c) => c.kind), relayFirst });
  if (result.status === 'needs-login') return { status: 'needs-login', label: candidate.label };
  if (result.status === 'relay-limit') return { status: 'relay-limit', label: candidate.label };
  if (result.status !== 'ok') return { status: 'unreachable', label: candidate.label };
  const isSuperseded = (options.selectionGeneration !== undefined
    && options.selectionGeneration !== connectionSelectionGeneration)
    || (!options.allowDuringNotificationSwitch && notificationSwitchCount > 0);
  if (isSuperseded || (options.skipIfConnected && getRuntimeApiBaseUrl())) {
    if (result.transport.kind === 'relay') releaseHeldRelayTunnel(result.transport.tunnel);
    logConnect('auto-connect:superseded', {});
    return { status: 'no-candidate' };
  }
  try {
    await upsertMobileConnection({ id: candidate.id, label: candidate.label, candidates: candidate.candidates, pushServerId: directServerIdOf(result.transport) });
  } catch {
    if (result.transport.kind === 'relay') releaseHeldRelayTunnel(result.transport.tunnel);
    return { status: 'unreachable', label: candidate.label };
  }
  switchToTransport(result.transport, token ?? null, { runtimeKey: secureTokenKeyOf(candidate), requestHeaders });
  return { status: 'connected' };
};

export const autoConnectLastInstance = async (options?: { fast?: boolean; skipIfConnected?: boolean }): Promise<AutoConnectOutcome> => {
  const selectionGeneration = connectionSelectionGeneration;
  if (autoConnectSuppressed || notificationSwitchCount > 0) {
    logConnect('auto-connect:suppressed', {});
    return { status: 'no-candidate' };
  }
  const fast = options?.fast !== false;
  await migrateLegacyInlineTokens();
  const candidate = readConnections()[0];
  logConnect('auto-connect:start', { hasCandidate: Boolean(candidate), fast });
  if (!candidate) return { status: 'no-candidate' };
  return connectSavedConnection(candidate, {
    fast,
    skipIfConnected: options?.skipIfConnected,
    selectionGeneration,
  });
};

export type SavedInstanceSwitchOutcome = 'active' | 'switched' | 'unavailable';

const savedConnectionsAnsweringAs = async (serverId: string): Promise<MobileSavedConnection[]> => {
  const answers = await Promise.all(readConnections().filter((entry) => !pushServerIdOf(entry)).map(async (entry) => {
    const requestHeaders = await readConnectionHeaders(entry).catch(() => undefined);
    for (const candidate of directCandidates(entry)) {
      const url = normalizeConnectionUrl(candidate.url) || candidate.url;
      const headers = mobileHeadersForUrl(url, requestHeaders);
      const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers, redirect: Object.keys(headers).length ? 'error' : undefined });
      if (health?.ok && await readHealthServerId(health) === serverId) return [entry];
    }
    return [];
  }));
  return answers.flat();
};

export const switchToSavedInstance = async (serverId: string): Promise<SavedInstanceSwitchOutcome> => {
  if (!serverId) return 'unavailable';
  await migrateLegacyInlineTokens();
  const identified = readConnections().filter((entry) => pushServerIdOf(entry) === serverId);
  const connections = identified.length > 0 ? identified : await savedConnectionsAnsweringAs(serverId);
  if (connections.length === 0) {
    logConnect('notification:switch-missing', { serverId });
    return 'unavailable';
  }
  connectionSelectionGeneration += 1;
  if (connections.some((connection) => secureTokenKeyOf(connection) === getRuntimeKey())) return 'active';
  const selectionGeneration = connectionSelectionGeneration;
  notificationSwitchCount += 1;
  try {
    for (const connection of connections) {
      if (selectionGeneration !== connectionSelectionGeneration) return 'unavailable';
      const outcome = await connectSavedConnection(connection, {
        fast: false,
        selectionGeneration,
        allowDuringNotificationSwitch: true,
        expectedServerId: serverId,
      });
      logConnect('notification:switch', { serverId, status: outcome.status });
      if (outcome.status === 'connected') return 'switched';
    }
    return 'unavailable';
  } finally {
    notificationSwitchCount = Math.max(0, notificationSwitchCount - 1);
  }
};

export const validateMobileConnectionSession = async (input: {
  url: string;
  clientToken?: string | null;
  requestHeaders?: MobileRequestHeaders;
}, options?: { fast?: boolean }): Promise<boolean> => {
  let url = '';
  try {
    url = normalizeConnectionUrl(input.url);
  } catch {
    return false;
  }
  if (!url) return false;

  const token = input.clientToken?.trim() || undefined;
  const headers = mobileHeadersForUrl(url, input.requestHeaders);
  const redirect = Object.keys(headers).length ? 'error' : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestOptions = options?.fast ? { totalTimeoutMs: MOBILE_FAST_PROBE_TIMEOUT_MS } : undefined;

  const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers, redirect }, requestOptions);
  if (!health?.ok) return false;

  const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: token ? 'omit' : 'include', headers, redirect }, requestOptions);
  if (!session || (!session.ok && session.status !== 404)) return false;

  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

type LiveTransport =
  | { kind: 'direct'; url: string; serverId?: string }
  | { kind: 'relay'; relay: MobileRelayConfig; tunnel: ReturnType<typeof createRelayTunnelClient>; owned: boolean };

const releaseLiveTransport = (transport: LiveTransport | null, adopted: boolean): void => {
  if (transport?.kind === 'relay' && transport.owned && !adopted) transport.tunnel.close();
};

const sameHostKey = (left: JsonWebKey, right: JsonWebKey): boolean =>
  left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;

export const connectedRuntimeTunnelFor = (relay: MobileRelayConfig): ReturnType<typeof createRelayTunnelClient> | null => {
  const tunnel = getActiveRelayTunnel();
  const active = getActiveRelayDescriptor();
  if (!tunnel || !active || tunnel.getStatus().state !== 'connected') return null;
  const sameServer = active.relayUrl === relay.relayUrl
    && active.serverId === relay.serverId
    && sameHostKey(active.hostEncPubJwk, relay.hostEncPubJwk);
  return sameServer ? tunnel : null;
};

const pairingCandidatesToMobile = (candidates: PairingEndpointCandidate[]): MobileTransportCandidate[] =>
  [...candidates]
    .sort((left, right) => {
      const delta = (left.priority ?? 100) - (right.priority ?? 100);
      if (delta !== 0) return delta;
      const rank = (c: PairingEndpointCandidate): number => (c.type === 'relay' ? 2 : c.url.startsWith('https://') ? 0 : 1);
      return rank(left) - rank(right);
    })
    .flatMap((c): MobileTransportCandidate[] => {
      if (c.type === 'relay') {
        const relay = parseRelayConfig({ relayUrl: c.relayUrl, serverId: c.serverId, hostEncPubJwk: c.hostEncPubJwk });
        return relay ? [{ kind: 'relay', relay }] : [];
      }
      return directCandidatesFromUrl(c.url);
    });

const establishLiveTransport = async (
  candidates: MobileTransportCandidate[],
  requestHeaders?: MobileRequestHeaders,
): Promise<LiveTransport | 'relay-limit' | null> => {
  let relayLimited = false;
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      const runtimeTunnel = connectedRuntimeTunnelFor(candidate.relay);
      if (runtimeTunnel) {
        const shared = await fetchThroughRelayOnce(runtimeTunnel, '/health', undefined, MOBILE_CONNECT_TIMEOUT_MS);
        logConnect('establish:relay:health', { shared: true, ok: shared.response?.ok === true, status: shared.response?.status ?? null, error: shared.failure });
        if (shared.response?.ok) return { kind: 'relay', relay: candidate.relay, tunnel: runtimeTunnel, owned: false };
      }
      const tunnel = createRelayTunnelClient(candidate.relay);
      const { response: health, failure } = await fetchThroughRelayWithRetry(tunnel, '/health', undefined, RELAY_CONNECT_TIMEOUT_MS);
      logConnect('establish:relay:health', { shared: false, ok: health?.ok === true, status: health?.status ?? null, error: failure });
      if (health?.ok) return { kind: 'relay', relay: candidate.relay, tunnel, owned: true };
      relayLimited ||= isRelayLimitReached(tunnel.getStatus());
      tunnel.close();
      continue;
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const headers = mobileHeadersForUrl(url, requestHeaders);
    const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers, redirect: Object.keys(headers).length ? 'error' : undefined });
    logConnect('establish:direct:health', { ok: health?.ok === true, status: health?.status ?? null });
    if (!health?.ok) continue;
    const serverId = await readHealthServerId(health);
    if (expectedServerId && serverId && serverId !== expectedServerId) {
      logConnect('establish:server-id-mismatch', { url });
      continue;
    }
    return { kind: 'direct', url, serverId };
  }
  return relayLimited ? 'relay-limit' : null;
};

type ActiveSessionCheck = 'valid' | 'invalid' | 'relay-limit';

const validateActiveRuntimeSession = async (input: {
  url: string;
  clientToken?: string | null;
  requestHeaders?: MobileRequestHeaders;
}, options?: { fast?: boolean }): Promise<ActiveSessionCheck> => {
  if (!isRelayModeActive()) return await validateMobileConnectionSession(input, options) ? 'valid' : 'invalid';
  const session = await raceWithTimeout(
    options?.fast ? MOBILE_FAST_PROBE_TIMEOUT_MS : RELAY_CONNECT_TIMEOUT_MS,
    runtimeFetch('/auth/session').then((response): Response | null => response).catch(() => null),
  );
  if (!session) return isRelayLimitReached(getActiveRelayTunnel()?.getStatus()) ? 'relay-limit' : 'valid';
  if (session.status === 401) return 'invalid';
  if (!session.ok && session.status !== 404) return 'valid';
  const status = await readSessionStatus(session);
  return status && status.disabled !== true && status.authenticated === false ? 'invalid' : 'valid';
};

const transportMatchesCurrentRuntime = (transport: ChosenTransport): boolean =>
  transport.kind === 'relay'
    ? isRelayModeActive()
    : !isRelayModeActive() && isSameConnectionUrl(transport.url, getRuntimeApiBaseUrl());

const findActiveConnection = (): MobileSavedConnection | null => {
  const runtimeKey = getRuntimeKey();
  if (!runtimeKey) return null;
  return readConnections().find((connection) => secureTokenKeyOf(connection) === runtimeKey) ?? null;
};

export const isActiveRuntimeConnection = (connection: MobileSavedConnection): boolean => {
  const runtimeKey = getRuntimeKey();
  return Boolean(runtimeKey) && secureTokenKeyOf(connection) === runtimeKey;
};

type ReprobeOutcome = 'switched' | 'unchanged' | 'unreachable' | 'relay-limit' | 'needs-login' | 'no-connection';

export const reprobeActiveConnection = async (options?: { fast?: boolean }): Promise<ReprobeOutcome> => {
  if (notificationSwitchCount > 0) return 'unchanged';
  const fast = options?.fast !== false;
  const active = findActiveConnection();
  if (!active) {
    logConnect('reprobe:no-connection', { runtimeKey: Boolean(getRuntimeKey()) });
    return 'no-connection';
  }
  const selectionGeneration = connectionSelectionGeneration;

  let token: string | undefined;
  if (isCapacitorApp()) {
    token = active.hasToken ? await readSecureToken(secureTokenKeyOf(active)) : undefined;
  } else {
    token = active.clientToken;
  }
  if (!token && active.hasToken) {
    logConnect('reprobe:no-token', { hasToken: true });
    return 'unreachable';
  }
  logConnect('reprobe:start', { candidates: active.candidates.map((c) => c.kind), fast, hasToken: Boolean(token) });

  const currentIndex = active.candidates.findIndex(
    (candidate) => transportMatchesCurrentRuntime(candidate.kind === 'relay' ? { kind: 'relay', relay: candidate.relay } : { kind: 'direct', url: candidate.url }),
  );

  const higher = currentIndex >= 0 ? active.candidates.slice(0, currentIndex) : active.candidates;
  let requestHeaders: MobileRequestHeaders | undefined;
  try {
    requestHeaders = await readConnectionHeaders(active);
  } catch {
    return 'unreachable';
  }
  const better = await probeConnectionCandidates(higher, token, { fast, requestHeaders });
  logConnect('reprobe:better', { status: better.status, probed: higher.length });
  if (better.status === 'ok') {
    if (selectionGeneration !== connectionSelectionGeneration || notificationSwitchCount > 0) {
      if (better.transport.kind === 'relay') releaseHeldRelayTunnel(better.transport.tunnel);
      return 'unchanged';
    }
    try {
      await upsertMobileConnection({ id: active.id, label: active.label, candidates: active.candidates, pushServerId: directServerIdOf(better.transport) });
    } catch {
      if (better.transport.kind === 'relay') releaseHeldRelayTunnel(better.transport.tunnel);
      return 'unreachable';
    }
    switchToTransport(better.transport, token ?? null, { runtimeKey: secureTokenKeyOf(active), requestHeaders });
    return 'switched';
  }
  if (better.status === 'needs-login') return 'needs-login';

  let current: ActiveSessionCheck | null = null;
  if (currentIndex >= 0) {
    current = await validateActiveRuntimeSession({ url: getRuntimeApiBaseUrl(), clientToken: token, requestHeaders }, { fast });
    logConnect('reprobe:current', { current });
    if (current === 'valid') {
      scheduleCandidateRefresh();
      return 'unchanged';
    }
  }

  const lower = currentIndex >= 0 ? active.candidates.slice(currentIndex + 1) : [];
  const fallback = await probeConnectionCandidates(lower, token, { fast, requestHeaders });
  logConnect('reprobe:fallback', { status: fallback.status, probed: lower.length });
  if (fallback.status === 'ok') {
    if (selectionGeneration !== connectionSelectionGeneration || notificationSwitchCount > 0) {
      if (fallback.transport.kind === 'relay') releaseHeldRelayTunnel(fallback.transport.tunnel);
      return 'unchanged';
    }
    try {
      await upsertMobileConnection({ id: active.id, label: active.label, candidates: active.candidates, pushServerId: directServerIdOf(fallback.transport) });
    } catch {
      if (fallback.transport.kind === 'relay') releaseHeldRelayTunnel(fallback.transport.tunnel);
      return 'unreachable';
    }
    switchToTransport(fallback.transport, token ?? null, { runtimeKey: secureTokenKeyOf(active), requestHeaders });
    return 'switched';
  }
  if (fallback.status === 'needs-login') return 'needs-login';
  if ([better.status, fallback.status, current].includes('relay-limit')) return 'relay-limit';
  return 'unreachable';
};


const CANDIDATE_REFRESH_DELAY_MS = 5_000;

type CandidateRefreshResult = 'updated' | 'unchanged' | 'skipped';

let candidateRefreshInFlight = false;

const refreshActiveConnectionCandidates = async (): Promise<CandidateRefreshResult> => {
  if (candidateRefreshInFlight) return 'skipped';
  const active = findActiveConnection();
  if (!active) {
    logConnect('candidates:refresh-skip', { reason: 'no-active-connection' });
    return 'skipped';
  }
  const relay = relayCandidateOf(active);
  if (!relay) {
    logConnect('candidates:refresh-skip', { reason: 'no-relay-candidate' });
    return 'skipped';
  }
  candidateRefreshInFlight = true;
  try {
    const response = await raceWithTimeout(
      RELAY_CONNECT_TIMEOUT_MS,
      runtimeFetch('/api/client-auth/connection/candidates').then((r): Response | null => r).catch(() => null),
    );
    if (!response?.ok) {
      logConnect('candidates:refresh-skip', { reason: 'fetch-failed', status: response?.status ?? null });
      return 'skipped';
    }
    const payload = await response.json().catch(() => null) as { serverId?: unknown; candidates?: unknown } | null;
    if (!payload || payload.serverId !== relay.serverId) {
      logConnect('candidates:refresh-skip', { reason: 'server-id-mismatch' });
      return 'skipped';
    }
    const reported = Array.isArray(payload.candidates) ? payload.candidates : [];
    const lanUrls: string[] = [];
    for (const entry of reported) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== 'lan' || typeof record.url !== 'string') continue;
      try {
        const url = normalizeConnectionUrl(record.url);
        if (url && !lanUrls.includes(url)) lanUrls.push(url);
      } catch {
        // invalid URL → drop
      }
    }
    if (lanUrls.length === 0) {
      logConnect('candidates:refresh-skip', { reason: 'no-lan-reported' });
      return 'skipped';
    }
    const preservedHttps = directCandidates(active).filter((candidate) => candidate.url.startsWith('https://'));
    const next: MobileTransportCandidate[] = [
      ...lanUrls.map((url): MobileTransportCandidate => ({ kind: 'direct', url })),
      ...preservedHttps,
      { kind: 'relay', relay },
    ];
    const unchanged = JSON.stringify(active.candidates.map(serializeCandidate)) === JSON.stringify(next.map(serializeCandidate));
    if (unchanged) return 'unchanged';
    logConnect('candidates:refreshed', { lanCount: lanUrls.length });
    await upsertMobileConnection({ id: active.id, label: active.label, candidates: next });
    return 'updated';
  } finally {
    candidateRefreshInFlight = false;
  }
};

const scheduleCandidateRefresh = (): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void (async () => {
      const result = await refreshActiveConnectionCandidates().catch((): CandidateRefreshResult => 'skipped');
      logConnect('candidates:refresh-result', { result });
      if (result === 'updated' && isRelayModeActive()) {
        await reprobeActiveConnection().catch(() => null);
      }
    })();
  }, CANDIDATE_REFRESH_DELAY_MS);
};


type UseMobileConnection = {
  connections: MobileSavedConnection[];
  isBusy: boolean;
  isPasswordBusy: boolean;
  error: string | null;
  pendingConnection: MobilePendingConnection | null;
  connect: (input: MobileConnectInput) => Promise<void>;
  redeemPairingConnection: (payload: PairingConnectionPayload) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  cancelPassword: () => void;
  saveConnection: (input: MobileConnectInput) => Promise<MobileSavedConnection | null>;
  removeConnection: (id: string) => Promise<MobileSavedConnection | null>;
  setError: (message: string | null) => void;
};

export const useMobileConnection = (onConnected: () => void): UseMobileConnection => {
  const { t } = useI18n();
  const [connections, setConnections] = React.useState<MobileSavedConnection[]>(() => readConnections());
  const [busyOperation, setBusyOperation] = React.useState<'connect' | 'password' | 'pairing' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = React.useState<MobilePendingConnection | null>(null);
  const connectionsRef = React.useRef(connections);
  const busyRef = React.useRef<'connect' | 'password' | 'pairing' | null>(null);
  const passwordOperationRef = React.useRef(createMobilePasswordOperationTracker());

  const applyConnections = React.useCallback((next: MobileSavedConnection[]) => {
    connectionsRef.current = next;
    setConnections(next);
  }, []);

  const beginBusy = React.useCallback((operation: 'connect' | 'password' | 'pairing') => {
    busyRef.current = operation;
    setBusyOperation(operation);
  }, []);

  const endBusy = React.useCallback((operation: 'connect' | 'password' | 'pairing') => {
    if (busyRef.current !== operation) return;
    busyRef.current = null;
    setBusyOperation(null);
  }, []);

  React.useEffect(() => {
    let disposed = false;
    void loadMobileConnections().then((loaded) => {
      if (!disposed) applyConnections(loaded);
    });
    return () => { disposed = true; };
  }, [applyConnections]);

  const persistMetadata = React.useCallback(async (draft: Parameters<typeof upsertMobileConnection>[0]) => {
    const next = await persistMobileConnection(draft);
    applyConnections(next);
    return next;
  }, [applyConnections]);

  const connect = React.useCallback(async (input: MobileConnectInput) => {
    setError(null);
    beginBusy('connect');
    let heldTunnel: HeldRelayTunnel | undefined;
    try {
      const candidates = buildCandidatesFromInput(input);
      if (candidates.length === 0) {
        setError(t('mobile.connect.error.urlRequired'));
        return;
      }
      const saved = input.id
        ? connectionsRef.current.find((c) => c.id === input.id)
        : connectionsRef.current.find((c) => candidateSetsMatch(c.candidates, candidates));
      const label = input.label?.trim() || saved?.label || getConnectionLabel(connectionDisplayUrl({ candidates }));
      const requestHeaders = await resolveConnectionHeaders(input, candidates, saved);
      const headerUpdate = input.requestHeaders === undefined ? undefined : requestHeaders ?? null;
      const grant = input.relayGrant;
      const tokenKey = secureTokenKeyOf({ candidates, serverId: saved?.serverId });

      let token = input.clientToken?.trim() || undefined;
      const tokenIsNew = Boolean(token);
      if (!token) {
        if (isCapacitorApp()) {
          if (saved?.hasToken) token = await readSecureToken(tokenKey);
        } else {
          token = saved?.clientToken;
        }
      }

      logConnect('connect:start', { candidates: candidates.map((c) => c.kind), hasToken: Boolean(token) });
      const result = await probeConnectionCandidates(candidates, token, { requestHeaders });
      if (result.status === 'ok' && result.transport.kind === 'relay') heldTunnel = result.transport.tunnel;
      logConnect('connect:probe', { status: result.status });

      if (result.status === 'unreachable') {
        setError(t('mobile.connect.error.unreachable'));
        return;
      }
      if (result.status === 'relay-limit') {
        setError(t('mobile.connect.error.relayLimit'));
        return;
      }
      if (result.status === 'needs-login') {
        const next = await persistMetadata({ id: saved?.id, label, candidates, requestHeaders: headerUpdate });
        setPendingConnection({
          id: next[0].id,
          label,
          candidates,
          serverId: saved?.serverId,
          relay: relayCandidateOf({ candidates }) ?? undefined,
          relayGrant: grant,
          requestHeaders,
        });
        return;
      }

      if (token && tokenIsNew && isCapacitorApp()) {
        await writeSecureToken(tokenKey, token);
      }
      await persistMetadata({ id: saved?.id, label, candidates, clientToken: token, pushServerId: directServerIdOf(result.transport), requestHeaders: headerUpdate });
      switchToTransport(result.transport, token ?? null, { runtimeKey: tokenKey, grant, requestHeaders });
      heldTunnel = undefined;
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] connect threw', error);
      setError(t(error instanceof MobileHeaderStorageError ? 'mobile.connect.headers.error' : 'mobile.connect.error.invalidUrl'));
    } finally {
      releaseHeldRelayTunnel(heldTunnel);
      endBusy('connect');
    }
  }, [beginBusy, endBusy, onConnected, persistMetadata, t]);

  const redeemPairingConnection = React.useCallback(async (payload: PairingConnectionPayload) => {
    if (busyRef.current === 'pairing') return;
    setError(null);
    beginBusy('pairing');
    const deviceCandidates = pairingCandidatesToMobile(payload.candidates);
    let chosen: LiveTransport | null = null;
    let adopted = false;
    try {
      const established = await establishLiveTransport(deviceCandidates);
      if (!established || established === 'relay-limit') {
        setError(t(established ? 'mobile.connect.error.relayLimit' : 'mobile.connect.error.unreachable'));
        return;
      }
      chosen = established;

      const redeemBody = JSON.stringify({
        pairingId: payload.pairingId,
        secret: payload.secret,
        clientLabel: 'OpenChamber Mobile',
        clientKind: 'mobile',
        deviceName: 'OpenChamber Mobile',
        devicePlatform: mobileDevicePlatform(),
        dedupeKey: mobileClientDedupeKey(),
      });
      const redeemInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: redeemBody,
      } as const;
      const redeem = chosen.kind === 'relay'
        ? await fetchThroughRelayOnce(chosen.tunnel, '/api/client-auth/pairing/redeem', redeemInit, RELAY_CONNECT_TIMEOUT_MS)
        : { response: await requestWithTimeout(`${chosen.url}/api/client-auth/pairing/redeem`, redeemInit), failure: null };
      const response = redeem.response;
      logConnect('pairing:redeem', { transport: chosen.kind, ok: response?.ok === true, status: response?.status ?? null, error: redeem.failure });
      if (!response?.ok) {
        setError(t('mobile.connect.error.authRequired'));
        return;
      }
      const result = await response.json().catch(() => null) as PairingRedeemResponse | null;
      const issuedToken = typeof result?.clientToken === 'string' ? result.clientToken.trim() : '';
      if (!issuedToken) {
        setError(t('mobile.connect.error.authRequired'));
        return;
      }
      const serverLabel = typeof result?.server?.label === 'string' ? result.server.label : '';
      const label = payload.label || serverLabel || getConnectionLabel(connectionDisplayUrl({ candidates: deviceCandidates }));

      const serverId = chosen.kind === 'direct' ? chosen.serverId : undefined;
      const tokenKey = secureTokenKeyOf({ candidates: deviceCandidates, serverId });
      if (isCapacitorApp()) {
        const stored = await writeSecureToken(tokenKey, issuedToken);
        if (!stored) {
          setError(t('mobile.connect.error.authRequired'));
          return;
        }
      }
      await persistMetadata({ label, candidates: deviceCandidates, serverId, clientToken: issuedToken });
      switchToTransport(
        chosen.kind === 'relay' ? { kind: 'relay', relay: chosen.relay, tunnel: { client: chosen.tunnel, owned: chosen.owned } } : { kind: 'direct', url: chosen.url },
        issuedToken,
        { runtimeKey: tokenKey },
      );
      adopted = chosen.kind === 'relay';
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] pairing threw', error);
      setError(t('mobile.connect.error.authRequired'));
    } finally {
      releaseLiveTransport(chosen, adopted);
      endBusy('pairing');
    }
  }, [beginBusy, endBusy, onConnected, persistMetadata, t]);

  const submitPassword = React.useCallback(async (password: string) => {
    if (!pendingConnection || !password.trim() || busyRef.current === 'password') return;
    setError(null);
    beginBusy('password');
    const operation = passwordOperationRef.current.begin();
    const isCurrentOperation = () => passwordOperationRef.current.isCurrent(operation);
    const { id, label, candidates, serverId, requestHeaders } = pendingConnection;
    const tokenKey = secureTokenKeyOf({ candidates, serverId });
    let chosen: LiveTransport | null = null;
    let adopted = false;
    try {
      const established = await establishLiveTransport(candidates, requestHeaders);
      if (established !== 'relay-limit') chosen = established;
      if (!isCurrentOperation()) return;
      if (!chosen) {
        setError(t(established === 'relay-limit' ? 'mobile.connect.error.relayLimit' : 'mobile.connect.error.unreachable'));
        return;
      }
      const loginHeaders: Record<string, string> = {};
      if (chosen.kind === 'direct') Object.assign(loginHeaders, mobileHeadersForUrl(chosen.url, requestHeaders));
      const redirect: RequestRedirect | undefined = Object.keys(loginHeaders).length ? 'error' : undefined;
      loginHeaders['Content-Type'] = 'application/json';
      loginHeaders.Accept = 'application/json';
      const loginInit = {
        method: 'POST',
        credentials: 'include' as const,
        headers: loginHeaders,
        redirect,
        body: JSON.stringify({ password, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Mobile', clientKind: 'mobile', devicePlatform: mobileDevicePlatform(), dedupeKey: mobileClientDedupeKey() }),
      };
      logConnect('password:start', { transport: chosen.kind });
      const login = chosen.kind === 'relay'
        ? await fetchThroughRelayOnce(chosen.tunnel, '/auth/session', loginInit, RELAY_CONNECT_TIMEOUT_MS)
        : { response: await requestWithTimeout(`${chosen.url}/auth/session`, loginInit), failure: null };
      const response = login.response;
      if (!isCurrentOperation()) return;
      logConnect('password:done', { ok: response?.ok === true, status: response?.status ?? null, error: login.failure });
      if (!response?.ok) {
        setError(t('mobile.connect.error.passwordFailed'));
        return;
      }
      const body = await response.json().catch(() => null) as { clientToken?: unknown } | null;
      if (!isCurrentOperation()) return;
      const issuedToken = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      logConnect('password:token', { issued: Boolean(issuedToken) });

      if (!issuedToken) {
        if (chosen.kind === 'direct' && !isCapacitorApp()) {
          await persistMetadata({ id, label, candidates, pushServerId: chosen.serverId });
          if (!isCurrentOperation()) return;
          setPendingConnection(null);
          switchToTransport({ kind: 'direct', url: chosen.url }, null, { runtimeKey: tokenKey, requestHeaders });
          onConnected();
          return;
        }
        setError(t('mobile.connect.error.authRequired'));
        return;
      }

      if (isCapacitorApp()) {
        if (!isCurrentOperation()) return;
        await writeSecureToken(tokenKey, issuedToken);
        if (!isCurrentOperation()) return;
      }
      if (!isCurrentOperation()) return;
      await persistMetadata({ id, label, candidates, clientToken: issuedToken, pushServerId: chosen.kind === 'direct' ? chosen.serverId : undefined });
      if (!isCurrentOperation()) return;
      setPendingConnection(null);
      switchToTransport(
        chosen.kind === 'relay' ? { kind: 'relay', relay: chosen.relay, tunnel: { client: chosen.tunnel, owned: chosen.owned } } : { kind: 'direct', url: chosen.url },
        issuedToken,
        { runtimeKey: tokenKey, requestHeaders },
      );
      adopted = chosen.kind === 'relay';
      if (!isCurrentOperation()) return;
      onConnected();
    } catch (error) {
      if (!isCurrentOperation()) return;
      console.warn('[mobile-connect] password threw', error);
      setError(t(error instanceof MobileHeaderStorageError ? 'mobile.connect.headers.error' : 'mobile.connect.error.passwordFailed'));
    } finally {
      releaseLiveTransport(chosen, adopted);
      if (isCurrentOperation()) endBusy('password');
    }
  }, [beginBusy, endBusy, onConnected, pendingConnection, persistMetadata, t]);

  const cancelPassword = React.useCallback(() => {
    passwordOperationRef.current.cancel();
    endBusy('password');
    setPendingConnection(null);
    setError(null);
  }, [endBusy]);

  const saveConnection = React.useCallback(async (input: MobileConnectInput): Promise<MobileSavedConnection | null> => {
    setError(null);
    let candidates = buildCandidatesFromInput(input);
    const existing = input.id ? connectionsRef.current.find((connection) => connection.id === input.id) ?? null : null;
    if (existing) {
      const inputDirects = candidates.filter((c): c is Extract<MobileTransportCandidate, { kind: 'direct' }> => c.kind === 'direct');
      const preservedHttps = directCandidates(existing).filter(
        (c) => c.url.startsWith('https://') && !inputDirects.some((n) => isSameConnectionUrl(n.url, c.url)),
      );
      const relay = relayCandidateOf(existing);
      candidates = [...inputDirects, ...preservedHttps, ...(relay ? [{ kind: 'relay' as const, relay }] : [])];
    }
    if (candidates.length === 0) {
      setError(t('mobile.connect.error.urlRequired'));
      return null;
    }
    const clientToken = input.clientToken?.trim() || undefined;
    const fallbackLabel = directCandidates({ candidates }).length === 0 && existing
      ? existing.label
      : getConnectionLabel(connectionDisplayUrl({ candidates }));
    const label = input.label?.trim() || fallbackLabel;
    if (isCapacitorApp()) {
      const nextKey = secureTokenKeyOf({ candidates, serverId: existing?.serverId });
      if (clientToken) {
        await writeSecureToken(nextKey, clientToken);
      } else if (existing?.hasToken) {
        const previousKey = secureTokenKeyOf(existing);
        if (previousKey && nextKey && previousKey !== nextKey) {
          const storedToken = await readSecureToken(previousKey);
          if (storedToken) await writeSecureToken(nextKey, storedToken);
        }
      }
    }
    try {
      const requestHeaders = input.requestHeaders === undefined ? undefined : await resolveConnectionHeaders(input, candidates, existing ?? undefined) ?? null;
      const next = await persistMetadata({ id: input.id, label, candidates, clientToken, requestHeaders });
      if (existing && isActiveRuntimeConnection(existing) && !isRelayModeActive() && input.requestHeaders !== undefined) {
        switchToTransport({ kind: 'direct', url: getRuntimeApiBaseUrl() }, getRuntimeBearerTokenSync() || null, {
          runtimeKey: getRuntimeKey(), requestHeaders: requestHeaders ?? undefined,
        });
      }
      return next[0] ?? null;
    } catch {
      setError(t('mobile.connect.headers.error'));
      return null;
    }
  }, [persistMetadata, t]);

  const removeConnection = React.useCallback(async (id: string): Promise<MobileSavedConnection | null> => {
    const removed = connectionsRef.current.find((connection) => connection.id === id) ?? null;
    try {
      const next = await deleteMobileConnection(id);
      applyConnections(next);
      return removed;
    } catch {
      setError(t('mobile.connect.headers.error'));
      return null;
    }
  }, [applyConnections, t]);

  return {
    connections,
    isBusy: busyOperation !== null,
    isPasswordBusy: busyOperation === 'password',
    error,
    pendingConnection,
    connect,
    redeemPairingConnection,
    submitPassword,
    cancelPassword,
    saveConnection,
    removeConnection,
    setError,
  };
};
