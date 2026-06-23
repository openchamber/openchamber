type RuntimeAuthCredential =
  | { type: 'bearer'; token: string }
  | null;

export type RuntimeAuthCredentialProvider = () => RuntimeAuthCredential | Promise<RuntimeAuthCredential>;

let credentialProvider: RuntimeAuthCredentialProvider = () => null;
let runtimeBearerToken = '';
let runtimeUrlAuthToken = '';
let runtimeUrlAuthTokenExpiresAt = 0;
let runtimeUrlAuthRefreshPromise: Promise<string> | null = null;
let runtimeAuthGeneration = 0;

const URL_AUTH_REFRESH_SKEW_MS = 10_000;

const normalizeBearerToken = (token: string | null | undefined): string => {
  if (typeof token !== 'string') return '';
  return token.trim();
};

const readInjectedBearerToken = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_CLIENT_TOKEN__?: string }).__OPENCHAMBER_CLIENT_TOKEN__;
  return normalizeBearerToken(injected);
};

const readInjectedApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const buildAuthUrl = (apiBaseUrl: string | null | undefined, path: string): string => {
  const base = typeof apiBaseUrl === 'string' && apiBaseUrl.trim()
    ? apiBaseUrl.trim()
    : readInjectedApiBaseUrl();
  if (!base) return path;
  try {
    return new URL(path, `${base.replace(/\/+$/, '')}/`).toString();
  } catch {
    return path;
  }
};

export const clearRuntimeUrlAuthToken = (): void => {
  runtimeUrlAuthToken = '';
  runtimeUrlAuthTokenExpiresAt = 0;
};

const resetRuntimeAuthGeneration = (): void => {
  runtimeAuthGeneration += 1;
  runtimeUrlAuthRefreshPromise = null;
  clearRuntimeUrlAuthToken();
  // Credentials changed: if a consumer is active, re-mint promptly.
  scheduleUrlAuthRefresh();
};

export const setRuntimeAuthCredentialProvider = (provider: RuntimeAuthCredentialProvider): void => {
  runtimeBearerToken = '';
  resetRuntimeAuthGeneration();
  credentialProvider = provider;
};

export const clearRuntimeAuthCredentialProvider = (): void => {
  runtimeBearerToken = '';
  resetRuntimeAuthGeneration();
  credentialProvider = () => null;
};

export const setRuntimeBearerToken = (token: string | null | undefined): void => {
  const normalized = normalizeBearerToken(token);
  runtimeBearerToken = normalized;
  resetRuntimeAuthGeneration();
  credentialProvider = () => normalized ? { type: 'bearer', token: normalized } : null;
};

export const getRuntimeBearerTokenSync = (): string => runtimeBearerToken || readInjectedBearerToken();

export const setRuntimeUrlAuthToken = (token: string | null | undefined, expiresAt: number | null | undefined): void => {
  const normalized = normalizeBearerToken(token);
  if (!normalized || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    clearRuntimeUrlAuthToken();
    return;
  }
  const previous = runtimeUrlAuthToken;
  runtimeUrlAuthToken = normalized;
  runtimeUrlAuthTokenExpiresAt = expiresAt;
  // Notify only on a real replacement (existing token swapped for a fresh one),
  // not on the initial mint, so consumers remount token-bearing assets only
  // when the URL token actually changed underneath them.
  if (previous && previous !== normalized) {
    notifyRuntimeUrlAuthListeners();
  }
};

const readValidRuntimeUrlAuthTokenSync = (): string => {
  if (!runtimeUrlAuthToken || runtimeUrlAuthTokenExpiresAt <= Date.now() + URL_AUTH_REFRESH_SKEW_MS) {
    clearRuntimeUrlAuthToken();
    return '';
  }
  return runtimeUrlAuthToken;
};

export const getRuntimeUrlAuthTokenSync = (): string => {
  const token = readValidRuntimeUrlAuthTokenSync();
  if (!token && (getRuntimeBearerTokenSync() || typeof window !== 'undefined')) {
    void refreshRuntimeUrlAuthToken().catch(() => {});
  }
  return token;
};

