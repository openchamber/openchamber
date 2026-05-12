import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDebouncedJSONStorage } from './utils/debouncedStorage';
import {
  startConfigUpdate,
  finishConfigUpdate,
} from '@/lib/configUpdate';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';

export type McpScope = 'user' | 'project';

type McpMutationResult = {
  ok: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
};

const getConfigDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[McpConfigStore] Error resolving config directory:', err);
  }
  return null;
};

// ============== TYPES ==============

export interface McpLocalConfig {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: boolean;
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

export interface McpRemoteConfig {
  type: 'remote';
  url: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
  enabled: boolean;
}

export type McpServerConfig = (McpLocalConfig | McpRemoteConfig) & { name: string };
export type McpServerWithScope = McpServerConfig & { scope?: McpScope | null };

export interface McpDraft {
  name: string;
  scope: McpScope;
  type: 'local' | 'remote';
  command: string[];
  url: string;
  environment: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  oauthEnabled: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthRedirectUri: string;
  timeout: string;
  enabled: boolean;
}

// ============== HELPERS ==============

export const envRecordToArray = (env?: Record<string, string>): Array<{ key: string; value: string }> => {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
};

export const envArrayToRecord = (arr: Array<{ key: string; value: string }>): Record<string, string> | undefined => {
  const filtered = arr.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  return Object.fromEntries(filtered.map((e) => [e.key.trim(), e.value]));
};

const trimOptionalString = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const CLIENT_RELOAD_DELAY_MS = 800;
const MCP_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_MCP_CACHE_KEY = '__default__';
const mcpLastLoadedAt = new Map<string, number>();
const mcpLoadInFlight = new Map<string, Promise<boolean>>();

const getMcpCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_MCP_CACHE_KEY;
};

// ============== STORE ==============

interface McpConfigStore {
  mcpServers: McpServerWithScope[];
  selectedMcpName: string | null;
  isLoading: boolean;
  mcpDraft: McpDraft | null;

  setSelectedMcp: (name: string | null) => void;
  setMcpDraft: (draft: McpDraft | null) => void;
  loadMcpConfigs: (options?: { force?: boolean }) => Promise<boolean>;
  createMcp: (config: McpDraft) => Promise<McpMutationResult>;
  updateMcp: (name: string, config: Partial<McpDraft>) => Promise<McpMutationResult>;
  deleteMcp: (name: string) => Promise<McpMutationResult>;
  getMcpByName: (name: string) => McpServerWithScope | undefined;
}

const invalidateMcpCache = (directory: string | null) => {
  mcpLastLoadedAt.delete(getMcpCacheKey(directory));
};

