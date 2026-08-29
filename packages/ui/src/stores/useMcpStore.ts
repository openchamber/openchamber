import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export type McpStatusMap = Record<string, McpStatus>;
type McpRuntimeDiagnostic = {
  status: 'failed';
  error: string;
};
type McpRuntimeDiagnosticMap = Record<string, McpRuntimeDiagnostic>;

const EMPTY_STATUS: McpStatusMap = {};
const EMPTY_DIAGNOSTICS: McpRuntimeDiagnosticMap = {};

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

const ensureFreshInFlight = new Map<string, Promise<void>>();

type TestConnectionResult = {
  status?: McpStatus;
  error?: string;
  warning?: string;
};

interface McpStore {
  byDirectory: Record<string, McpStatusMap>;
  diagnosticsByDirectory: Record<string, McpRuntimeDiagnosticMap>;
  loadingKeys: Record<string, boolean>;
  lastErrorKeys: Record<string, string | null>;
  /** When each directory's status was last fetched successfully. */
  refreshedAtKeys: Record<string, number>;

  getStatusForDirectory: (directory?: string | null) => McpStatusMap;
  getDiagnosticForDirectory: (directory?: string | null) => McpRuntimeDiagnosticMap;
  getErrorForDirectory: (directory?: string | null) => string | null;
  refresh: (options?: RefreshOptions) => Promise<void>;
  /**
   * Refresh only when the directory has no status yet or the last successful
   * fetch is older than `maxAgeMs`. Mount-time consumers use this so a panel
   * that remounts on every session switch does not refetch on every switch.
   */
  ensureFresh: (options: RefreshOptions & { maxAgeMs: number }) => Promise<void>;
  connect: (name: string, directory?: string | null) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  startAuth: (name: string, directory?: string | null) => Promise<string>;
  /**
   * OpenCode's native full OAuth flow: OpenCode opens the browser, receives
   * the callback on its own fixed loopback listener, and exchanges the code
   * itself. Resolves only when the whole flow finishes (minutes, not ms).
   */
  authenticate: (name: string, directory?: string | null) => Promise<void>;
  completeAuth: (name: string, code: string, directory?: string | null) => Promise<void>;
  clearAuth: (name: string, directory?: string | null) => Promise<void>;
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
}

export const useMcpStore = create<McpStore>()(
  devtools((set, get) => ({
    byDirectory: {},
    diagnosticsByDirectory: {},
    loadingKeys: {},
    lastErrorKeys: {},
    refreshedAtKeys: {},

    getStatusForDirectory: (directory) => {
      const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
      return get().byDirectory[key] ?? EMPTY_STATUS;
    },

    getDiagnosticForDirectory: (directory) => {
      const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
      return get().diagnosticsByDirectory[key] ?? EMPTY_DIAGNOSTICS;
    },

    getErrorForDirectory: (directory) => {
      const key = toKey(directory ?? useDirectoryStore.getState().currentDirectory);
      return get().lastErrorKeys[key] ?? null;
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
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: Object.fromEntries(
              Object.entries(state.diagnosticsByDirectory[key] ?? {}).filter(([name]) => !data[name])
            ),
          },
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: null },
          refreshedAtKeys: { ...state.refreshedAtKeys, [key]: Date.now() },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load MCP status';
        set((state) => ({
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: message },
        }));
      }
    },

    ensureFresh: async ({ maxAgeMs, ...options }) => {
      const key = toKey(normalizeDirectory(options.directory ?? useDirectoryStore.getState().currentDirectory));
      const refreshedAt = get().refreshedAtKeys[key];
      if (refreshedAt !== undefined && Date.now() - refreshedAt < maxAgeMs) return;
      const inFlight = ensureFreshInFlight.get(key);
      if (inFlight) return inFlight;
      const request = get().refresh(options).finally(() => {
        ensureFreshInFlight.delete(key);
      });
      ensureFreshInFlight.set(key, request);
      return request;
    },

    connect: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(normalized);
      const api = getMcpApiClient(normalized);
      try {
        await api.mcp.connect({ name }, { throwOnError: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: message },
            },
          },
        }));
        throw error;
      }
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


    authenticate: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(normalized);
      const api = getMcpApiClient(normalized);
      try {
        await api.mcp.auth.authenticate({ name }, { throwOnError: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Authorization failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: message },
            },
          },
        }));
        throw error;
      }
      await get().refresh({ directory: normalized, silent: true });
    },

    completeAuth: async (name, code, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      await api.mcp.auth.callback({ name, code }, { throwOnError: true });
      await get().refresh({ directory: normalized, silent: true });
    },

    clearAuth: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const api = getMcpApiClient(normalized);
      await api.mcp.auth.remove({ name }, { throwOnError: true });

      // Removing the stored tokens does not touch the live session, so the
      // server kept reporting `connected` until something forced a reconnect —
      // the user had to run a connection test to see that authorization was
      // gone. Dropping the connection makes the reported state match the
      // credentials that remain.
      await api.mcp.disconnect({ name }).catch(() => undefined);

      await get().refresh({ directory: normalized, silent: true });
    },

    testConnection: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(normalized);
      const api = getMcpApiClient(normalized);
      const previousStatus = get().getStatusForDirectory(normalized)[name];
      const wasConnected = previousStatus?.status === 'connected';
      let errorMessage: string | undefined;
      let warningMessage: string | undefined;

      try {
        await api.mcp.connect({ name }, { throwOnError: true });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Connection failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: errorMessage ?? 'Connection failed' },
            },
          },
        }));
      }

      await get().refresh({ directory: normalized, silent: true });
      const currentStatus = get().getStatusForDirectory(normalized)[name];
      const observedStatus = currentStatus;

      if (!wasConnected && currentStatus?.status === 'connected') {
        try {
          await api.mcp.disconnect({ name }, { throwOnError: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Disconnect failed';
          warningMessage = `Connection test succeeded, but cleanup disconnect failed: ${message}`;
        }
        await get().refresh({ directory: normalized, silent: true });
      }

      return {
        status: observedStatus ?? get().getStatusForDirectory(normalized)[name],
        error: errorMessage,
        warning: warningMessage,
      };
    },

  }))
);
