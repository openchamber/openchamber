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

export type PluginScope = 'user' | 'project';
export type PluginParsedKind = 'npm' | 'path';

export interface PluginEntry {
  id: string;
  spec: string;
  options?: Record<string, unknown>;
  scope: PluginScope;
  kind: 'config';
  parsedKind: PluginParsedKind;
}

export interface PluginFile {
  id: string;
  fileName: string;
  scope: PluginScope;
  kind: 'file';
}

export interface PluginDraft {
  mode: 'entry' | 'file';
  scope: PluginScope;
  spec: string;
  optionsJson: string;
  fileName: string;
  content: string;
}

export type PluginMutationResult = {
  ok: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
};

export type RegistryResult =
  | { kind: 'npm-ok'; spec: string; name: string; currentVersion: string | null; latestVersion: string | null; versions: string[]; hasUpdate: boolean }
  | { kind: 'npm-missing-version'; spec: string; name: string; currentVersion: string; latestVersion: string | null; versions: string[] }
  | { kind: 'npm-missing-package'; spec: string; name: string; error: string }
  | { kind: 'npm-malformed'; spec: string; error: string }
  | { kind: 'npm-network'; spec: string; error: string }
  | { kind: 'path-ok'; spec: string; absolutePath: string }
  | { kind: 'path-missing'; spec: string; absolutePath: string }
  | { kind: 'path-unreadable'; spec: string; absolutePath: string };

export interface PluginsStore {
  entries: PluginEntry[];
  files: PluginFile[];
  selectedId: string | null;
  isLoading: boolean;
  registryInfo: Record<string, RegistryResult>;
  isLoadingRegistry: boolean;
  draft: PluginDraft | null;

  setSelected: (id: string | null) => void;
  setDraft: (draft: PluginDraft | null) => void;
  loadPlugins: (options?: { force?: boolean }) => Promise<boolean>;
  loadRegistryInfo: (opts?: { specs?: string[]; force?: boolean }) => Promise<void>;
  updateToLatest: (id: string) => Promise<PluginMutationResult>;
  createEntry: (input: { spec: string; options?: Record<string, unknown>; scope: PluginScope }) => Promise<PluginMutationResult>;
  updateEntry: (id: string, input: { spec?: string; options?: Record<string, unknown> }) => Promise<PluginMutationResult>;
  deleteEntry: (id: string) => Promise<PluginMutationResult>;
  readFile: (id: string) => Promise<{ fileName: string; scope: PluginScope; content: string } | null>;
  createFile: (input: { fileName: string; content: string; scope: PluginScope }) => Promise<PluginMutationResult>;
  updateFile: (id: string, input: { content: string }) => Promise<PluginMutationResult>;
  deleteFile: (id: string) => Promise<PluginMutationResult>;
  getById: (id: string) => PluginEntry | PluginFile | undefined;
}

type PluginsListResponse = {
  entries?: PluginEntry[];
  files?: PluginFile[];
};

type RegistryInfoResponse = {
  results?: RegistryResult[];
};

type PluginMutationPayload = {
  success?: boolean;
  requiresReload?: boolean;
  message?: string;
  reloadDelayMs?: number;
  reloadFailed?: boolean;
  warning?: string;
  error?: string;
};

type PluginFileContent = {
  fileName: string;
  scope: PluginScope;
  content: string;
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
    console.warn('[PluginsStore] Error resolving config directory:', err);
  }
  return null;
};

const CLIENT_RELOAD_DELAY_MS = 800;
export const PLUGINS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_PLUGINS_CACHE_KEY = '__default__';
const pluginsLastLoadedAt = new Map<string, number>();
const pluginsLoadInFlight = new Map<string, Promise<boolean>>();
const REGISTRY_SPECS_CHUNK_LIMIT = 1500;

const getPluginCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_PLUGINS_CACHE_KEY;
};

const invalidatePluginCache = (directory: string | null) => {
  pluginsLastLoadedAt.delete(getPluginCacheKey(directory));
};

