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
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const MOBILE_CONNECTIONS_STORAGE_KEY = 'openchamber.mobile.connections.v1';
const MOBILE_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';
const MOBILE_CONNECTIONS_LIMIT = 12;
const MOBILE_CONNECT_TIMEOUT_MS = 8000;
const MOBILE_NATIVE_HTTP_TIMEOUT_MS = 2500;
const MOBILE_SECURE_TIMEOUT_MS = 3000;

export type MobileSavedConnection = {
  id: string;
  label: string;
  url: string;
  lastUsedAt: number;
  // Native: indicates a token exists in the secure store. Web: unused.
  hasToken?: boolean;
  // Web only: the token stored inline. On native this stays undefined in the list.
  clientToken?: string;
};

export type MobilePendingConnection = {
  label: string;
  url: string;
};

export type MobileConnectInput = {
  url: string;
  clientToken?: string;
  label?: string;
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

const readSessionStatus = async (response: MobileFetchResponse | null): Promise<MobileSessionStatus | null> => {
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
      const inlineToken = typeof c.clientToken === 'string' && c.clientToken.trim() ? c.clientToken : undefined;
      const base: MobileSavedConnection = {
        id: c.id,
        label: typeof c.label === 'string' && c.label.trim() ? c.label : getConnectionLabel(c.url),
        url: c.url,
        lastUsedAt: typeof c.lastUsedAt === 'number' ? c.lastUsedAt : 0,
      };
      if (native) return [{ ...base, hasToken: Boolean(c.hasToken) || Boolean(inlineToken) }];
      return [{ ...base, clientToken: inlineToken, hasToken: Boolean(inlineToken) }];
    })
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
};

const writeConnections = (connections: MobileSavedConnection[]): void => {
  if (typeof window === 'undefined') return;
  const native = isCapacitorApp();
  const serialized = connections.slice(0, MOBILE_CONNECTIONS_LIMIT).map((c) => (
    native
      ? { id: c.id, label: c.label, url: c.url, lastUsedAt: c.lastUsedAt, hasToken: Boolean(c.hasToken || c.clientToken) }
      : { id: c.id, label: c.label, url: c.url, lastUsedAt: c.lastUsedAt, clientToken: c.clientToken }
  ));
  try {
    window.localStorage.setItem(MOBILE_CONNECTIONS_STORAGE_KEY, JSON.stringify(serialized));
  } catch (error) {
    console.warn('[mobile-storage] failed to persist connection metadata', error);
  }
};

const upsertConnectionInList = (
  connections: MobileSavedConnection[],
  draft: { label: string; url: string; clientToken?: string; hasToken?: boolean },
): MobileSavedConnection[] => {
  const key = getConnectionStorageKey(draft.url);
  const existing = connections.find((item) => getConnectionStorageKey(item.url) === key);
  const native = isCapacitorApp();
  const next: MobileSavedConnection = {
    id: existing?.id || crypto.randomUUID(),
    label: draft.label,
    url: draft.url,
    lastUsedAt: Date.now(),
    ...(native
      ? { hasToken: draft.hasToken ?? (Boolean(draft.clientToken) || existing?.hasToken || false) }
      : { clientToken: draft.clientToken ?? existing?.clientToken, hasToken: Boolean(draft.clientToken ?? existing?.clientToken) }),
  };
  return [
    next,
    ...connections.filter((item) => item.id !== next.id && getConnectionStorageKey(item.url) !== key),
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

const prefixedTokenKey = (url: string): string =>
  `${MOBILE_SECURE_STORAGE_PREFIX}token.${encodeURIComponent(getConnectionStorageKey(url))}`;

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

const readSecureToken = async (url: string): Promise<string | undefined> => {
  logStorage('secure:read-start', { url });
  const value = await boundedSecure(
    'secure:read',
    async () => (await nativeSecure.internalGetItem({ prefixedKey: prefixedTokenKey(url), sync: false })).data,
    null,
  );
  const token = typeof value === 'string' && value.trim() ? value : undefined;
  logStorage('secure:read', { url, hasToken: Boolean(token) });
  return token;
};

const writeSecureToken = async (url: string, token: string): Promise<boolean> => {
  logStorage('secure:write-start', { url });
  const ok = await boundedSecure('secure:write', async () => {
    await nativeSecure.internalSetItem({
      prefixedKey: prefixedTokenKey(url),
      data: token,
      sync: false,
      access: KEYCHAIN_ACCESS_WHEN_UNLOCKED,
    });
    return true;
  }, false);
  logStorage('secure:write', { url, ok });
  return ok;
};

const deleteSecureToken = async (url: string): Promise<void> => {
  await boundedSecure('secure:delete', async () => {
    await nativeSecure.internalRemoveItem({ prefixedKey: prefixedTokenKey(url), sync: false });
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
    await writeSecureToken(url, clientToken);
  }
  writeConnections(readConnections());
  logStorage('secure:migrate-done', { count: legacy.length });
};

export const loadMobileConnections = async (): Promise<MobileSavedConnection[]> => {
  await migrateLegacyInlineTokens();
  return readConnections();
};

export const upsertMobileConnection = async (
  connection: { label: string; url: string; clientToken?: string },
): Promise<MobileSavedConnection[]> => {
  const next = upsertConnectionInList(readConnections(), connection);
  writeConnections(next);
  if (isCapacitorApp() && connection.clientToken) {
    await writeSecureToken(connection.url, connection.clientToken);
  }
  return next;
};

export const deleteMobileConnection = async (id: string): Promise<MobileSavedConnection[]> => {
  const connections = readConnections();
  const removed = connections.find((connection) => connection.id === id) ?? null;
  const next = connections.filter((connection) => connection.id !== id);
  writeConnections(next);
  if (removed && isCapacitorApp()) await deleteSecureToken(removed.url);
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

  const url = normalizeConnectionUrl(candidate.url);
  if (!url) return false;

  // The native runtime transport needs a bearer token; only auto-connect when one is
  // already saved. A missing/expired token must go through the login UI, not silently.
  let token: string | undefined;
  if (isCapacitorApp()) {
    if (!candidate.hasToken) return false;
    token = await readSecureToken(url);
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
  const persistMetadata = React.useCallback((draft: { label: string; url: string; clientToken?: string }) => {
    const next = upsertConnectionInList(connectionsRef.current, draft);
    applyConnections(next);
    writeConnections(next);
    return next;
  }, [applyConnections]);

  const connect = React.useCallback(async (input: MobileConnectInput) => {
    setError(null);
    beginBusy('connect');
    try {
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
        const saved = connectionsRef.current.find((c) => isSameConnectionUrl(c.url, url));
        if (saved?.hasToken) token = await readSecureToken(url);
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
        await writeSecureToken(url, token);
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
        await writeSecureToken(url, issuedToken);
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
    const url = normalizeConnectionUrl(input.url);
    if (!url) {
      setError(t('mobile.connect.error.urlRequired'));
      return null;
    }
    const clientToken = input.clientToken?.trim() || undefined;
    const label = input.label?.trim() || getConnectionLabel(url);
    // Awaited token write so "Save" truly persisted the secret before returning.
    if (isCapacitorApp() && clientToken) {
      await writeSecureToken(url, clientToken);
    }
    const next = persistMetadata({ label, url, clientToken });
    return next.find((connection) => isSameConnectionUrl(connection.url, url)) ?? null;
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
