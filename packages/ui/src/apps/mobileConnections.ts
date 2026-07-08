// Saved-connection storage + the shared connect/unlock flow for the dedicated
// mobile app. Both the onboarding welcome screen and the Instances sheet drive
// connections through `useMobileConnection` so the health-check + progressive
// password unlock + client-token issuance + runtime switch all behave identically.
//
// Persistence model (deliberately simple so it is correct-by-inspection):
//   - Instance *metadata* (id/label/url/lastUsedAt + a `hasToken` flag) lives in
//     localStorage. On native it NEVER contains the client token.
//   - The client token lives in the OS secure store (iOS Keychain / Android
//     Keystore) via @aparajita/capacitor-secure-storage, keyed per instance URL.
//   - On web (browser-hosted mobile.html) there is no secure store, so the token
//     stays inline in localStorage — that surface is not the native security target.
//
// Token writes are AWAITED before we switch the runtime endpoint, so a successful
// unlock guarantees the token is actually persisted (no fire-and-forget).

import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import React from 'react';

import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { buildRelayOfferUrl, parseRelayOfferUrl } from '@/lib/relay/offer';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const MOBILE_CONNECTIONS_STORAGE_KEY = 'openchamber.mobile.connections.v1';
const MOBILE_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';
const MOBILE_CONNECTIONS_LIMIT = 12;
const MOBILE_CONNECT_TIMEOUT_MS = 8000;
const MOBILE_NATIVE_HTTP_TIMEOUT_MS = 2500;
const MOBILE_SECURE_TIMEOUT_MS = 3000;

export type MobileConnectionMode = 'direct' | 'relay';

// Persisted relay transport config. This is connection metadata, not a secret
// (the host public key is public by construction) — but never log it raw; use
// redactOffer-style masking for any debug output.
export type MobileRelayConfig = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

export type MobileSavedConnection = {
  id: string;
  label: string;
  url: string;
  lastUsedAt: number;
  // 'direct' talks HTTP to `url`; 'relay' rides the E2EE tunnel described by `relay`.
  // Entries persisted before relay support existed normalize to 'direct' on read.
  mode: MobileConnectionMode;
  // Present iff mode === 'relay'. For relay entries `url` holds the canonical
  // token-free offer link (display/dedupe only — never fetched).
  relay?: MobileRelayConfig;
  // Native: indicates a token exists in the secure store. Web: unused.
  hasToken?: boolean;
  // Web only: the token stored inline. On native this stays undefined in the list.
  clientToken?: string;
};

export type MobilePendingConnection = {
  label: string;
  url: string;
  // Present when the password unlock must ride the relay tunnel.
  relay?: MobileRelayConfig;
  relayGrant?: string;
};

