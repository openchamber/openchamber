import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpServerStatus } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';

type McpStatusMap = Record<string, McpServerStatus>;
type McpRuntimeDiagnostic = {
  status: 'failed';
  error: string;
};
type McpRuntimeDiagnosticMap = Record<string, McpRuntimeDiagnostic>;

const EMPTY_STATUS: McpStatusMap = {};
const EMPTY_DIAGNOSTICS: McpRuntimeDiagnosticMap = {};

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const toKey = (directory: string | null | undefined): string => normalizeDirectory(directory) ?? '__global__';

type RefreshOptions = {
  directory?: string | null;
  silent?: boolean;
};

const ensureFreshInFlight = new Map<string, Promise<void>>();
let mcpGeneration = 0;
const forgetGenerations = new Map<string, number>();
let statusRead = 0;
const fullStatusReads = new Map<string, number>();
const confirmedStatusReads = new WeakMap<McpServerStatus, number>();

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
  refreshedAtKeys: Record<string, number>;

  getStatusForDirectory: (directory?: string | null) => McpStatusMap;
  getDiagnosticForDirectory: (directory?: string | null) => McpRuntimeDiagnosticMap;
  getErrorForDirectory: (directory?: string | null) => string | null;
  refresh: (options?: RefreshOptions) => Promise<void>;
  ensureFresh: (options: RefreshOptions & { maxAgeMs: number }) => Promise<void>;
  refreshIfHeld: (directory: string) => Promise<void>;
  forgetDirectory: (directory: string) => void;
  connect: (name: string, directory?: string | null) => Promise<void>;
  reconnectSavedOAuth: (name: string, directory: string, integrationID: string, signal: AbortSignal) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  setEnabled: (name: string, enabled: boolean, directory?: string | null) => Promise<void>;
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
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
      fullStatusReads.clear();
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
      const forgetGeneration = forgetGenerations.get(key) ?? 0;
      const isStale = () => generation !== mcpGeneration || (forgetGenerations.get(key) ?? 0) !== forgetGeneration;
      const read = ++statusRead;
      try {
        const servers = await opencodeClient.listMcpServers(directory);
        if (isStale() || read < (fullStatusReads.get(key) ?? 0)) return;
        fullStatusReads.set(key, read);
        const confirmed = Object.entries(get().byDirectory[key] ?? {})
          .filter(([, status]) => (confirmedStatusReads.get(status) ?? 0) > read);
        const data: McpStatusMap = Object.fromEntries([
          ...servers.map((server) => [server.name, server] as const),
          ...confirmed,
        ]);

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
        if (isStale() || read < (fullStatusReads.get(key) ?? 0)) return;
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
      const request: Promise<void> = get().refresh(options).finally(() => {
        if (ensureFreshInFlight.get(key) === request) ensureFreshInFlight.delete(key);
      });
      ensureFreshInFlight.set(key, request);
      return request;
    },

    refreshIfHeld: async (directory) => {
      const normalized = normalizeDirectory(directory);
      if (!normalized || !get().byDirectory[toKey(normalized)]) return;
      await get().refresh({ directory: normalized, silent: true });
    },

    forgetDirectory: (directory) => {
      const normalized = normalizeDirectory(directory);
      if (!normalized) return;
      const key = toKey(normalized);
      forgetGenerations.set(key, (forgetGenerations.get(key) ?? 0) + 1);
      ensureFreshInFlight.delete(key);
      fullStatusReads.delete(key);
      const state = get();
      if (!(key in state.byDirectory) && !(key in state.loadingKeys)) return;
      const without = <T>(record: Record<string, T>) => {
        const next = { ...record };
        delete next[key];
        return next;
      };
      set((current) => ({
        byDirectory: without(current.byDirectory),
        diagnosticsByDirectory: without(current.diagnosticsByDirectory),
        loadingKeys: without(current.loadingKeys),
        lastErrorKeys: without(current.lastErrorKeys),
        refreshedAtKeys: without(current.refreshedAtKeys),
      }));
    },

    connect: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(normalized);
      const generation = mcpGeneration;
      const forgetGeneration = forgetGenerations.get(key);
      const isStale = () => generation !== mcpGeneration || forgetGenerations.get(key) !== forgetGeneration;
      try {
        await opencodeClient.connectMcpServer(name, normalized);
      } catch (error) {
        if (isStale()) return;
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
      if (!isStale()) await get().refresh({ directory: normalized, silent: true });
    },

    reconnectSavedOAuth: async (name, directory, integrationID, signal) => {
      const generation = mcpGeneration;
      const key = toKey(directory);
      const forgetGeneration = forgetGenerations.get(key);
      const read = ++statusRead;
      const cached = get().byDirectory[key];
      const matchesCached = !!cached && Object.hasOwn(cached, name) && cached[name]?.integrationID === integrationID;
      const servers = await opencodeClient.listMcpServers(directory);
      if (signal.aborted || generation !== mcpGeneration || forgetGenerations.get(key) !== forgetGeneration) return;
      const server = servers.find((entry) => entry.name === name && entry.integrationID === integrationID);
      if (server?.status.status === 'connected') {
        const statuses = get().byDirectory[key];
        const current = statuses && Object.hasOwn(statuses, name) ? statuses[name] : undefined;
        if (matchesCached && read > (fullStatusReads.get(key) ?? 0)
          && (!current || read > (confirmedStatusReads.get(current) ?? 0))) {
          confirmedStatusReads.set(server, read);
          set((state) => ({
            byDirectory: { ...state.byDirectory, [key]: { ...state.byDirectory[key], [name]: server } },
          }));
        }
        return;
      }
      if (server?.status.status !== 'failed' && server?.status.status !== 'needs_auth') return;
      const statuses = get().byDirectory[key];
      const current = statuses && Object.hasOwn(statuses, name) ? statuses[name] : undefined;
      const newerRead = read < (fullStatusReads.get(key) ?? 0)
        || (current !== undefined && read < (confirmedStatusReads.get(current) ?? 0));
      if (newerRead) {
        const currentStatus = current?.status.status;
        if (current?.integrationID !== integrationID
          || (currentStatus !== 'failed' && currentStatus !== 'needs_auth')) return;
      }
      await get().connect(name, directory);
    },

    disconnect: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      await opencodeClient.disconnectMcpServer(name, normalized);
      await get().refresh({ directory: normalized, silent: true });
    },

    setEnabled: async (name, enabled, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const configStore = useMcpConfigStore.getState();
      const generation = mcpGeneration;
      if (!await configStore.loadMcpConfigs({ force: true, directory: normalized })) {
        throw new Error('Failed to load MCP configs');
      }
      if (generation !== mcpGeneration) return;
      const configured = useMcpConfigStore.getState().getMcpByName(name, normalized);
      const disabledInConfig = configured?.disabled === true;
      if (configured && disabledInConfig === enabled) {
        await configStore.updateMcp(name, { disabled: !enabled }, normalized);
      }
      if (enabled && !disabledInConfig) await get().connect(name, normalized);
      else if (!enabled) await get().disconnect(name, normalized);
      else await get().refresh({ directory: normalized, silent: true });
    },

    testConnection: async (name, directory) => {
      const normalized = normalizeDirectory(directory ?? useDirectoryStore.getState().currentDirectory);
      const key = toKey(normalized);
      const previousStatus = get().getStatusForDirectory(normalized)[name];
      const wasDisabled = previousStatus?.status.status === 'disabled';
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

      if (wasDisabled && currentStatus?.status.status === 'connected') {
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
