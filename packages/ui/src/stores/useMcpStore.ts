import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpServerStatus } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export type McpStatusMap = Record<string, McpServerStatus>;
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

export const computeMcpHealth = (status: McpStatusMap | null | undefined): McpHealth => {
  const entries = Object.entries(status ?? {});
  const connected = entries.filter(([, s]) => s?.status.status === 'connected').length;
  const total = entries.length;
  const hasFailed = entries.some(([, s]) => s?.status.status === 'failed');
  const hasAuthRequired = entries.some(([, s]) => s?.status.status === 'needs_auth');
  return { connected, total, hasFailed, hasAuthRequired };
};

type RefreshOptions = {
  directory?: string | null;
  silent?: boolean;
};

const ensureFreshInFlight = new Map<string, Promise<void>>();
// Bumped on every runtime switch. Status is keyed by directory alone and two
// instances can hold the same project path, so a request already in flight for
// the previous instance would otherwise write its servers over the new one's.
let mcpGeneration = 0;

type TestConnectionResult = {
  status?: McpServerStatus;
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
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
  /**
   * MCP status is keyed by directory alone, and two instances can hold the same
   * project path — so on a switch the previous instance's servers would be
   * reported for the new one. Drop everything and let consumers re-ask.
   */
  resetForRuntimeSwitch: () => void;
}

export const useMcpStore = create<McpStore>()(
  devtools((set, get) => ({
    byDirectory: {},
    diagnosticsByDirectory: {},
    loadingKeys: {},
    lastErrorKeys: {},
    refreshedAtKeys: {},

    resetForRuntimeSwitch: () => {
      mcpGeneration += 1;
      ensureFreshInFlight.clear();
      set({
        byDirectory: {},
        diagnosticsByDirectory: {},
        loadingKeys: {},
        lastErrorKeys: {},
        refreshedAtKeys: {},
      });
    },

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

      const generation = mcpGeneration;
      try {
        const servers = await opencodeClient.listMcpServers(directory);
        if (generation !== mcpGeneration) return;
        const data: McpStatusMap = Object.fromEntries(servers.map((server) => [server.name, server]));

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
        if (generation !== mcpGeneration) return;
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
      try {
        await opencodeClient.connectMcpServer(name, normalized);
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
      await opencodeClient.disconnectMcpServer(name, normalized);
      await get().refresh({ directory: normalized, silent: true });
    },

    testConnection: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(normalized);
      const previousStatus = get().getStatusForDirectory(normalized)[name];
      const wasConnected = previousStatus?.status.status === 'connected';
      let errorMessage: string | undefined;
      let warningMessage: string | undefined;

      try {
        await opencodeClient.connectMcpServer(name, normalized);
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

      if (!wasConnected && currentStatus?.status.status === 'connected') {
        try {
          await opencodeClient.disconnectMcpServer(name, normalized);
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
