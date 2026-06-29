import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpStatus } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
// Bound MCP requests so a hung OpenCode server can't freeze the UI. Matches the
// server's health-check window (server-utils-runtime: waitForOpenCodePort = 15s) and
// stays well under the prior promptAsync 60s ceiling — MCP status is a cheap GET.
const MCP_REQUEST_TIMEOUT_MS = 15_000;

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
  /** Bypass the default timeout (for testing). */
  timeoutMs?: number;
};

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

  getStatusForDirectory: (directory?: string | null) => McpStatusMap;
  getDiagnosticForDirectory: (directory?: string | null) => McpRuntimeDiagnosticMap;
  getErrorForDirectory: (directory?: string | null) => string | null;
  refresh: (options?: RefreshOptions) => Promise<void>;
  connect: (name: string, directory?: string | null) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  startAuth: (name: string, directory?: string | null) => Promise<string>;
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

      // Bound the upstream call so a hung OpenCode server can't freeze the UI
      // (e.g. Services > MCP tab waiting forever on an empty dropdown). The
      // AbortController pattern matches useConfigStore and the prior promptAsync
      // fix; it propagates through the SDK fetch chain so the in-flight request
      // is cancelled, not just abandoned.
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), options?.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS)
        : undefined;

      try {
        const api = getMcpApiClient(null); // Use global client to get ALL MCPs (plugin-registered, project, global)
        const result = await api.mcp.status(
          undefined,
          controller ? { signal: controller.signal } : undefined,
        );
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
        }));
      } catch (error) {
        const raw = error instanceof Error ? error.message : 'Failed to load MCP status';
        const message = controller?.signal.aborted
          ? `MCP status request timed out after ${options?.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS}ms`
          : raw;
        set((state) => ({
          loadingKeys: { ...state.loadingKeys, [key]: false },
          lastErrorKeys: { ...state.lastErrorKeys, [key]: message },
        }));
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
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