const getRuntimeAuthCredential = async (): Promise<RuntimeAuthCredential> => {
  const credential = await credentialProvider();
  const token = credential?.type === 'bearer'
    ? normalizeBearerToken(credential.token)
    : getRuntimeBearerTokenSync();
  return token ? { type: 'bearer', token } : null;
};

// Performs the actual network mint and swaps the new token in atomically (the
// previous token stays valid until `setRuntimeUrlAuthToken` replaces it — no
// empty-token window). Concurrent callers share one in-flight request.
const mintRuntimeUrlAuthToken = (apiBaseUrl?: string | null): Promise<string> => {
  if (runtimeUrlAuthRefreshPromise) return runtimeUrlAuthRefreshPromise;
  const generation = runtimeAuthGeneration;

  const refreshPromise = (async () => {
    const credential = await getRuntimeAuthCredential();
    const headers = new Headers();
    if (credential?.type === 'bearer') {
      headers.set('Authorization', `Bearer ${credential.token}`);
    }
    const response = await fetch(buildAuthUrl(apiBaseUrl, '/auth/url-token'), {
      method: 'POST',
      headers,
      credentials: 'include',
    });
    if (!response.ok) {
      if (generation === runtimeAuthGeneration) {
        clearRuntimeUrlAuthToken();
      }
      throw new Error(`Failed to mint runtime URL auth token (${response.status})`);
    }
    const payload = await response.json().catch(() => null) as { token?: unknown; expiresAt?: unknown } | null;
    const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
    const expiresAt = typeof payload?.expiresAt === 'number' ? payload.expiresAt : 0;
    if (generation !== runtimeAuthGeneration) {
      throw new Error('Runtime URL auth token response is stale');
    }
    setRuntimeUrlAuthToken(token, expiresAt);
    if (!runtimeUrlAuthToken) {
      throw new Error('Runtime URL auth token response was invalid');
    }
    return runtimeUrlAuthToken;
  })();
  const trackedPromise = refreshPromise.finally(() => {
    if (runtimeUrlAuthRefreshPromise === trackedPromise) {
      runtimeUrlAuthRefreshPromise = null;
    }
  });
  runtimeUrlAuthRefreshPromise = trackedPromise;

  return runtimeUrlAuthRefreshPromise;
};

// Returns a valid token without a network call, minting only when the current
// token is missing or already inside the skew window.
export const refreshRuntimeUrlAuthToken = async (apiBaseUrl?: string | null): Promise<string> => {
  const existing = readValidRuntimeUrlAuthTokenSync();
  if (existing) return existing;
  return mintRuntimeUrlAuthToken(apiBaseUrl);
};

// ── Proactive URL auth token refresh ──────────────────────────────────────
// The url token has a short server TTL. Instead of each consumer minting on its
// own timer (and clearing the shared token, which 401s other consumers during
// the refetch), a single scheduler refreshes it just before the skew window —
// but only while at least one consumer is active, so we never poll
// /auth/url-token in the background when nothing needs the token.
let urlAuthConsumerCount = 0;
let urlAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let urlAuthApiBaseUrl: string | null = null;
const urlAuthListeners = new Set<() => void>();
const URL_AUTH_PROACTIVE_BUFFER_MS = 5_000;

const notifyRuntimeUrlAuthListeners = (): void => {
  for (const listener of urlAuthListeners) {
    try {
      listener();
    } catch {
      // A listener throwing must not break the refresh loop.
    }
  }
};

const clearUrlAuthRefreshTimer = (): void => {
  if (urlAuthRefreshTimer !== null) {
    clearTimeout(urlAuthRefreshTimer);
    urlAuthRefreshTimer = null;
  }
};

const scheduleUrlAuthRefresh = (): void => {
  clearUrlAuthRefreshTimer();
  if (urlAuthConsumerCount <= 0 || typeof window === 'undefined') return;

  // Refresh before the skew window so the old token is still valid when the new
  // one swaps in. With no token yet (expiry 0), refresh immediately.
  const refreshAt = runtimeUrlAuthTokenExpiresAt - URL_AUTH_REFRESH_SKEW_MS - URL_AUTH_PROACTIVE_BUFFER_MS;
  const delay = runtimeUrlAuthTokenExpiresAt > 0 ? Math.max(0, refreshAt - Date.now()) : 0;

  urlAuthRefreshTimer = setTimeout(() => {
    urlAuthRefreshTimer = null;
    if (urlAuthConsumerCount <= 0) return;
    void mintRuntimeUrlAuthToken(urlAuthApiBaseUrl)
      .catch(() => {
        // Transient — the reschedule below retries (token is cleared on
        // failure → expiry 0 → delay 0 → prompt retry).
      })
      .finally(() => {
        scheduleUrlAuthRefresh();
      });
  }, delay);
};

