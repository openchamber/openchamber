import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';
import {
  startConfigUpdate,
  finishConfigUpdate,
} from '@/lib/configUpdate';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';

export type McpScope = 'user' | 'project';

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

export interface McpRemoteConfig {
  type: 'remote';
  url: string;
  environment?: Record<string, string>;
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

const CLIENT_RELOAD_DELAY_MS = 800;

// ============== STORE ==============

interface McpConfigStore {
  mcpServers: McpServerWithScope[];
  selectedMcpName: string | null;
  isLoading: boolean;
  mcpDraft: McpDraft | null;

  setSelectedMcp: (name: string | null) => void;
  setMcpDraft: (draft: McpDraft | null) => void;
  loadMcpConfigs: () => Promise<boolean>;
  createMcp: (config: McpDraft) => Promise<boolean>;
  updateMcp: (name: string, config: Partial<McpDraft>) => Promise<boolean>;
  deleteMcp: (name: string) => Promise<boolean>;
  getMcpByName: (name: string) => McpServerWithScope | undefined;
}

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

        loadMcpConfigs: async () => {
          set({ isLoading: true });
          try {
            const configDirectory = getConfigDirectory();
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await fetch(`/api/config/mcp${queryParams}`, {
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });
            if (!response.ok) {
              throw new Error('Failed to load MCP configs');
            }
            const data: McpServerWithScope[] = await response.json();
            set({ mcpServers: data, isLoading: false });
            return true;
          } catch (error) {
            console.error('[McpConfigStore] Failed to load MCP configs:', error);
            set({ isLoading: false });
            return false;
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
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to create MCP server');
            }

            if (payload?.requiresReload) {
              requiresReload = true;
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              return true;
            }

            await get().loadMcpConfigs();
            return true;
          } catch (error) {
            console.error('[McpConfigStore] Failed to create MCP:', error);
            return false;
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
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(body),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to update MCP server');
            }

            if (payload?.requiresReload) {
              requiresReload = true;
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              return true;
            }

            await get().loadMcpConfigs();
            return true;
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
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to delete MCP server');
            }

            if (payload?.requiresReload) {
              requiresReload = true;
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              return true;
            }

            if (get().selectedMcpName === name) {
              set({ selectedMcpName: null });
            }
            await get().loadMcpConfigs();
            return true;
          } catch (error) {
            console.error('[McpConfigStore] Failed to delete MCP:', error);
            return false;
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
        storage: createJSONStorage(() => getSafeStorage()),
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

  if (config.enabled !== undefined) {
    body.enabled = config.enabled;
  }

  return body;
}