export type MobileConnectInput = {
  url: string;
  clientToken?: string;
  label?: string;
  relay?: MobileRelayConfig;
  relayGrant?: string;
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

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

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

export const getConnectionLabel = (url: string): string => {
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

export const isSameConnectionUrl = (left: string, right: string): boolean =>
  getConnectionStorageKey(left) === getConnectionStorageKey(right);

// ---------------------------------------------------------------------------
// Relay helpers
// ---------------------------------------------------------------------------

// Stable identity for a relay connection. Also used as the runtime key passed
// to switchRuntimeEndpoint so "is this saved entry the active runtime?" checks
// can compare against getRuntimeKey().
export const relayConnectionRuntimeKey = (relay: MobileRelayConfig): string =>
  `relay:${relay.serverId}@${relay.relayUrl.trim()}`;

// Dedupe/secure-store key for a connection of either mode. Direct connections
// keep the historical normalized-URL key so existing saved tokens stay valid.
const connectionKeyOf = (connection: { url: string; relay?: MobileRelayConfig }): string =>
  connection.relay ? relayConnectionRuntimeKey(connection.relay) : getConnectionStorageKey(connection.url);

// Canonical token-free offer link stored as the relay entry's `url`. Secret-free
// by construction (no token/grant), safe for localStorage and display.
const canonicalRelayUrl = (relay: MobileRelayConfig): string =>
  buildRelayOfferUrl({
    v: 1,
    mode: 'relay',
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
  });

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

type ResolvedRelayInput = {
  relay: MobileRelayConfig;
  token?: string;
  label?: string;
  grant?: string;
};

// Accepts relay input either as an explicit descriptor (saved connections) or as
// a raw pairing link typed/pasted/scanned into the URL field.
const resolveRelayInput = (input: MobileConnectInput): ResolvedRelayInput | null => {
  if (input.relay) {
    return {
      relay: input.relay,
      token: input.clientToken?.trim() || undefined,
      label: input.label?.trim() || undefined,
      grant: input.relayGrant,
    };
  }
  const trimmed = input.url.trim();
  if (!/^openchamber:\/\//i.test(trimmed)) return null;
  const offer = parseRelayOfferUrl(trimmed);
  if (!offer) return null;
  return {
    relay: { relayUrl: offer.relayUrl, serverId: offer.serverId, hostEncPubJwk: offer.hostEncPubJwk },
    token: input.clientToken?.trim() || offer.token,
    label: input.label?.trim() || offer.label,
    grant: offer.grant,
  };
};

// ---------------------------------------------------------------------------
// Request helpers (native CapacitorHttp first — needed to reach plain-http LAN
// servers the secure webview cannot fetch — then a browser-fetch fallback).
// ---------------------------------------------------------------------------

const logConnect = (step: string, detail: Record<string, unknown> = {}): void => {
  console.info('[mobile-connect]', step, detail);
};

const logStorage = (step: string, detail: Record<string, unknown> = {}): void => {
  console.info('[mobile-storage]', step, detail);
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
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await CapacitorHttp.request({
      url,
      method: init?.method || 'GET',
      headers,
      data: getJsonRequestData(init?.body),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      source: 'native-http',
      json: async () => parseMaybeJson(response.data),
    };
  } catch (error) {
    console.warn('[mobile-connect] native-http failed', { url, error });
    return null;
  }
};

const browserFetchRequest = async (url: string, init?: RequestInit): Promise<MobileFetchResponse | null> => {
  const response = await fetch(url, init).catch((error) => {
    console.warn('[mobile-connect] browser-fetch failed', { url, error });
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

const requestWithTimeout = async (url: string, init?: RequestInit): Promise<MobileFetchResponse | null> => {
  const startedAt = Date.now();
  const native = await raceWithTimeout(
    Math.min(MOBILE_NATIVE_HTTP_TIMEOUT_MS, MOBILE_CONNECT_TIMEOUT_MS),
    nativeHttpRequest(url, init),
  );
  if (native) return native;

  const controller = new AbortController();
  const remainingMs = Math.max(1000, MOBILE_CONNECT_TIMEOUT_MS - (Date.now() - startedAt));
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

// ---------------------------------------------------------------------------
// Relay connect helpers
// ---------------------------------------------------------------------------

const RELAY_CONNECT_TIMEOUT_MS = 15_000;

type RelayProbeOutcome = 'ok' | 'needs-login' | 'auth-failed' | 'unreachable';

// Probe /health + /auth/session through a short-lived tunnel — the relay
// counterpart of the direct flow's pre-switch reachability/auth probe. The
// throwaway client is always closed; the long-lived runtime tunnel is created
// by switchRuntimeEndpoint afterwards. Cookies never ride the tunnel, so the
// cookie-only-session special case from the direct flow does not apply here.
const probeRelaySession = async (
  relay: MobileRelayConfig,
  token?: string,
  grant?: string,
): Promise<RelayProbeOutcome> => {
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(grant ? { grant } : {}),
  });
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const health = await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, tunnel.fetch('/health', { headers }).catch(() => null));
    logConnect('relay:health', { ok: health?.ok === true, status: health?.status ?? null });
    if (!health?.ok) return 'unreachable';
    const session = await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, tunnel.fetch('/auth/session', { headers }).catch(() => null));
    logConnect('relay:session', { ok: session?.ok === true, status: session?.status ?? null, hasToken: Boolean(token) });
    if (!session) return 'unreachable';
    if (session.status === 401) return token ? 'auth-failed' : 'needs-login';
    if (!session.ok && session.status !== 404) return 'auth-failed';
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) {
      return token ? 'auth-failed' : 'needs-login';
    }
    return 'ok';
  } finally {
    tunnel.close();
  }
};

const switchToRelayRuntime = (relay: MobileRelayConfig, clientToken: string | null, grant?: string): void => {
  // Relay mode has no network base URL: runtimeFetch intercepts runtime paths on
  // the current window origin and rides the E2EE tunnel, so the window origin is
  // the correct virtual API base. The runtime key carries the real identity.
  const apiBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken,
    runtimeKey: relayConnectionRuntimeKey(relay),
    relay: {
      relayUrl: relay.relayUrl,
      serverId: relay.serverId,
      hostEncPubJwk: relay.hostEncPubJwk,
      ...(grant ? { grant } : {}),
    },
  });
};

