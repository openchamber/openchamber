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
import { Capacitor } from '@capacitor/core';
import React from 'react';

import { useI18n } from '@/lib/i18n';
import type { PairingConnectionPayload, PairingEndpointCandidate } from '@/lib/connectionPayload';
import { isCapacitorApp } from '@/lib/platform';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const MOBILE_CONNECTIONS_STORAGE_KEY = 'openchamber.mobile.connections.v1';
const MOBILE_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';
const MOBILE_DEVICE_ID_STORAGE_KEY = 'openchamber.mobile.deviceId';

// Stable per-install identifier for this phone, persisted in localStorage. Used
// as the client dedupe key so every way this device authenticates to a given
// server (pairing redeem OR password re-login) collapses to ONE device record
// instead of piling up a new row each time a token is minted. Different phones
// get different ids; browsers never mint device tokens at all.
const getMobileDeviceId = (): string => {
  try {
    const existing = window.localStorage.getItem(MOBILE_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) return existing.trim();
    const generated = crypto.randomUUID();
    window.localStorage.setItem(MOBILE_DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    // localStorage unavailable — fall back to an ephemeral id (dedupe degrades to
    // per-session, never worse than today's no-dedupe behavior).
    return crypto.randomUUID();
  }
};

// Server-side client dedupe key for this device (shared across pairing + login).
const mobileClientDedupeKey = (): string => `mobile:${getMobileDeviceId()}`;

// Display-only device metadata shown in the server's device list ("iOS",
// "Android"). Capacitor knows the native platform; no extra plugin needed.
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
const MOBILE_SECURE_TIMEOUT_MS = 3000;
// Resume re-probe budget: on app wake we only need a quick "is this transport
// reachable right now?" answer, not the full 8s connect budget. A dead LAN
// candidate must fail fast so the relay fallback (or the switch back to LAN)
// feels instant instead of hanging for seconds.
const MOBILE_FAST_PROBE_TIMEOUT_MS = 2500;

export type MobileConnectionMode = 'direct' | 'relay';

// Persisted relay transport config. This is connection metadata, not a secret
// (the host public key is public by construction) — but never log it raw; mask
// the key coordinates in any debug output.
export type MobileRelayConfig = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

// One reachable transport for a saved device: a direct HTTP URL, or the E2EE
// relay tunnel. A saved connection holds an ORDERED SET of these (index 0 tried
// first — LAN preferred, relay fallback) plus a single client token, and the app
// re-probes them on every connect/reconnect so the same device works at home
// (direct) and away (relay) without re-pairing.
export type MobileTransportCandidate =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig };

export type MobileSavedConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  lastUsedAt: number;
  // Native: a token exists in the secure store, keyed by this connection's `id`.
  hasToken?: boolean;
  // Web only: the token stored inline. On native this stays undefined in the list.
  clientToken?: string;
};

export type MobilePendingConnection = {
  id: string;
  label: string;
  candidates: MobileTransportCandidate[];
  // Present when the password unlock must ride the relay tunnel.
  relay?: MobileRelayConfig;
  relayGrant?: string;
};

