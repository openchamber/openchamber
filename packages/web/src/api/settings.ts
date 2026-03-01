import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from '@openchamber/ui/lib/api/types';
import { resolveRuntimeApiBaseUrl } from '@openchamber/ui/lib/instances/runtimeApiBaseUrl';
import { resolveSelectedInstance } from '@openchamber/ui/stores/useInstancesStore';
import { getAccessToken } from '@openchamber/ui/lib/auth/tokenStorage';

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

const resolveEndpoint = (path: string): string => {
  const base = trimTrailingSlashes(resolveRuntimeApiBaseUrl() || '/api');
  return `${base}${path}`;
};

const buildHeaders = (overrides?: HeadersInit): Headers => {
  const headers = new Headers(overrides ?? undefined);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  if (!headers.has('Authorization')) {
    const selected = resolveSelectedInstance();
    if (selected?.id) {
      const accessToken = getAccessToken(selected.id);
      if (accessToken) {
        headers.set('Authorization', `Bearer ${accessToken}`);
      }
    }
  }

  return headers;
};

const sanitizePayload = (data: unknown): SettingsPayload => {
  if (!data || typeof data !== 'object') {
    return {};
  }
  return data as SettingsPayload;
};

export const createWebSettingsAPI = (): SettingsAPI => ({
  async load(): Promise<SettingsLoadResult> {
    const response = await fetch(resolveEndpoint('/config/settings'), {
      method: 'GET',
      headers: buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to load settings: ${response.statusText}`);
    }

    const payload = sanitizePayload(await response.json().catch(() => ({})));
    return {
      settings: payload,
      source: 'web',
    };
  },

  async save(changes: Partial<SettingsPayload>): Promise<SettingsPayload> {
    const response = await fetch(resolveEndpoint('/config/settings'), {
      method: 'PUT',
      headers: buildHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(changes),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to save settings');
    }

    const payload = sanitizePayload(await response.json().catch(() => ({})));
    return payload;
  },

  async restartOpenCode(): Promise<{ restarted: boolean }> {
    const response = await fetch(resolveEndpoint('/config/reload'), {
      method: 'POST',
      headers: buildHeaders(),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to restart OpenCode');
    }
    return { restarted: true };
  },
});