// ---------------------------------------------------------------------------
// Metadata storage (localStorage) — never holds the token on native.
// ---------------------------------------------------------------------------

const readConnections = (): MobileSavedConnection[] => {
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
      const c = item as Partial<MobileSavedConnection>;
      if (typeof c.id !== 'string' || typeof c.url !== 'string') return [];
      // Explicit normalization: entries persisted before relay support carry no
      // `mode` and default to 'direct'. A relay entry with malformed transport
      // config is unusable — drop it rather than misrepresent it as direct.
      const relay = c.mode === 'relay' ? parseRelayConfig(c.relay) : null;
      if (c.mode === 'relay' && !relay) return [];
      const inlineToken = typeof c.clientToken === 'string' && c.clientToken.trim() ? c.clientToken : undefined;
      const base: MobileSavedConnection = {
        id: c.id,
        label: typeof c.label === 'string' && c.label.trim() ? c.label : getConnectionLabel(c.url),
        url: c.url,
        lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : 0,
        mode: relay ? 'relay' : 'direct',
        ...(relay ? { relay } : {}),
      };
      if (native) return [{ ...base, hasToken: Boolean(c.hasToken) || Boolean(inlineToken) }];
      return [{ ...base, clientToken: inlineToken, hasToken: Boolean(inlineToken) }];
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
};

const writeConnections = (connections: MobileSavedConnection[]): void => {
  if (typeof window === 'undefined') return;
  const native = isCapacitorApp();
  const serialized = connections.slice(0, MOBILE_CONNECTIONS_LIMIT).map((c) => {
    // Persist only the three relay transport fields — grant/token never land here.
    const shared = {
      id: c.id,
      label: c.label,
      url: c.url,
      lastUsedAt: c.lastUsedAt,
      mode: c.mode,
      ...(c.relay ? { relay: { relayUrl: c.relay.relayUrl, serverId: c.relay.serverId, hostEncPubJwk: c.relay.hostEncPubJwk } } : {}),
    };
    return native
      ? { ...shared, hasToken: Boolean(c.hasToken || c.clientToken) }
      : { ...shared, clientToken: c.clientToken };
  });
  try {
    window.localStorage.setItem(MOBILE_CONNECTIONS_STORAGE_KEY, JSON.stringify(serialized));
  } catch (error) {
    console.warn('[mobile-storage] failed to persist connection metadata', error);
  }
};

const upsertConnectionInList = (
  connections: MobileSavedConnection[],
  draft: { label: string; url: string; clientToken?: string; hasToken?: boolean; relay?: MobileRelayConfig },
): MobileSavedConnection[] => {
  const key = connectionKeyOf(draft);
  const existing = connections.find((item) => connectionKeyOf(item) === key);
  const native = isCapacitorApp();
  const next: MobileSavedConnection = {
    id: existing?.id || crypto.randomUUID(),
    label: draft.label,
    url: draft.url,
    lastUsedAt: Date.now(),
    mode: draft.relay ? 'relay' : 'direct',
    ...(draft.relay ? { relay: draft.relay } : {}),
    ...(native
      ? { hasToken: draft.hasToken ?? (Boolean(draft.clientToken) || existing?.hasToken || false) }
      : { clientToken: draft.clientToken ?? existing?.clientToken, hasToken: Boolean(draft.clientToken ?? existing?.clientToken) }),
  };
  return [
    next,
    ...connections.filter((item) => item.id !== next.id && connectionKeyOf(item) !== key),
  ].slice(0, MOBILE_CONNECTIONS_LIMIT);
};