export const useMcpConfigStore = create<McpConfigStore>()(
  devtools(
    persist(
      (set, get) => ({
        mcpServers: [],
        selectedMcpName: null,
        isLoading: false,
        mcpDraft: null,

        setSelectedMcp: (name) => set({ selectedMcpName: name }),

        setMcpDraft: (draft) => set({ mcpDraft: draft }),

        loadMcpConfigs: async (options) => {
          const configDirectory = getConfigDirectory();
          const cacheKey = getMcpCacheKey(configDirectory);
          const now = Date.now();
          const loadedAt = mcpLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedConfigs = get().mcpServers.length > 0;

          if (!options?.force && hasCachedConfigs && now - loadedAt < MCP_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = mcpLoadInFlight.get(cacheKey);
          if (!options?.force && inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            try {
              const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
              const response = await fetch(`/api/config/mcp${queryParams}`, {
                headers: configDirectory ? { 'x-openchamber-directory': configDirectory, 'x-opencode-directory': configDirectory } : undefined,
              });
              if (!response.ok) {
                throw new Error('Failed to load MCP configs');
              }
              const data: McpServerWithScope[] = await response.json();
              set({ mcpServers: data, isLoading: false });
              mcpLastLoadedAt.set(cacheKey, Date.now());
              return true;
            } catch (error) {
              console.error('[McpConfigStore] Failed to load MCP configs:', error);
              set({ isLoading: false });
              return false;
            }
          })();

          mcpLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            mcpLoadInFlight.delete(cacheKey);
          }
        },

        createMcp: async (config: McpDraft) => {
          startConfigUpdate('Creating MCP server configuration…');
          let requiresReload = false;
          try {
            const body = buildMcpBody(config);
            const configDirectory = getConfigDirectory();
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-openchamber-directory': configDirectory, 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to create MCP server');
            }

            invalidateMcpCache(configDirectory);

            if (payload?.requiresReload) {
              requiresReload = true;
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              await get().loadMcpConfigs({ force: true });
              return {
                ok: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            await get().loadMcpConfigs({ force: true });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to create MCP:', error);
            return { ok: false };
          } finally {
            if (!requiresReload) finishConfigUpdate();
          }
        },

        updateMcp: async (name: string, config: Partial<McpDraft>) => {
          startConfigUpdate('Updating MCP server configuration…');
          let requiresReload = false;
          try {
            const body = buildMcpBody(config);
            const configDirectory = getConfigDirectory();
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-openchamber-directory': configDirectory, 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to update MCP server');
            }

            invalidateMcpCache(configDirectory);

            if (payload?.requiresReload) {
              requiresReload = true;
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              await get().loadMcpConfigs({ force: true });
              return {
                ok: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            await get().loadMcpConfigs({ force: true });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to update MCP:', error);
            throw error;
          } finally {
            if (!requiresReload) finishConfigUpdate();
          }
        },

        deleteMcp: async (name: string) => {
          startConfigUpdate('Deleting MCP server configuration…');
          let requiresReload = false;
          try {
            const configDirectory = getConfigDirectory();
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: configDirectory ? { 'x-openchamber-directory': configDirectory, 'x-opencode-directory': configDirectory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to delete MCP server');
            }

            invalidateMcpCache(configDirectory);

            if (payload?.requiresReload) {
              requiresReload = true;
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
            }

            if (get().selectedMcpName === name) {
              set({ selectedMcpName: null });
            }
            await get().loadMcpConfigs({ force: true });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to delete MCP:', error);
            return { ok: false };
          } finally {
            if (!requiresReload) finishConfigUpdate();
          }
        },

        getMcpByName: (name: string) => {
          return get().mcpServers.find((s) => s.name === name);
        },
      }),
      {
        name: 'mcp-config-store',
        storage: createDebouncedJSONStorage(),
        partialize: (state) => ({ selectedMcpName: state.selectedMcpName }),
      },
    ),
    { name: 'mcp-config-store' },
  ),
);

// ============== HELPERS ==============

function buildMcpBody(config: Partial<McpDraft>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (config.scope !== undefined) body.scope = config.scope;

  if (config.type !== undefined) body.type = config.type;

  if (config.type === 'local' || config.command !== undefined) {
    body.command = (config.command ?? []).filter((s) => s.trim());
  }

  if (config.type === 'remote' || config.url !== undefined) {
    body.url = config.url?.trim() ?? '';
  }

  if (config.environment !== undefined) {
    body.environment = envArrayToRecord(config.environment) ?? {};
  }

  if (config.headers !== undefined) {
    body.headers = envArrayToRecord(config.headers) ?? {};
  }

  if (
    config.oauthEnabled !== undefined ||
    config.oauthClientId !== undefined ||
    config.oauthClientSecret !== undefined ||
    config.oauthScope !== undefined ||
    config.oauthRedirectUri !== undefined
  ) {
    if (config.oauthEnabled === false) {
      body.oauth = false;
    } else {
      const oauth = {
        clientId: trimOptionalString(config.oauthClientId),
        clientSecret: trimOptionalString(config.oauthClientSecret),
        scope: trimOptionalString(config.oauthScope),
        redirectUri: trimOptionalString(config.oauthRedirectUri),
      };

      if (oauth.clientId || oauth.clientSecret || oauth.scope || oauth.redirectUri) {
        body.oauth = oauth;
      } else if (config.oauthEnabled) {
        body.oauth = {};
      } else {
        body.oauth = false;
      }
    }
  }

  if (config.timeout !== undefined) {
    const timeout = Number(config.timeout);
    if (Number.isFinite(timeout) && timeout > 0) {
      body.timeout = timeout;
    } else {
      body.timeout = null;
    }
  }

  if (config.enabled !== undefined) {
    body.enabled = config.enabled;
  }

  return body;
}