// Register an active url-token consumer. While any consumer is held, the token
// is proactively refreshed before it expires. Returns a release function;
// the proactive loop stops once the last consumer releases.
export const acquireRuntimeUrlAuthToken = (apiBaseUrl?: string | null): (() => void) => {
  if (typeof apiBaseUrl === 'string' && apiBaseUrl.trim()) {
    urlAuthApiBaseUrl = apiBaseUrl.trim();
  }
  urlAuthConsumerCount += 1;
  scheduleUrlAuthRefresh();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    urlAuthConsumerCount = Math.max(0, urlAuthConsumerCount - 1);
    if (urlAuthConsumerCount === 0) {
      clearUrlAuthRefreshTimer();
    }
  };
};

// Subscribe to url-token *replacements* (an existing token swapped for a fresh
// one). Fires only on a real change — not the initial mint — so consumers can
// remount token-bearing assets without churning on first load. Returns an
// unsubscribe function.
export const subscribeRuntimeUrlAuthToken = (listener: () => void): (() => void) => {
  urlAuthListeners.add(listener);
  return () => {
    urlAuthListeners.delete(listener);
  };
};

// Read Basic auth credentials from localStorage. In proxy-bypass mode the browser
// SDK targets an external OpenCode upstream that requires HTTP Basic auth; the
// password isn't shipped in the bundle, so we read it from localStorage at
// runtime. Cache in module scope to avoid re-parsing on every SDK call.
//
// SETUP (manual): after deploying this build, each user must run once in
// DevTools console:
//   localStorage.setItem('openchamber.credentials', JSON.stringify({
//     username: 'opencode',
//     password: '<OPENCODE_SERVER_PASSWORD>'
//   }));
// Then reload. The credential persists across reloads.
//
// A future improvement would be to inject this script server-side from
// static-routes-runtime.js (env OPENCODE_SERVER_PASSWORD → inline <script>
// before </head>). That requires editing packages/web/server/lib/opencode/
// static-routes-runtime.js — the patch was attempted but the multi-file
// conflict resolution kept breaking, so the manual workaround stands.
interface BasicCredential { username: string; password: string }
let basicCredentialCache: BasicCredential | null | undefined;
const readBasicCredential = (): BasicCredential | null => {
  if (basicCredentialCache !== undefined) return basicCredentialCache;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage?.getItem('openchamber.credentials');
    if (!raw) { basicCredentialCache = null; return null; }
    const parsed = JSON.parse(raw);
    const username = typeof parsed?.username === 'string' ? parsed.username.trim() : '';
    const password = typeof parsed?.password === 'string' ? parsed.password : '';
    if (!username || !password) { basicCredentialCache = null; return null; }
    basicCredentialCache = { username, password };
    return basicCredentialCache;
  } catch {
    basicCredentialCache = null;
    return null;
  }
};

export const buildRuntimeAuthHeaders = async (headers?: HeadersInit): Promise<Headers> => {
  const next = new Headers(headers);
  if (next.has('Authorization')) {
    return next;
  }

  // Basic auth (set via localStorage by static-routes-runtime injection or
  // by the user) takes priority — it's what the external OpenCode upstream
  // expects in proxy-bypass mode.
  const basic = readBasicCredential();
  if (basic) {
    const token = typeof btoa === 'function'
      ? btoa(`${basic.username}:${basic.password}`)
      : Buffer.from(`${basic.username}:${basic.password}`).toString('base64');
    next.set('Authorization', `Basic ${token}`);
    return next;
  }

  const credential = await getRuntimeAuthCredential();
  if (credential?.type === 'bearer') {
    next.set('Authorization', `Bearer ${credential.token}`);
  }
  return next;
};