// ---------------------------------------------------------------------------
// Secure token storage (native only), per-instance URL. Every call is bounded
// so a hung/unavailable Keychain can never block the connect flow.
// ---------------------------------------------------------------------------

// We call the plugin's NATIVE methods (`internalSetItem`/`internalGetItem`/
// `internalRemoveItem`) directly. Capacitor routes native methods straight to the
// iOS/Android plugin via the bridge — unlike the high-level `setItem`/`setKeyPrefix`
// JS methods, which make the `registerPlugin` proxy lazy-load its platform JS module
// (the step that stalls in this webview). We also build the prefixed key ourselves
// so we never touch the JS-only `setKeyPrefix`.
type NativeSecureStorage = {
  internalSetItem: (options: { prefixedKey: string; data: string; sync: boolean; access: number }) => Promise<void>;
  internalGetItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ data: string | null }>;
  internalRemoveItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ success: boolean }>;
};

const nativeSecure = SecureStorage as unknown as NativeSecureStorage;
const KEYCHAIN_ACCESS_WHEN_UNLOCKED = 0; // KeychainAccess.whenUnlocked

// `key` is a connection storage key (connectionKeyOf): the normalized URL for
// direct connections (unchanged historical format, existing tokens stay valid)
// or the relay identity key for relay connections.
const prefixedTokenKey = (key: string): string =>
  `${MOBILE_SECURE_STORAGE_PREFIX}token.${encodeURIComponent(key)}`;

const withTimeout = async <T,>(operation: Promise<T>, fallback: T): Promise<T> => {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(fallback), MOBILE_SECURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation.catch(() => fallback), timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

// Bound a native Keychain call so a stalled/failed bridge can never hang the flow.
const boundedSecure = async <T,>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
  if (!isCapacitorApp()) return fallback;
  return withTimeout(
    run().catch((error) => {
      console.warn(`[mobile-storage] ${label} failed`, error);
      return fallback;
    }),
    fallback,
  );
};

const readSecureToken = async (key: string): Promise<string | undefined> => {
  logStorage('secure:read-start', { key });
  const value = await boundedSecure(
    'secure:read',
    async () => (await nativeSecure.internalGetItem({ prefixedKey: prefixedTokenKey(key), sync: false })).data,
    null,
  );
  const token = typeof value === 'string' && value.trim() ? value : undefined;
  logStorage('secure:read', { key, hasToken: Boolean(token) });
  return token;
};

const writeSecureToken = async (key: string, token: string): Promise<boolean> => {
  logStorage('secure:write-start', { key });
  const ok = await boundedSecure('secure:write', async () => {
    await nativeSecure.internalSetItem({
      prefixedKey: prefixedTokenKey(key),
      data: token,
      sync: false,
      access: KEYCHAIN_ACCESS_WHEN_UNLOCKED,
    });
    return true;
  }, false);
  logStorage('secure:write', { key, ok });
  return ok;
};

const deleteSecureToken = async (key: string): Promise<void> => {
  await boundedSecure('secure:delete', async () => {
    await nativeSecure.internalRemoveItem({ prefixedKey: prefixedTokenKey(key), sync: false });
    return true;
  }, false);
};

// ---------------------------------------------------------------------------
// Public storage API
// ---------------------------------------------------------------------------

// One-time migration: a legacy localStorage record on native might still carry an
// inline `clientToken`. Move it into the secure store and strip the metadata.
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
  for (const { url, clientToken } of legacy) {
    await writeSecureToken(getConnectionStorageKey(url), clientToken);
  }
  writeConnections(readConnections());
  logStorage('secure:migrate-done', { count: legacy.length });
};

export const loadMobileConnections = async (): Promise<MobileSavedConnection[]> => {
  await migrateLegacyInlineTokens();
  return readConnections();
};

export const upsertMobileConnection = async (
  connection: { label: string; url: string; clientToken?: string; relay?: MobileRelayConfig },
): Promise<MobileSavedConnection[]> => {
  const next = upsertConnectionInList(readConnections(), connection);
  writeConnections(next);
  if (isCapacitorApp() && connection.clientToken) {
    await writeSecureToken(connectionKeyOf(connection), connection.clientToken);
  }
  return next;
};

