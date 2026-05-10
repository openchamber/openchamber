import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from '@alias-ade/ui/lib/api/types';

// Use same endpoints as web - fetch interceptor handles URL rewriting
const SETTINGS_ENDPOINT = '/api/config/settings';
const RELOAD_ENDPOINT = '/api/config/reload';

const sanitizePayload = (data: unknown): SettingsPayload => {
  if (!data || typeof data !== 'object') {
    return {};
  }
  return data as SettingsPayload;
};

export const createVSCodeSettingsAPI = (): SettingsAPI => ({
  async load(): Promise<SettingsLoadResult> {
    const response = await fetch(SETTINGS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      // Fallback to VS Code config
      return {
        settings: {
          themeVariant: window.__VSCODE_CONFIG__?.theme === 'light' ? 'light' : 'dark',
          lastDirectory: window.__VSCODE_CONFIG__?.workspaceFolder || '',
        },
        source: 'web',
      };
    }

    const payload = sanitizePayload(await response.json().catch(() => ({})));
    return {
      settings: {
        ...payload,
        // Override with VS Code settings
        lastDirectory: window.__VSCODE_CONFIG__?.workspaceFolder || payload.lastDirectory || '',
      },
      source: 'web',
    };
  },

  async save(changes: Partial<SettingsPayload>): Promise<SettingsPayload> {
    const response = await fetch(SETTINGS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
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
    const response = await fetch(RELOAD_ENDPOINT, { method: 'POST' });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Failed to restart OpenCode');
    }
    return { restarted: true };
  },
});
