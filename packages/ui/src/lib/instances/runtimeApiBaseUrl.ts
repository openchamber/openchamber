import { resolveSelectedInstance } from '@/stores/useInstancesStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { getAccessToken } from '@/lib/auth/tokenStorage';
import { isMobileRuntime } from '@/lib/desktop';

const DEFAULT_API_BASE_URL = import.meta.env.VITE_OPENCODE_URL || '/api';

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');
const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);
const INSTANCES_STORE_KEY = 'instances-store';
const DEV_PROXY_PORTS = new Set(['5173', '4173']);

type PersistedInstancesShape = {
  state?: {
    instances?: Array<{ id?: unknown; apiBaseUrl?: unknown }>;
    currentInstanceId?: unknown;
    defaultInstanceId?: unknown;
  };
};

const isHttpApiBaseUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return parsed.pathname.replace(/\/+$/, '').endsWith('/api');
  } catch {
    return false;
  }
};

const resolvePersistedInstanceApiBaseUrl = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage?.getItem(INSTANCES_STORE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedInstancesShape;
    const state = parsed?.state;
    const instances = Array.isArray(state?.instances) ? state.instances : [];
    if (instances.length === 0) {
      return null;
    }
    const currentId = typeof state?.currentInstanceId === 'string' ? state.currentInstanceId : null;
    const defaultId = typeof state?.defaultInstanceId === 'string' ? state.defaultInstanceId : null;

    const byCurrent = currentId
      ? instances.find((entry) => typeof entry?.id === 'string' && entry.id === currentId)
      : null;
    const byDefault = defaultId
      ? instances.find((entry) => typeof entry?.id === 'string' && entry.id === defaultId)
      : null;
    const candidate = byCurrent || byDefault || instances[0] || null;
    if (!candidate || !isHttpApiBaseUrl(candidate.apiBaseUrl)) {
      return null;
    }
    return candidate.apiBaseUrl.trim();
  } catch {
    return null;
  }
};

const isLoopbackHost = (value: string): boolean => {
  const host = value.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
};

const shouldUseDevProxyApiBase = (candidateApiBaseUrl: string): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  let currentOrigin: URL;
  try {
    currentOrigin = new URL(window.location.origin);
  } catch {
    return false;
  }

  if ((currentOrigin.protocol !== 'http:' && currentOrigin.protocol !== 'https:') || !isLoopbackHost(currentOrigin.hostname)) {
    return false;
  }

  if (!DEV_PROXY_PORTS.has(currentOrigin.port)) {
    return false;
  }

  try {
    const parsedCandidate = new URL(candidateApiBaseUrl);
    if ((parsedCandidate.protocol !== 'http:' && parsedCandidate.protocol !== 'https:') || !isLoopbackHost(parsedCandidate.hostname)) {
      return false;
    }
    return parsedCandidate.pathname.replace(/\/+$/, '').endsWith('/api');
  } catch {
    return false;
  }
};

const resolveDesktopApiBaseUrl = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const runtimeApis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__;
  const desktopServer = window.__OPENCHAMBER_DESKTOP_SERVER__;
  const isDesktop = runtimeApis?.runtime?.isDesktop === true;

  if (!isDesktop || !desktopServer || typeof desktopServer.origin !== 'string' || desktopServer.origin.trim().length === 0) {
    return null;
  }

  return `${trimTrailingSlashes(desktopServer.origin.trim())}/api`;
};

export const resolveRuntimeApiBaseUrl = (): string => {
  const desktopBaseUrl = resolveDesktopApiBaseUrl();
  if (desktopBaseUrl) {
    return desktopBaseUrl;
  }

  const selectedInstance = resolveSelectedInstance();
  if (selectedInstance && typeof selectedInstance.apiBaseUrl === 'string' && selectedInstance.apiBaseUrl.trim().length > 0) {
    const selectedApiBaseUrl = selectedInstance.apiBaseUrl.trim();
    if (shouldUseDevProxyApiBase(selectedApiBaseUrl)) {
      return DEFAULT_API_BASE_URL;
    }
    return selectedApiBaseUrl;
  }

  if (isMobileRuntime()) {
    const persistedMobileApiBase = resolvePersistedInstanceApiBaseUrl();
    if (persistedMobileApiBase) {
      if (shouldUseDevProxyApiBase(persistedMobileApiBase)) {
        return DEFAULT_API_BASE_URL;
      }
      return persistedMobileApiBase;
    }
  }

  return DEFAULT_API_BASE_URL;
};

export const resolveRuntimeApiEndpoint = (path: string): string => {
  const base = trimTrailingSlashes(resolveRuntimeApiBaseUrl() || '/api');
  return `${base}${ensureLeadingSlash(path)}`;
};

export const buildRuntimeApiHeaders = (overrides?: HeadersInit): Headers => {
  const headers = new Headers(overrides ?? undefined);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  if (!headers.has('Authorization')) {
    const selected = resolveSelectedInstance();
    if (selected?.id) {
      const token = getAccessToken(selected.id);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }
  }

  return headers;
};