export const deleteMobileConnection = async (id: string): Promise<MobileSavedConnection[]> => {
  const connections = readConnections();
  const removed = connections.find((connection) => connection.id === id) ?? null;
  const next = connections.filter((connection) => connection.id !== id);
  writeConnections(next);
  if (removed && isCapacitorApp()) await deleteSecureToken(connectionKeyOf(removed));
  return next;
};

// Cold-launch auto-connect: silently reconnect to the most-recently-used saved
// instance so a returning user (and notification deep-links) land straight in the
// app instead of the connect screen. Returns true and switches the runtime endpoint
// when the instance is reachable AND we already have a usable bearer token; returns
// false — caller shows the connect screen — when there is no saved instance, it's
// unreachable, or it needs a (re)login. Mirrors the success path of
// `useMobileConnection.connect`, with no prompts or UI state.
export const autoConnectLastInstance = async (): Promise<boolean> => {
  await migrateLegacyInlineTokens();
  const candidate = readConnections()[0]; // sorted most-recent-first
  if (!candidate) return false;

  // Relay connections auto-connect through the tunnel: no URL to probe, the
  // health/session check rides a throwaway tunnel client instead.
  if (candidate.mode === 'relay' && candidate.relay) {
    let relayToken: string | undefined;
    if (isCapacitorApp()) {
      if (!candidate.hasToken) return false;
      relayToken = await readSecureToken(connectionKeyOf(candidate));
      if (!relayToken) return false;
    } else {
      relayToken = candidate.clientToken;
      if (!relayToken) return false;
    }
    const outcome = await probeRelaySession(candidate.relay, relayToken);
    if (outcome !== 'ok') return false;
    await upsertMobileConnection({ label: candidate.label, url: candidate.url, relay: candidate.relay }); // bump lastUsedAt
    switchToRelayRuntime(candidate.relay, relayToken);
    return true;
  }

  const url = normalizeConnectionUrl(candidate.url);
  if (!url) return false;

  // The native runtime transport needs a bearer token; only auto-connect when one is
  // already saved. A missing/expired token must go through the login UI, not silently.
  let token: string | undefined;
  if (isCapacitorApp()) {
    if (!candidate.hasToken) return false;
    token = await readSecureToken(getConnectionStorageKey(url));
    if (!token) return false;
  } else {
    token = candidate.clientToken;
  }

  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers });
  if (!health?.ok) return false;

  const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: 'include', headers });
  // Token rejected / session invalid → fall back to the login screen.
  if (!session || (!session.ok && session.status !== 404)) return false;
  const status = await readSessionStatus(session);
  if (status && status.disabled !== true && status.authenticated === false) return false;

  await upsertMobileConnection({ label: candidate.label, url }); // bump lastUsedAt (keeps hasToken)
  switchRuntimeEndpoint({ apiBaseUrl: url, clientToken: token ?? null });
  return true;
};

export const validateMobileConnectionSession = async (input: {
  url: string;
  clientToken?: string | null;
}): Promise<boolean> => {
  let url = '';
  try {
    url = normalizeConnectionUrl(input.url);
  } catch {
    return false;
  }
  if (!url) return false;

  const token = input.clientToken?.trim() || undefined;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers });
  if (!health?.ok) return false;

  const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: 'include', headers });
  if (!session || (!session.ok && session.status !== 404)) return false;

  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