export const usePluginsStore = create<PluginsStore>()(
  devtools(
    persist(
      (set, get) => ({
        entries: [],
        files: [],
        selectedId: null,
        isLoading: false,
        registryInfo: {},
        isLoadingRegistry: false,
        draft: null,

        setSelected: (id) => set({ selectedId: id }),

        setDraft: (draft) => set({ draft }),

        loadPlugins: async (options) => {
          const configDirectory = getConfigDirectory();
          const cacheKey = getPluginCacheKey(configDirectory);
          const now = Date.now();
          const loadedAt = pluginsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedPlugins = get().entries.length > 0 || get().files.length > 0;

          if (!options?.force && hasCachedPlugins && now - loadedAt < PLUGINS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = pluginsLoadInFlight.get(cacheKey);
          if (!options?.force && inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            try {
              const response = await fetch(buildPluginsUrl('/api/config/plugins', configDirectory), {
                headers: buildDirectoryHeaders(configDirectory),
              });
              if (!response.ok) {
                throw new Error('Failed to load plugins');
              }
              const data = await readJson<PluginsListResponse>(response);
              set({ entries: data.entries ?? [], files: data.files ?? [], isLoading: false });
              pluginsLastLoadedAt.set(cacheKey, Date.now());
              if (!options?.force) {
                void get().loadRegistryInfo();
              }
              return true;
            } catch (error) {
              console.error('[PluginsStore] Failed to load plugins:', error);
              set({ isLoading: false });
              return false;
            }
          })();

          pluginsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            pluginsLoadInFlight.delete(cacheKey);
          }
        },

        loadRegistryInfo: async (opts) => {
          const specs = dedupeSpecs(opts?.specs ?? get().entries.map((entry) => entry.spec));
          if (specs.length === 0) {
            set({ isLoadingRegistry: false });
            return;
          }

          set({ isLoadingRegistry: true });
          try {
            const configDirectory = getConfigDirectory();
            const nextRegistryInfo: Record<string, RegistryResult> = { ...get().registryInfo };
            for (const chunk of chunkSpecs(specs)) {
              const response = await fetch(buildRegistryUrl(chunk, opts?.force === true, configDirectory), {
                headers: buildDirectoryHeaders(configDirectory),
              });
              if (!response.ok) {
                throw new Error('Failed to load plugin registry info');
              }
              const data = await readJson<RegistryInfoResponse>(response);
              for (const result of data.results ?? []) {
                nextRegistryInfo[result.spec] = result;
              }
            }
            set({ registryInfo: nextRegistryInfo, isLoadingRegistry: false });
          } catch (error) {
            console.error('[PluginsStore] Failed to load plugin registry info:', error);
            set({ isLoadingRegistry: false });
          }
        },

        updateToLatest: async (id) => {
          const entry = get().entries.find((plugin) => plugin.id === id);
          if (!entry) return { ok: false };
          const info = get().registryInfo[entry.spec];
          if (!info || info.kind !== 'npm-ok' || !info.hasUpdate || !info.latestVersion) {
            return { ok: false };
          }
          return await get().updateEntry(id, { spec: `${info.name}@${info.latestVersion}` });
        },

        createEntry: async (input) => {
          const result = await runPluginMutation('Creating plugin entry…', async (configDirectory) => {
            const response = await fetch(buildPluginsUrl('/api/config/plugins/entry', configDirectory), {
              method: 'POST',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(buildEntryBody(input)),
            });
            return response;
          }, get);
          if (result.ok) {
            void get().loadRegistryInfo({ specs: [input.spec], force: true });
          }
          return result;
        },

        updateEntry: async (id, input) => {
          const existingSpec = get().entries.find((plugin) => plugin.id === id)?.spec;
          const nextSpec = input.spec ?? existingSpec;
          const result = await runPluginMutation('Updating plugin entry…', async (configDirectory) => {
            const response = await fetch(buildPluginsUrl(`/api/config/plugins/entry/${encodeURIComponent(id)}`, configDirectory), {
              method: 'PATCH',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(buildEntryBody(input)),
            });
            return response;
          }, get);
          if (result.ok && nextSpec) {
            void get().loadRegistryInfo({ specs: [nextSpec], force: true });
          }
          return result;
        },

        deleteEntry: async (id) => {
          const entryToDelete = get().entries.find((plugin) => plugin.id === id);
          const result = await runPluginMutation('Deleting plugin entry…', async (configDirectory) => {
            const response = await fetch(buildPluginsUrl(`/api/config/plugins/entry/${encodeURIComponent(id)}`, configDirectory), {
              method: 'DELETE',
              headers: buildDirectoryHeaders(configDirectory),
            });
            return response;
          }, get);

          if (result.ok && get().selectedId === id) {
            set({ selectedId: null });
          }
          if (result.ok && entryToDelete) {
            const nextRegistryInfo = { ...get().registryInfo };
            delete nextRegistryInfo[entryToDelete.spec];
            set({ registryInfo: nextRegistryInfo });
          }
          return result;
        },

        readFile: async (id) => {
          try {
            const configDirectory = getConfigDirectory();
            const response = await fetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, configDirectory), {
              headers: buildDirectoryHeaders(configDirectory),
            });
            if (!response.ok) {
              throw new Error('Failed to read plugin file');
            }
            return await readJson<PluginFileContent>(response);
          } catch (error) {
            console.error('[PluginsStore] Failed to read plugin file:', error);
            return null;
          }
        },

        createFile: async (input) => {
          return runPluginMutation('Creating plugin file…', async (configDirectory) => {
            const response = await fetch(buildPluginsUrl('/api/config/plugins/file', configDirectory), {
              method: 'POST',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(input),
            });
            return response;
          }, get);
        },

        updateFile: async (id, input) => {
          return runPluginMutation('Updating plugin file…', async (configDirectory) => {
            const response = await fetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, configDirectory), {
              method: 'PUT',
              headers: buildJsonHeaders(configDirectory),
              body: JSON.stringify(input),
            });
            return response;
          }, get);
        },

        deleteFile: async (id) => {
          const result = await runPluginMutation('Deleting plugin file…', async (configDirectory) => {
            const response = await fetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, configDirectory), {
              method: 'DELETE',
              headers: buildDirectoryHeaders(configDirectory),
            });
            return response;
          }, get);

          if (result.ok && get().selectedId === id) {
            set({ selectedId: null });
          }
          return result;
        },

        getById: (id) => {
          return get().entries.find((plugin) => plugin.id === id) ?? get().files.find((plugin) => plugin.id === id);
        },
      }),
      {
        name: 'plugins-store',
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({ selectedId: state.selectedId }),
      },
    ),
    { name: 'plugins-store' },
  ),
);