// Input to `connect`. Either a raw URL/candidates for a NEW connection, or an
// existing saved connection's `id` + candidates for reconnect.
export type MobileConnectInput = {
  id?: string;
  url?: string;
  candidates?: MobileTransportCandidate[];
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

type PairingRedeemResponse = {
  ok?: boolean;
  clientToken?: unknown;
  client?: { label?: unknown } | null;
  server?: { label?: unknown; url?: unknown } | null;
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

// Stable, non-fetchable pseudo-URL for a relay-only device (display only).
const canonicalRelayUrl = (relay: MobileRelayConfig): string => `relay://${relay.serverId}`;

// --- Transport-candidate helpers on a saved connection ---
const directCandidates = (connection: { candidates: MobileTransportCandidate[] }): Array<{ kind: 'direct'; url: string }> =>
  connection.candidates.filter((c): c is { kind: 'direct'; url: string } => c.kind === 'direct');

const relayCandidateOf = (connection: { candidates: MobileTransportCandidate[] }): MobileRelayConfig | null => {
  const found = connection.candidates.find((c) => c.kind === 'relay');
  return found && found.kind === 'relay' ? found.relay : null;
};

// Display URL for a saved connection: the first direct URL, else the relay
// pseudo-URL. Used only for the connections list UI.
export const connectionDisplayUrl = (connection: { candidates: MobileTransportCandidate[] }): string => {
  const direct = directCandidates(connection)[0];
  if (direct) return direct.url;
  const relay = relayCandidateOf(connection);
  return relay ? canonicalRelayUrl(relay) : '';
};

// Secure-store / dedupe key for a saved device. A device has ONE token that
// works over all its transports; the key is stable and transport-derived: the
// relay identity when the device can use relay, else its direct URL. This keeps
// existing single-transport tokens findable (same key as before this refactor).
const secureTokenKeyOf = (connection: { candidates: MobileTransportCandidate[] }): string => {
  const relay = relayCandidateOf(connection);
  if (relay) return relayConnectionRuntimeKey(relay);
  const direct = directCandidates(connection)[0];
  return direct ? getConnectionStorageKey(direct.url) : '';
};

// Two candidate sets are the same device if they share a relay serverId or a
// normalized direct URL — used to dedupe saved connections on upsert.
const candidateSetsMatch = (a: MobileTransportCandidate[], b: MobileTransportCandidate[]): boolean => {
  const aRelay = a.find((c) => c.kind === 'relay');
  const aServerId = aRelay && aRelay.kind === 'relay' ? aRelay.relay.serverId : null;
  const aUrls = new Set(a.filter((c) => c.kind === 'direct').map((c) => getConnectionStorageKey((c as { url: string }).url)));
  return b.some((c) => {
    if (c.kind === 'relay') return aServerId !== null && c.relay.serverId === aServerId;
    return aUrls.has(getConnectionStorageKey(c.url));
  });
};

// Build the ordered candidate set for a newly typed/pasted server URL.
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

// Resolve a connect request into an ordered candidate set: an explicit set
// (saved reconnect / pairing) wins, otherwise a typed URL and/or a relay
// descriptor. Direct is preferred (index 0), relay is the fallback.
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

// ---------------------------------------------------------------------------
// Request helpers (native CapacitorHttp first — needed to reach plain-http LAN
// servers the secure webview cannot fetch — then a browser-fetch fallback).
// ---------------------------------------------------------------------------

// Android logcat prints objects as "[object Object]" — serialize so device logs
// are actually readable.
const logDetail = (detail: Record<string, unknown>): string => {
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

const logConnect = (step: string, detail: Record<string, unknown> = {}): void => {
  console.info('[mobile-connect]', step, logDetail(detail));
};

const logStorage = (step: string, detail: Record<string, unknown> = {}): void => {
  console.info('[mobile-storage]', step, logDetail(detail));
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
    console.warn('[mobile-connect]', 'native-http failed', logDetail({ url, error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
};

const browserFetchRequest = async (url: string, init?: RequestInit): Promise<MobileFetchResponse | null> => {
  const response = await fetch(url, init).catch((error) => {
    console.warn('[mobile-connect]', 'browser-fetch failed', logDetail({ url, error: error instanceof Error ? error.message : String(error) }));
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

const requestWithTimeout = async (
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
  timeoutMs: number = RELAY_CONNECT_TIMEOUT_MS,
): Promise<RelayProbeOutcome> => {
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(grant ? { grant } : {}),
  });
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const health = await raceWithTimeout(timeoutMs, tunnel.fetch('/health', { headers }).catch(() => null));
    logConnect('relay:health', { ok: health?.ok === true, status: health?.status ?? null });
    if (!health?.ok) return 'unreachable';
    const session = await raceWithTimeout(timeoutMs, tunnel.fetch('/auth/session', { headers }).catch(() => null));
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

const switchToRelayRuntime = (relay: MobileRelayConfig, clientToken: string | null, grant?: string, runtimeKey?: string): void => {
  // Relay mode has no network base URL: runtimeFetch intercepts runtime paths on
  // the current window origin and rides the E2EE tunnel, so the window origin is
  // the correct virtual API base. The runtime key carries the real device
  // identity (stable across a device's transports so LAN⇄relay is not treated
  // as an instance switch).
  const apiBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken,
    runtimeKey: runtimeKey ?? relayConnectionRuntimeKey(relay),
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

// Migrate a pre-candidates entry ({ url, mode, relay }) to a candidate set.
const migrateLegacyCandidates = (c: Record<string, unknown>): MobileTransportCandidate[] => {
  if (c.mode === 'relay') {
    const relay = parseRelayConfig(c.relay);
    return relay ? [{ kind: 'relay', relay }] : [];
  }
  return typeof c.url === 'string' ? directCandidatesFromUrl(c.url) : [];
};

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
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string') return [];
      // Prefer the candidates array; fall back to migrating a legacy entry. An
      // entry with no usable transport is dropped rather than misrepresented.
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
        lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : 0,
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

const writeConnections = (connections: MobileSavedConnection[]): void => {
  if (typeof window === 'undefined') return;
  const native = isCapacitorApp();
  const serialized = connections.slice(0, MOBILE_CONNECTIONS_LIMIT).map((c) => {
    // grant/token never land here — only transport metadata.
    const shared = {
      id: c.id,
      label: c.label,
      candidates: c.candidates.map(serializeCandidate),
      lastUsedAt: c.lastUsedAt,
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
  draft: { id?: string; label: string; candidates: MobileTransportCandidate[]; clientToken?: string; hasToken?: boolean },
): MobileSavedConnection[] => {
  const existing = connections.find(
    (item) => (draft.id && item.id === draft.id) || candidateSetsMatch(item.candidates, draft.candidates),
  );
  const native = isCapacitorApp();
  const next: MobileSavedConnection = {
    id: draft.id || existing?.id || crypto.randomUUID(),
    label: draft.label,
    candidates: draft.candidates,
    lastUsedAt: Date.now(),
    ...(native
      ? { hasToken: draft.hasToken ?? (Boolean(draft.clientToken) || existing?.hasToken || false) }
      : { clientToken: draft.clientToken ?? existing?.clientToken, hasToken: Boolean(draft.clientToken ?? existing?.clientToken) }),
  };
  return [
    next,
    ...connections.filter((item) => item.id !== next.id && !candidateSetsMatch(item.candidates, draft.candidates)),
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
  connection: { id?: string; label: string; candidates: MobileTransportCandidate[]; clientToken?: string },
): Promise<MobileSavedConnection[]> => {
  const next = upsertConnectionInList(readConnections(), connection);
  writeConnections(next);
  if (isCapacitorApp() && connection.clientToken) {
    await writeSecureToken(secureTokenKeyOf({ candidates: connection.candidates }), connection.clientToken);
  }
  return next;
};

export const deleteMobileConnection = async (id: string): Promise<MobileSavedConnection[]> => {
  const connections = readConnections();
  const removed = connections.find((connection) => connection.id === id) ?? null;
  const next = connections.filter((connection) => connection.id !== id);
  writeConnections(next);
  if (removed && isCapacitorApp()) await deleteSecureToken(secureTokenKeyOf(removed));
  return next;
};

// The transport a connect/reconnect settled on.
type ChosenTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig };

type ProbeResult =
  | { status: 'ok'; transport: ChosenTransport }
  | { status: 'needs-login' }
  | { status: 'unreachable' };

// Probe a saved device's candidates IN ORDER with its bearer token and return
// the first transport that is both reachable AND accepts the token. This is the
// heart of "one device, many transports": at home the LAN candidate answers; away
// it is unreachable so we fall through to relay — no re-pairing. An explicit auth
// rejection (401 / authenticated:false) applies to every transport (same token),
// so it short-circuits to needs-login; a merely unreachable candidate is skipped.
const probeConnectionCandidates = async (
  candidates: MobileTransportCandidate[],
  token: string | undefined,
  options?: { fast?: boolean },
): Promise<ProbeResult> => {
  const requestOptions = options?.fast ? { totalTimeoutMs: MOBILE_FAST_PROBE_TIMEOUT_MS } : undefined;
  // Identity gate for direct probes: when the device knows its server's identity
  // (via its relay pairing), a direct candidate must report the SAME serverId in
  // /health before we send the bearer token to it — a re-assigned LAN address may
  // now belong to a different machine. Older servers omit serverId from /health;
  // the gate only rejects an explicit mismatch (matching today's behavior otherwise).
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      const outcome = await probeRelaySession(candidate.relay, token, undefined, options?.fast ? MOBILE_FAST_PROBE_TIMEOUT_MS : undefined);
      if (outcome === 'ok') return { status: 'ok', transport: { kind: 'relay', relay: candidate.relay } };
      if (outcome === 'needs-login' || outcome === 'auth-failed') return { status: 'needs-login' };
      continue; // unreachable → try the next candidate
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    // /health is unauthenticated by design — never send the bearer token to an
    // address whose identity has not been checked yet.
    const health = await requestWithTimeout(`${url}/health`, { method: 'GET' }, requestOptions);
    if (!health?.ok) continue;
    if (expectedServerId) {
      const payload = await health.json().catch(() => null);
      const reported = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).serverId : null;
      if (typeof reported === 'string' && reported && reported !== expectedServerId) {
        logConnect('probe:server-id-mismatch', { url });
        continue;
      }
    }
    const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: 'include', headers }, requestOptions);
    if (session?.status === 401) return { status: 'needs-login' };
    if (!session || (!session.ok && session.status !== 404)) continue;
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) return { status: 'needs-login' };
    // A cookie-only native session (authenticated, but not a `client` bearer scope
    // and not auth-disabled) is not enough — the native runtime transport needs a
    // bearer token, so fall through to the password flow to mint one.
    const authDisabled = status?.disabled === true;
    if (!token && isCapacitorApp() && !authDisabled && status?.scope !== 'client') return { status: 'needs-login' };
    return { status: 'ok', transport: { kind: 'direct', url } };
  }
  return { status: 'unreachable' };
};

// Switch the runtime to a chosen transport. `runtimeKey` is the STABLE device
// identity — passing the same key for a device's LAN and relay transports makes a
// LAN⇄relay swap a transport-only change (not an instance switch), so the app can
// keep the user's session instead of tearing everything down.
const switchToTransport = (
  transport: ChosenTransport,
  token: string | null,
  options?: { runtimeKey?: string; grant?: string },
): void => {
  if (transport.kind === 'relay') {
    switchToRelayRuntime(transport.relay, token, options?.grant, options?.runtimeKey);
  } else {
    switchRuntimeEndpoint({ apiBaseUrl: transport.url, clientToken: token, runtimeKey: options?.runtimeKey });
  }
  // Every live connection is an opportunity to learn the server's CURRENT LAN
  // addresses (pairing-payload candidates go stale when DHCP reassigns the
  // host's IP). Background-only: never blocks or repaints the connect flow.
  scheduleCandidateRefresh();
};

// Cold-launch auto-connect: silently reconnect to the most-recently-used saved
// instance so a returning user (and notification deep-links) land straight in the
// app instead of the connect screen. Probes the device's candidates in order, so
// it lands on whichever transport is reachable right now. Returns true and switches
// the runtime endpoint when reachable AND we already have a usable bearer token;
// returns false — caller shows the connect screen — when there is no saved
// instance, it's unreachable, or it needs a (re)login. No prompts or UI state.
export const autoConnectLastInstance = async (): Promise<boolean> => {
  await migrateLegacyInlineTokens();
  const candidate = readConnections()[0]; // sorted most-recent-first
  if (!candidate) return false;

  // The runtime transport needs a bearer token; only auto-connect when one is
  // already saved. A missing/expired token must go through the login UI.
  let token: string | undefined;
  if (isCapacitorApp()) {
    if (!candidate.hasToken) return false;
    token = await readSecureToken(secureTokenKeyOf(candidate));
    if (!token) return false;
  } else {
    token = candidate.clientToken;
    if (!token) return false;
  }

  const result = await probeConnectionCandidates(candidate.candidates, token);
  if (result.status !== 'ok') return false;
  await upsertMobileConnection({ id: candidate.id, label: candidate.label, candidates: candidate.candidates }); // bump lastUsedAt (keeps token)
  switchToTransport(result.transport, token, { runtimeKey: secureTokenKeyOf(candidate) });
  return true;
};

export const validateMobileConnectionSession = async (input: {
  url: string;
  clientToken?: string | null;
}, options?: { fast?: boolean }): Promise<boolean> => {
  let url = '';
  try {
    url = normalizeConnectionUrl(input.url);
  } catch {
    return false;
  }
  if (!url) return false;

  const token = input.clientToken?.trim() || undefined;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const requestOptions = options?.fast ? { totalTimeoutMs: MOBILE_FAST_PROBE_TIMEOUT_MS } : undefined;

  const health = await requestWithTimeout(`${url}/health`, { method: 'GET', headers }, requestOptions);
  if (!health?.ok) return false;

  const session = await requestWithTimeout(`${url}/auth/session`, { method: 'GET', credentials: 'include', headers }, requestOptions);
  if (!session || (!session.ok && session.status !== 404)) return false;

  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

// A live transport a redeem/login settled on: a reachable direct URL, or an OPEN
// relay tunnel the caller must close after use.
type LiveTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'relay'; relay: MobileRelayConfig; tunnel: ReturnType<typeof createRelayTunnelClient> };

// Convert pairing-payload candidates into ordered mobile transport candidates:
// priority number ascending, relay last on ties (relay is the fallback), invalid
// entries dropped. The resulting order is what gets persisted and re-probed.
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

// Establish the first reachable LIVE transport for an ordered candidate set:
// health-check a direct URL, or open + health-check a relay tunnel. A returned
// relay transport owns an OPEN tunnel the caller must close.
const establishLiveTransport = async (
  candidates: MobileTransportCandidate[],
): Promise<LiveTransport | null> => {
  // Same identity gate as probeConnectionCandidates: a redeem/login must not send
  // its secret to a direct address that reports a different server identity.
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      const tunnel = createRelayTunnelClient(candidate.relay);
      const health = await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, tunnel.fetch('/health').catch(() => null));
      logConnect('establish:relay:health', { ok: health?.ok === true, status: health?.status ?? null });
      if (health?.ok) return { kind: 'relay', relay: candidate.relay, tunnel };
      tunnel.close();
      continue;
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const health = await requestWithTimeout(`${url}/health`, { method: 'GET' });
    logConnect('establish:direct:health', { ok: health?.ok === true, status: health?.status ?? null });
    if (!health?.ok) continue;
    if (expectedServerId) {
      const payload = await health.json().catch(() => null);
      const reported = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).serverId : null;
      if (typeof reported === 'string' && reported && reported !== expectedServerId) {
        logConnect('establish:server-id-mismatch', { url });
        continue;
      }
    }
    return { kind: 'direct', url };
  }
  return null;
};

// Relay-aware session validation for the ACTIVE runtime (native resume path).
// In relay mode there is no reachable URL to probe — validate through the live
// tunnel via runtimeFetch. A transport failure/timeout is transient (the tunnel
// reconnects on its own) and must not masquerade as a revoked session, so only
// an explicit auth rejection reports invalid.
export const validateActiveRuntimeSession = async (input: {
  url: string;
  clientToken?: string | null;
}, options?: { fast?: boolean }): Promise<boolean> => {
  if (!isRelayModeActive()) return validateMobileConnectionSession(input, options);
  const session = await raceWithTimeout(
    options?.fast ? MOBILE_FAST_PROBE_TIMEOUT_MS : RELAY_CONNECT_TIMEOUT_MS,
    runtimeFetch('/auth/session').then((response): Response | null => response).catch(() => null),
  );
  if (!session) return true;
  if (session.status === 401) return false;
  if (!session.ok && session.status !== 404) return true;
  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

// Which TRANSPORT is currently live? The runtime key is the stable device
// identity (same for a device's LAN and relay), so the active transport is read
// from the runtime's mode instead: relay when the tunnel is active, else the
// direct base URL.
const transportMatchesCurrentRuntime = (transport: ChosenTransport): boolean =>
  transport.kind === 'relay'
    ? isRelayModeActive()
    : !isRelayModeActive() && isSameConnectionUrl(transport.url, getRuntimeApiBaseUrl());

// The saved device currently bound to the runtime, matched by its stable key.
const findActiveConnection = (): MobileSavedConnection | null => {
  const runtimeKey = getRuntimeKey();
  if (!runtimeKey) return null;
  return readConnections().find((connection) => secureTokenKeyOf(connection) === runtimeKey) ?? null;
};

// Exported for the connections list: is this saved device the active runtime?
export const isActiveRuntimeConnection = (connection: MobileSavedConnection): boolean => {
  const runtimeKey = getRuntimeKey();
  return Boolean(runtimeKey) && secureTokenKeyOf(connection) === runtimeKey;
};

export type ReprobeOutcome = 'switched' | 'unchanged' | 'unreachable' | 'no-connection';

// App-resume re-probe: when the app wakes (Capacitor `isActive`), the network may
// have changed while it slept, so re-select the active device's transport and
// hot-switch if a better one is reachable — the seamless "LAN at home ⇄ relay
// away, no re-pairing" swap. Efficient: it only probes candidates HIGHER priority
// than the current one ("did a better transport come back?"); if none, it
// validates the current transport over its live channel; only if that is dead does
// it fall through to the lower-priority candidates. 'unchanged' → keep the runtime
// and just refresh; 'unreachable'/'no-connection' → show the connect screen.
export const reprobeActiveConnection = async (): Promise<ReprobeOutcome> => {
  const active = findActiveConnection();
  if (!active) return 'no-connection';

  let token: string | undefined;
  if (isCapacitorApp()) {
    token = active.hasToken ? await readSecureToken(secureTokenKeyOf(active)) : undefined;
  } else {
    token = active.clientToken;
  }
  if (!token) return 'unreachable';

  const currentIndex = active.candidates.findIndex(
    (candidate) => transportMatchesCurrentRuntime(candidate.kind === 'relay' ? { kind: 'relay', relay: candidate.relay } : { kind: 'direct', url: candidate.url }),
  );

  // 1. A higher-priority transport becoming reachable means "came home" (relay → LAN).
  const higher = currentIndex >= 0 ? active.candidates.slice(0, currentIndex) : active.candidates;
  const better = await probeConnectionCandidates(higher, token, { fast: true });
  if (better.status === 'ok') {
    await upsertMobileConnection({ id: active.id, label: active.label, candidates: active.candidates });
    switchToTransport(better.transport, token, { runtimeKey: secureTokenKeyOf(active) });
    return 'switched';
  }
  if (better.status === 'needs-login') return 'unreachable';

  // 2. No better transport — is the current one still alive on its live channel?
  if (currentIndex >= 0) {
    const stillValid = await validateActiveRuntimeSession({ url: getRuntimeApiBaseUrl(), clientToken: token }, { fast: true });
    if (stillValid) {
      // Still on the same transport (typically: woke up on the relay, old LAN
      // candidate dead). Ask the server for its current LAN addresses in the
      // background — if it moved, the refreshed candidates trigger one more
      // re-probe and the hot-switch back to direct.
      scheduleCandidateRefresh();
      return 'unchanged';
    }
  }

  // 3. Current transport is dead — fall through to lower-priority candidates.
  const lower = currentIndex >= 0 ? active.candidates.slice(currentIndex + 1) : [];
  const fallback = await probeConnectionCandidates(lower, token, { fast: true });
  if (fallback.status === 'ok') {
    await upsertMobileConnection({ id: active.id, label: active.label, candidates: active.candidates });
    switchToTransport(fallback.transport, token, { runtimeKey: secureTokenKeyOf(active) });
    return 'switched';
  }
  return 'unreachable';
};

// ---------------------------------------------------------------------------
// Candidate refresh: learn the server's CURRENT direct addresses over the live
// (authenticated) runtime transport and update the saved candidate set, so a
// device that paired under an old DHCP lease is not stuck on the relay forever.
// ---------------------------------------------------------------------------

// Let the post-switch bootstrap traffic settle before adding our own request.
const CANDIDATE_REFRESH_DELAY_MS = 5_000;

type CandidateRefreshResult = 'updated' | 'unchanged' | 'skipped';

let candidateRefreshInFlight = false;

// Fetch /api/client-auth/connection/candidates through the ACTIVE runtime
// transport (direct or relay — runtimeFetch routes it) and merge the reported
// LAN addresses into the active saved connection:
//   - fresh `lan` candidates REPLACE the previous http:// (LAN-class) direct
//     candidates — a LAN address the server no longer holds is dead weight that
//     slows every future re-probe;
//   - https:// (tunnel-class) direct candidates are preserved — the server does
//     not know its own public tunnel hostnames;
//   - the relay candidate is preserved as the last-resort transport.
// Only runs for relay-paired connections: their token/runtime key derives from
// the stable relay identity, so rewriting direct URLs cannot orphan the stored
// token. The response must echo the connection's serverId or it is ignored.
export const refreshActiveConnectionCandidates = async (): Promise<CandidateRefreshResult> => {
  if (candidateRefreshInFlight) return 'skipped';
  const active = findActiveConnection();
  if (!active) return 'skipped';
  const relay = relayCandidateOf(active);
  if (!relay) return 'skipped';
  candidateRefreshInFlight = true;
  try {
    const response = await raceWithTimeout(
      RELAY_CONNECT_TIMEOUT_MS,
      runtimeFetch('/api/client-auth/connection/candidates').then((r): Response | null => r).catch(() => null),
    );
    if (!response?.ok) return 'skipped';
    const payload = await response.json().catch(() => null) as { serverId?: unknown; candidates?: unknown } | null;
    // Identity gate: the refresh must come from the server this device paired
    // with. Old servers (no serverId) are skipped rather than trusted blindly.
    if (!payload || payload.serverId !== relay.serverId) return 'skipped';
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
    // No LAN reported (loopback-only bind or interface-scan failure): keep the
    // existing candidates — deleting them on a possibly-transient empty answer
    // would be silent data loss; a stale entry only costs one fast probe.
    if (lanUrls.length === 0) return 'skipped';
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

// Background candidate refresh + opportunistic hot-switch. Fire-and-forget by
// design: no UI state, no rerenders — the only visible effect is the runtime
// quietly switching relay → direct when a fresh LAN address turns out reachable
// (reprobeActiveConnection re-reads storage and applies its usual identity-gated
// probe + stable-runtime-key switch). Converges: a re-entered refresh reports
// 'unchanged'/'skipped', which never triggers another re-probe.
const scheduleCandidateRefresh = (): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void (async () => {
      const result = await refreshActiveConnectionCandidates().catch((): CandidateRefreshResult => 'skipped');
      if (result === 'updated' && isRelayModeActive()) {
        await reprobeActiveConnection().catch(() => null);
      }
    })();
  }, CANDIDATE_REFRESH_DELAY_MS);
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
  redeemPairingConnection: (payload: PairingConnectionPayload) => Promise<void>;
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
  const [busyOperation, setBusyOperation] = React.useState<'connect' | 'password' | 'pairing' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = React.useState<MobilePendingConnection | null>(null);
  const connectionsRef = React.useRef(connections);
  const busyRef = React.useRef<'connect' | 'password' | 'pairing' | null>(null);

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

  // Refresh from storage on mount (runs the legacy-token migration too).
  React.useEffect(() => {
    let disposed = false;
    void loadMobileConnections().then((loaded) => {
      if (!disposed) applyConnections(loaded);
    });
    return () => { disposed = true; };
  }, [applyConnections]);

  // Persist metadata for a connection and reflect it in state immediately.
  const persistMetadata = React.useCallback((draft: { id?: string; label: string; candidates: MobileTransportCandidate[]; clientToken?: string }) => {
    const next = upsertConnectionInList(connectionsRef.current, draft);
    applyConnections(next);
    writeConnections(next);
    return next;
  }, [applyConnections]);

  const connect = React.useCallback(async (input: MobileConnectInput) => {
    setError(null);
    beginBusy('connect');
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
      const grant = input.relayGrant;

      // Resolve a token: explicit input wins, otherwise read the saved one.
      let token = input.clientToken?.trim() || undefined;
      const tokenIsNew = Boolean(token);
      if (!token) {
        if (isCapacitorApp()) {
          if (saved?.hasToken) token = await readSecureToken(secureTokenKeyOf({ candidates }));
        } else {
          token = saved?.clientToken;
        }
      }

      logConnect('connect:start', { candidates: candidates.map((c) => c.kind), hasToken: Boolean(token) });
      const result = await probeConnectionCandidates(candidates, token);
      logConnect('connect:probe', { status: result.status });

      if (result.status === 'unreachable') {
        setError(t('mobile.connect.error.unreachable'));
        return;
      }
      if (result.status === 'needs-login') {
        persistMetadata({ id: saved?.id, label, candidates });
        setPendingConnection({
          id: saved?.id ?? crypto.randomUUID(),
          label,
          candidates,
          relay: relayCandidateOf({ candidates }) ?? undefined,
          relayGrant: grant,
        });
        return;
      }

      // Connected. Persist a user-supplied token before switching so a cold
      // restart won't re-prompt.
      if (token && tokenIsNew && isCapacitorApp()) {
        await writeSecureToken(secureTokenKeyOf({ candidates }), token);
      }
      persistMetadata({ id: saved?.id, label, candidates, clientToken: token });
      switchToTransport(result.transport, token ?? null, { runtimeKey: secureTokenKeyOf({ candidates }), grant });
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] connect threw', error);
      setError(t('mobile.connect.error.invalidUrl'));
    } finally {
      endBusy('connect');
    }
  }, [beginBusy, endBusy, onConnected, persistMetadata, t]);

  const redeemPairingConnection = React.useCallback(async (payload: PairingConnectionPayload) => {
    if (busyRef.current === 'pairing') return;
    setError(null);
    beginBusy('pairing');
    const deviceCandidates = pairingCandidatesToMobile(payload.candidates);
    // A chosen relay transport owns an open tunnel; always close it.
    let chosen: LiveTransport | null = null;
    try {
      // 1. Find the first reachable transport across all candidates.
      chosen = await establishLiveTransport(deviceCandidates);
      if (!chosen) {
        setError(t('mobile.connect.error.unreachable'));
        return;
      }

      // 2. Redeem the one-time secret over that transport. Single-use: we never
      // retry other candidates once redeem runs (the secret is consumed).
      const redeemBody = JSON.stringify({
        pairingId: payload.pairingId,
        secret: payload.secret,
        clientLabel: 'OpenChamber Mobile',
        clientKind: 'mobile',
        deviceName: 'OpenChamber Mobile',
        devicePlatform: mobileDevicePlatform(),
        // Re-pairing this same phone reuses its one device record instead of
        // adding a duplicate row on the server.
        dedupeKey: mobileClientDedupeKey(),
      });
      const redeemInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: redeemBody,
      } as const;
      const response = chosen.kind === 'relay'
        ? await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, chosen.tunnel.fetch('/api/client-auth/pairing/redeem', redeemInit).catch(() => null))
        : await requestWithTimeout(`${chosen.url}/api/client-auth/pairing/redeem`, redeemInit);
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
      // Name the connection by the issuing server (its hostname), not the
      // per-device pairing label — that label is the operator's name for THIS
      // phone in their device list, not a name for the server we connect to.
      const serverLabel = typeof result?.server?.label === 'string' ? result.server.label : '';
      const label = payload.label || serverLabel || getConnectionLabel(connectionDisplayUrl({ candidates: deviceCandidates }));

      // 3. Persist the device with ALL its candidates + one token, then switch to
      // whichever transport answered. Reconnect re-probes the full set so the
      // device works at home (direct) and away (relay) with no re-pairing.
      if (isCapacitorApp()) {
        const stored = await writeSecureToken(secureTokenKeyOf({ candidates: deviceCandidates }), issuedToken);
        if (!stored) {
          setError(t('mobile.connect.error.authRequired'));
          return;
        }
      }
      persistMetadata({ label, candidates: deviceCandidates, clientToken: issuedToken });
      switchToTransport(
        chosen.kind === 'relay' ? { kind: 'relay', relay: chosen.relay } : { kind: 'direct', url: chosen.url },
        issuedToken,
        { runtimeKey: secureTokenKeyOf({ candidates: deviceCandidates }) },
      );
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] pairing threw', error);
      setError(t('mobile.connect.error.authRequired'));
    } finally {
      if (chosen?.kind === 'relay') chosen.tunnel.close();
      endBusy('pairing');
    }
  }, [beginBusy, endBusy, onConnected, persistMetadata, t]);

  const submitPassword = React.useCallback(async (password: string) => {
    if (!pendingConnection || !password.trim() || busyRef.current === 'password') return;
    setError(null);
    beginBusy('password');
    const { id, label, candidates } = pendingConnection;
    // A chosen relay transport owns an open tunnel; always close it.
    let chosen: LiveTransport | null = null;
    try {
      // Log in over whichever transport is reachable. Relay login rides the
      // tunnel; cookies never cross it, so an issued bearer token is mandatory
      // there. `issueClientToken` mints the device's token in one round-trip.
      chosen = await establishLiveTransport(candidates);
      if (!chosen) {
        setError(t('mobile.connect.error.unreachable'));
        return;
      }
      const loginInit = {
        method: 'POST',
        credentials: 'include' as const,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // Same dedupe key as pairing: re-authenticating after a token expires
        // reuses this phone's existing device record instead of duplicating it.
        body: JSON.stringify({ password, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Mobile', clientKind: 'mobile', devicePlatform: mobileDevicePlatform(), dedupeKey: mobileClientDedupeKey() }),
      };
      logConnect('password:start', { transport: chosen.kind });
      const response = chosen.kind === 'relay'
        ? await raceWithTimeout(RELAY_CONNECT_TIMEOUT_MS, chosen.tunnel.fetch('/auth/session', loginInit).catch(() => null))
        : await requestWithTimeout(`${chosen.url}/auth/session`, loginInit);
      logConnect('password:done', { ok: response?.ok === true, status: response?.status ?? null });
      if (!response?.ok) {
        setError(t('mobile.connect.error.passwordFailed'));
        return;
      }
      const body = await response.json().catch(() => null) as { clientToken?: unknown } | null;
      const issuedToken = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      logConnect('password:token', { issued: Boolean(issuedToken) });

      // A bearer token is required for relay (no cookies over the tunnel) and for
      // the native runtime transport; a cookie-only success is only enough for a
      // direct connection in a browser.
      if (!issuedToken) {
        if (chosen.kind === 'direct' && !isCapacitorApp()) {
          persistMetadata({ id, label, candidates });
          setPendingConnection(null);
          switchToTransport({ kind: 'direct', url: chosen.url }, null, { runtimeKey: secureTokenKeyOf({ candidates }) });
          onConnected();
          return;
        }
        setError(t('mobile.connect.error.authRequired'));
        return;
      }

      // Persist the token BEFORE switching (no fire-and-forget).
      if (isCapacitorApp()) {
        await writeSecureToken(secureTokenKeyOf({ candidates }), issuedToken);
      }
      persistMetadata({ id, label, candidates, clientToken: issuedToken });
      setPendingConnection(null);
      switchToTransport(
        chosen.kind === 'relay' ? { kind: 'relay', relay: chosen.relay } : { kind: 'direct', url: chosen.url },
        issuedToken,
        { runtimeKey: secureTokenKeyOf({ candidates }) },
      );
      onConnected();
    } catch (error) {
      console.warn('[mobile-connect] password threw', error);
      setError(t('mobile.connect.error.passwordFailed'));
    } finally {
      if (chosen?.kind === 'relay') chosen.tunnel.close();
      endBusy('password');
    }
  }, [beginBusy, endBusy, onConnected, pendingConnection, persistMetadata, t]);

  const cancelPassword = React.useCallback(() => {
    setPendingConnection(null);
    setError(null);
  }, []);

  const saveConnection = React.useCallback(async (input: MobileConnectInput): Promise<MobileSavedConnection | null> => {
    setError(null);
    const candidates = buildCandidatesFromInput(input);
    if (candidates.length === 0) {
      setError(t('mobile.connect.error.urlRequired'));
      return null;
    }
    const clientToken = input.clientToken?.trim() || undefined;
    const label = input.label?.trim() || getConnectionLabel(connectionDisplayUrl({ candidates }));
    // Awaited token write so "Save" truly persisted the secret before returning.
    if (isCapacitorApp() && clientToken) {
      await writeSecureToken(secureTokenKeyOf({ candidates }), clientToken);
    }
    const next = persistMetadata({ id: input.id, label, candidates, clientToken });
    return next.find((connection) => candidateSetsMatch(connection.candidates, candidates)) ?? null;
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
    redeemPairingConnection,
    submitPassword,
    cancelPassword,
    saveConnection,
    removeConnection,
    setError,
  };
};