// Relay-aware session validation for the ACTIVE runtime (native resume path).
// In relay mode there is no reachable URL to probe — validate through the live
// tunnel via runtimeFetch. A transport failure/timeout is transient (the tunnel
// reconnects on its own) and must not masquerade as a revoked session, so only
// an explicit auth rejection reports invalid.
export const validateActiveRuntimeSession = async (input: {
  url: string;
  clientToken?: string | null;
}): Promise<boolean> => {
  if (!isRelayModeActive()) return validateMobileConnectionSession(input);
  const session = await raceWithTimeout(
    RELAY_CONNECT_TIMEOUT_MS,
    runtimeFetch('/auth/session').then((response): Response | null => response).catch(() => null),
  );
  if (!session) return true;
  if (session.status === 401) return false;
  if (!session.ok && session.status !== 404) return true;
  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

// ---------------------------------------------------------------------------
// Shared connection controller
// ---------------------------------------------------------------------------

export type UseMobileConnection = {
  connections: MobileSavedConnection[];
  isBusy: boolean;
  isPasswordBusy: boolean;
  error: string | null;
  pendingConnection: MobilePendingConnection | null;
  connect: (input: MobileConnectInput) => Promise<void>;
  submitPassword: (password: string) => Promise<void>;
  cancelPassword: () => void;
  saveConnection: (input: MobileConnectInput) => Promise<MobileSavedConnection | null>;
  removeConnection: (id: string) => Promise<MobileSavedConnection | null>;
  setError: (message: string | null) => void;
};

// `onConnected` fires once the runtime endpoint is switched (the caller navigates
// away / closes its surface from there).
export const useMobileConnection = (onConnected: () => void): UseMobileConnection => {
  const { t } = useI18n();
  const [connections, setConnections] = React.useState<MobileSavedConnection[]>(() => readConnections());
  const [busyOperation, setBusyOperation] = React.useState<'connect' | 'password' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = React.useState<MobilePendingConnection | null>(null);
  const connectionsRef = React.useRef(connections);
  const busyRef = React.useRef<'connect' | 'password' | null>(null);

  const applyConnections = React.useCallback((next: MobileSavedConnection[]) => {
    connectionsRef.current = next;
    setConnections(next);
  }, []);

  const beginBusy = React.useCallback((operation: 'connect' | 'password') => {
    busyRef.current = operation;
    setBusyOperation(operation);
  }, []);

  const endBusy = React.useCallback((operation: 'connect' | 'password') => {
    if (busyRef.current !== operation) return;
    busyRef.current = null;
    setBusyOperation(null);
  }, []);

  // Refresh from storage on mount (runs the legacy-token migration too).
  React.useEffect(() => {
    let disposed = false;
    void loadMobileConnections().then((loaded) => {
      if (!disposed) applyConnections(loaded);
    });
    return () => { disposed = true; };
  }, [applyConnections]);

  // Persist metadata for a connection and reflect it in state immediately.
  const persistMetadata = React.useCallback((draft: { label: string; url: string; clientToken?: string; relay?: MobileRelayConfig }) => {
    const next = upsertConnectionInList(connectionsRef.current, draft);
    applyConnections(next);
    writeConnections(next);
    return next;
  }, [applyConnections]);

  const connect = React.useCallback(async (input: MobileConnectInput) => {
    setError(null);
    beginBusy('connect');
    try {
      // Relay connections (saved entries or pasted/scanned pairing offers) ride
      // the E2EE tunnel; there is no URL to reach, so the probe + login flow
      // runs through a throwaway tunnel client instead of network requests.
      const relayInput = resolveRelayInput(input);
      if (relayInput) {
        const { relay, grant } = relayInput;
        const key = relayConnectionRuntimeKey(relay);
        const saved = connectionsRef.current.find((c) => c.relay && relayConnectionRuntimeKey(c.relay) === key);
        const label = relayInput.label || saved?.label || getConnectionLabel(relay.relayUrl);
        let token = relayInput.token;
        const tokenIsNew = Boolean(token);
        if (!token) {
          if (isCapacitorApp()) {
            if (saved?.hasToken) token = await readSecureToken(key);
          } else {
            token = saved?.clientToken;
          }
        }
        logConnect('relay:connect:start', { serverId: relay.serverId, hasToken: Boolean(token) });
        const outcome = await probeRelaySession(relay, token, grant);
        const url = canonicalRelayUrl(relay);
        if (outcome === 'unreachable') {
          setError(t('mobile.connect.error.unreachable'));
          return;
        }
        if (outcome === 'needs-login') {
          persistMetadata({ label, url, relay });
          setPendingConnection({ label, url, relay, relayGrant: grant });
          return;
        }
        if (outcome === 'auth-failed') {
          setError(t('mobile.connect.error.authRequired'));
          return;
        }
        if (token && tokenIsNew && isCapacitorApp()) {
          await writeSecureToken(key, token);
        }
        persistMetadata({ label, url, relay, clientToken: token });
        switchToRelayRuntime(relay, token ?? null, grant);
        onConnected();
        return;
      }

      const url = normalizeConnectionUrl(input.url);
      if (!url) {
        setError(t('mobile.connect.error.urlRequired'));
        return;
      }

      const label = input.label?.trim()
        || connectionsRef.current.find((c) => isSameConnectionUrl(c.url, url))?.label
        || getConnectionLabel(url);

      // Resolve a token: explicit input wins, otherwise read the saved one from
      // the secure store (single bounded read — never blocks the flow).
      let token = input.clientToken?.trim() || undefined;
      const tokenIsNew = Boolean(token);
      if (!token && isCapacitorApp()) {
        const saved = connectionsRef.current.find((c) => c.mode !== 'relay' && isSameConnectionUrl(c.url, url));
        if (saved?.hasToken) token = await readSecureToken(getConnectionStorageKey(url));
      }

      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

      logConnect('health:start', { url });
      const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers });
      logConnect('health:done', { ok: health?.ok === true, source: health?.source ?? null, status: health?.status ?? null });
      if (!health?.ok) {
        setError(t('mobile.connect.error.unreachable'));
        return;
      }

      logConnect('session:start', { url, hasToken: Boolean(token) });
      const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: 'include', headers });
      const status = await readSessionStatus(session);
      logConnect('session:done', { ok: session?.ok === true, status: session?.status ?? null, scope: status?.scope ?? null, disabled: status?.disabled === true });

      // A cookie-only native session (authenticated, but not a `client` bearer
      // scope and not auth-disabled) is not enough — the runtime transport needs a
      // bearer token, so fall through to the password flow to mint one.
      const cookieOnlyNeedsToken = isCapacitorApp()
        && session?.ok === true
        && !token
        && status?.authenticated === true
        && status.disabled !== true
        && status.scope !== 'client';

      if (!token && (session?.status === 401 || cookieOnlyNeedsToken)) {
        persistMetadata({ label, url });
        setPendingConnection({ label, url });
        return;
      }

      if (!session || (!session.ok && session.status !== 404)) {
        setError(t('mobile.connect.error.authRequired'));
        return;
      }

      // Connected. If the token came from the user (not the secure store), persist
      // it first so a cold restart won't re-prompt.
      if (token && tokenIsNew && isCapacitorApp()) {
        await writeSecureToken(getConnectionStorageKey(url), token);
      }
      persistMetadata({ label, url, clientToken: token });
      switchRuntimeEndpoint({ apiBaseUrl: url, clientToken: token ?? null });
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] connect threw', error);
      setError(t('mobile.connect.error.invalidUrl'));
    } finally {
      endBusy('connect');
    }
  }, [beginBusy, endBusy, onConnected, persistMetadata, t]);

  const submitPassword = React.useCallback(async (password: string) => {
    if (!pendingConnection || !password.trim() || busyRef.current === 'password') return;
    setError(null);
    beginBusy('password');
    const { url, label } = pendingConnection;
    try {
      // Relay login rides the tunnel: POST /auth/session through a throwaway
      // tunnel client. Cookies never cross the tunnel, so an issued bearer
      // token is mandatory on every platform (not just native).
      if (pendingConnection.relay) {
        const relay = pendingConnection.relay;
        const grant = pendingConnection.relayGrant;
        const tunnel = createRelayTunnelClient({
          relayUrl: relay.relayUrl,
          serverId: relay.serverId,
          hostEncPubJwk: relay.hostEncPubJwk,
          ...(grant ? { grant } : {}),
        });
        try {
          logConnect('relay:password:start', { serverId: relay.serverId });
          const response = await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, tunnel.fetch('/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ password, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Mobile' }),
          }).catch(() => null));
          logConnect('relay:password:done', { ok: response?.ok === true, status: response?.status ?? null });
          if (!response?.ok) {
            setError(t('mobile.connect.error.passwordFailed'));
            return;
          }
          const payload = await response.json().catch(() => null) as { clientToken?: unknown } | null;
          const issuedToken = typeof payload?.clientToken === 'string' ? payload.clientToken.trim() : '';
          logConnect('relay:password:token', { issued: Boolean(issuedToken) });
          if (!issuedToken) {
            setError(t('mobile.connect.error.authRequired'));
            return;
          }
          if (isCapacitorApp()) {
            await writeSecureToken(relayConnectionRuntimeKey(relay), issuedToken);
          }
          persistMetadata({ label, url: canonicalRelayUrl(relay), relay, clientToken: issuedToken });
          setPendingConnection(null);
          switchToRelayRuntime(relay, issuedToken, grant);
          onConnected();
        } finally {
          tunnel.close();
        }
        return;
      }

      logConnect('password:start', { url });
      const response = await requestWithTimeout(`${url}/auth/session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Mobile' }),
      });
      logConnect('password:done', { ok: response?.ok === true, status: response?.status ?? null });
      if (!response?.ok) {
        setError(t('mobile.connect.error.passwordFailed'));
        return;
      }

      const payload = await response.json().catch(() => null) as { clientToken?: unknown } | null;
      const issuedToken = typeof payload?.clientToken === 'string' ? payload.clientToken.trim() : '';
      logConnect('password:token', { issued: Boolean(issuedToken) });

      // Native runtime transport needs a bearer token; a cookie-only success is
      // not acceptable for a saved protected instance.
      if (isCapacitorApp() && !issuedToken) {
        setError(t('mobile.connect.error.authRequired'));
        return;
      }

      // Guarantee the token is persisted BEFORE switching (no fire-and-forget).
      if (isCapacitorApp() && issuedToken) {
        await writeSecureToken(getConnectionStorageKey(url), issuedToken);
      }
      persistMetadata({ label, url, clientToken: issuedToken || undefined });
      setPendingConnection(null);
      switchRuntimeEndpoint({ apiBaseUrl: url, clientToken: issuedToken || null });
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] password threw', error);
      setError(t('mobile.connect.error.passwordFailed'));
    } finally {
      endBusy('password');
    }
  }, [beginBusy, endBusy, onConnected, pendingConnection, persistMetadata, t]);

  const cancelPassword = React.useCallback(() => {
    setPendingConnection(null);
    setError(null);
  }, []);

  const saveConnection = React.useCallback(async (input: MobileConnectInput): Promise<MobileSavedConnection | null> => {
    setError(null);
    // Relay pairing links save as relay-mode entries (token → secure storage,
    // metadata holds only the transport descriptor).
    const relayInput = resolveRelayInput(input);
    if (relayInput) {
      const { relay } = relayInput;
      const key = relayConnectionRuntimeKey(relay);
      const label = relayInput.label || getConnectionLabel(relay.relayUrl);
      // Awaited token write so "Save" truly persisted the secret before returning.
      if (isCapacitorApp() && relayInput.token) {
        await writeSecureToken(key, relayInput.token);
      }
      const next = persistMetadata({ label, url: canonicalRelayUrl(relay), relay, clientToken: relayInput.token });
      return next.find((connection) => connection.relay && relayConnectionRuntimeKey(connection.relay) === key) ?? null;
    }

    const url = normalizeConnectionUrl(input.url);
    if (!url) {
      setError(t('mobile.connect.error.urlRequired'));
      return null;
    }
    const clientToken = input.clientToken?.trim() || undefined;
    const label = input.label?.trim() || getConnectionLabel(url);
    // Awaited token write so "Save" truly persisted the secret before returning.
    if (isCapacitorApp() && clientToken) {
      await writeSecureToken(getConnectionStorageKey(url), clientToken);
    }
    const next = persistMetadata({ label, url, clientToken });
    return next.find((connection) => connection.mode !== 'relay' && isSameConnectionUrl(connection.url, url)) ?? null;
  }, [persistMetadata, t]);

  const removeConnection = React.useCallback(async (id: string): Promise<MobileSavedConnection | null> => {
    const removed = connectionsRef.current.find((connection) => connection.id === id) ?? null;
    const next = await deleteMobileConnection(id);
    applyConnections(next);
    return removed;
  }, [applyConnections]);

  return {
    connections,
    isBusy: busyOperation !== null,
    isPasswordBusy: busyOperation === 'password',
    error,
    pendingConnection,
    connect,
    submitPassword,
    cancelPassword,
    saveConnection,
    removeConnection,
    setError,
  };
};