function buildPluginsUrl(path: string, directory: string | null): string {
  const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return `${path}${queryParams}`;
}

function buildRegistryUrl(specs: string[], force: boolean, directory: string | null): string {
  const params = new URLSearchParams();
  if (force) params.set('refresh', 'true');
  if (directory) params.set('directory', directory);
  const suffix = params.toString();
  const specsParam = `specs=${specs.map(encodeURIComponent).join(',')}`;
  return `/api/config/plugins/registry?${specsParam}${suffix ? `&${suffix}` : ''}`;
}

function dedupeSpecs(specs: string[]): string[] {
  return Array.from(new Set(specs.map((spec) => spec.trim()).filter(Boolean)));
}

function chunkSpecs(specs: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const spec of specs) {
    const encodedSpec = encodeURIComponent(spec);
    const nextLength = current.length === 0 ? encodedSpec.length : currentLength + 1 + encodedSpec.length;
    if (current.length > 0 && nextLength > REGISTRY_SPECS_CHUNK_LIMIT) {
      chunks.push(current);
      current = [spec];
      currentLength = encodedSpec.length;
    } else {
      current.push(spec);
      currentLength = nextLength;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function buildDirectoryHeaders(directory: string | null): HeadersInit | undefined {
  return directory ? { 'x-opencode-directory': directory } : undefined;
}

function buildJsonHeaders(directory: string | null): HeadersInit {
  return {
    'Content-Type': 'application/json',
    ...(directory ? { 'x-opencode-directory': directory } : {}),
  };
}

function buildEntryBody(input: { spec?: string; options?: Record<string, unknown>; scope?: PluginScope }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.spec !== undefined) body.spec = input.spec;
  if (input.options !== undefined) body.options = input.options;
  if (input.scope !== undefined) body.scope = input.scope;
  return body;
}

async function runPluginMutation(
  progressMessage: string,
  request: (configDirectory: string | null) => Promise<Response>,
  get: () => PluginsStore,
): Promise<PluginMutationResult> {
  startConfigUpdate(progressMessage);
  let requiresReload = false;
  try {
    const configDirectory = getConfigDirectory();
    const response = await request(configDirectory);
    const payload = await readJson<PluginMutationPayload | null>(response).catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to update plugin configuration');
    }

    invalidatePluginCache(configDirectory);

    if (payload?.requiresReload) {
      requiresReload = true;
      await refreshAfterOpenCodeRestart({
        message: payload.message,
        delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
        scopes: ['all'],
      });
    }

    await get().loadPlugins({ force: true });
    return {
      ok: true,
      reloadFailed: payload?.reloadFailed === true,
      message: payload?.message,
      warning: payload?.warning,
    };
  } catch (error) {
    console.error('[PluginsStore] Failed to update plugin configuration:', error);
    return { ok: false };
  } finally {
    if (!requiresReload) finishConfigUpdate();
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
