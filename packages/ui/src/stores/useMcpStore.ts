import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export type McpStatusMap = Record<string, McpStatus>;

const EMPTY_STATUS: McpStatusMap = {};

type McpHealth = {
  connected: number;
  total: number;
  hasFailed: boolean;
  hasAuthRequired: boolean;
};

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const toKey = (directory: string | null | undefined): string => normalizeDirectory(directory) ?? '__global__';

const getMcpApiClient = (directory: string | null | undefined) => {
  const normalized = normalizeDirectory(directory);
  if (!normalized) {
    return opencodeClient.getApiClient();
  }
  return opencodeClient.getScopedApiClient(normalized);
};

export const computeMcpHealth = (status: McpStatusMap | null | undefined): McpHealth => {
  const entries = Object.entries(status ?? {});
  const connected = entries.filter(([, s]) => s?.status === 'connected').length;
  const total = entries.length;
  const hasFailed = entries.some(([, s]) => s?.status === 'failed');
  const hasAuthRequired = entries.some(([, s]) => s?.status === 'needs_auth' || s?.status === 'needs_client_registration');
  return { connected, total, hasFailed, hasAuthRequired };
};

type RefreshOptions = {
  directory?: string | null;
  silent?: boolean;
};

type TestConnectionResult = {
  status?: McpStatus;
  error?: string;
};

interface McpStore {
  byDirectory: Record<string, McpStatusMap>;
  loadingKeys: Record<string, boolean>;
  lastErrorKeys: Record<string, string | null>;

  getStatusForDirectory: (directory?: string | null) => McpStatusMap;
  refresh: (options?: RefreshOptions) => Promise<void>;
  connect: (name: string, directory?: string | null) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  startAuth: (name: string, directory?: string | null) => Promise<string>;
  clearAuth: (name: string, directory?: string | null) => Promise<void>;
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
}

export const useMcpStore = create<McpStore>()(
  devtools((set, get) => ({
    byDirectory: {},
    loadingKeys: {},
    lastErrorKeys: {},

    getStatusForDirectory: (directory) => {
      const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
      return get().byDirectory[key] ?? EMPTY_STATUS;
    },

    refresh: async (options) => {
      const directory = normalizeDirectory(options?.directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(directory);

      if (!options?.silent) {
        set((state) => ({
          loadingKeys: { ...state.loadingKeys, [key]: true },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
        }));
      }

      try {
        const api = getMcpApiClient(directory);
        const result = await api.mcp.status();
        const data = (result.data ?? {}) as McpStatusMap;

        set((state) => ({
          byDirectory: { ...state.byDirectory, [key]: data },
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load MCP status';
        set((state) => ({
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: message },
        }));
      }
    },

    connect: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      await api.mcp.connect({ name }, { throwOnError: true });
      await get().refresh({ directory: normalized, silent: true });
    },

    disconnect: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      await api.mcp.disconnect({ name }, { throwOnError: true });
      await get().refresh({ directory: normalized, silent: true });
    },

    startAuth: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      const result = await api.mcp.auth.start({ name }, { throwOnError: true });
      const authorizationUrl = result.data?.authorizationUrl;

      if (!authorizationUrl) {
        throw new Error('Authorization URL was not returned');
      }

      return authorizationUrl;
    },

    clearAuth: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      await api.mcp.auth.remove({ name }, { throwOnError: true });
      await get().refresh({ directory: normalized, silent: true });
    },

    testConnection: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      const previousStatus = get().getStatusForDirectory(normalized)[name];
      const wasConnected = previousStatus?.status === 'connected';
      let errorMessage: string | undefined;

      try {
        await api.mcp.connect({ name }, { throwOnError: true });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Connection failed';
      }

      await get().refresh({ directory: normalized, silent: true });
      const currentStatus = get().getStatusForDirectory(normalized)[name];

      if (!wasConnected && currentStatus?.status === 'connected') {
        await api.mcp.disconnect({ name }, { throwOnError: true });
        await get().refresh({ directory: normalized, silent: true });
      }

      return {
        status: get().getStatusForDirectory(normalized)[name],
        error: errorMessage,
      };
    },

  }))
);
