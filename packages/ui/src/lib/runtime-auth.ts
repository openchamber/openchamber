export type RuntimeAuthCredential =
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
  runtimeUrlAuthToken = normalized;
  runtimeUrlAuthTokenExpiresAt = expiresAt;
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

export const getRuntimeAuthCredential = async (): Promise<RuntimeAuthCredential> => {
  const credential = await credentialProvider();
  const token = credential?.type === 'bearer'
    ? normalizeBearerToken(credential.token)
    : getRuntimeBearerTokenSync();
  return token ? { type: 'bearer', token } : null;
};

export const refreshRuntimeUrlAuthToken = async (apiBaseUrl?: string | null): Promise<string> => {
  const existing = readValidRuntimeUrlAuthTokenSync();
  if (existing) return existing;
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

export const buildRuntimeAuthHeaders = async (headers?: HeadersInit): Promise<Headers> => {
  const next = new Headers(headers);
  if (next.has('Authorization')) {
    return next;
  }

  const credential = await getRuntimeAuthCredential();
  if (credential?.type === 'bearer') {
    next.set('Authorization', `Bearer ${credential.token}`);
  }
  return next;
};
