import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { startConfigUpdate } from '@/lib/configUpdate';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';

export type McpScope = 'user' | 'project';

type McpMutationResult = {
  ok: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
  requiresManualRestart?: boolean;
};

/**
 * Directory a call operates on. Settings can browse another project without
 * moving the app, so every entry point takes one; omitting it means the
 * project the app is currently on.
 */
const resolveDirectory = (directory?: string | null): string | null => {
  if (directory !== undefined) {
    const trimmed = directory?.trim();
    return trimmed ? trimmed : null;
  }
  return getConfigDirectory();
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

/**
 * OpenCode 2 splits an MCP server's timeouts by phase, all in milliseconds.
 * `startup` only applies to a local (spawned) server.
 */
export interface McpTimeout {
  startup?: number;
  catalog?: number;
  execution?: number;
}

/** OAuth fields as OpenCode 2 spells them in config (snake_case). */
export interface McpOAuthConfig {
  client_id?: string;
  client_secret?: string;
  scope?: string;
  callback_port?: number;
  redirect_uri?: string;
  /** Added in OpenCode 2.0.8; points at the authorization server metadata document. */
  auth_server_metadata_url?: string;
}

/**
 * How OpenCode opens the MCP connection (2.0.8+). An absent key means
 * `legacy`, so the config file only ever carries the other two.
 */
export type McpProtocol = 'legacy' | 'auto' | '2026-07-28';

export const MCP_PROTOCOLS: readonly McpProtocol[] = ['legacy', 'auto', '2026-07-28'];

/**
 * Code Mode as the form offers it. `default` is an absent key: OpenCode then
 * decides per server (on, except servers its own defaults exclude, such as
 * executor.sh). `on` and `off` write an explicit value that OpenCode keeps.
 */
export type McpCodemodeChoice = 'default' | 'on' | 'off';

export const MCP_CODEMODE_CHOICES: readonly McpCodemodeChoice[] = ['default', 'on', 'off'];

export const codemodeChoiceOf = (value: boolean | undefined): McpCodemodeChoice =>
  value === undefined ? 'default' : value ? 'on' : 'off';

interface McpConfigBase {
  environment?: Record<string, string>;
  /** v2 replaced the v1 `enabled` flag; absent means the server is active. */
  disabled?: boolean;
  /** Expose the server's tools through Code Mode instead of one tool each. */
  codemode?: boolean;
  timeout?: McpTimeout;
  protocol?: McpProtocol;
}

interface McpLocalConfig extends McpConfigBase {
  type: 'local';
  command: string[];
  cwd?: string;
}

interface McpRemoteConfig extends McpConfigBase {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
}

export type McpServerConfig = (McpLocalConfig | McpRemoteConfig) & { name: string };

type McpServerWithScope = McpServerConfig & {
  scope?: McpScope | null;
  /** The config file the entry lives in. */
  path?: string | null;
  /** The entry still uses v1 spellings; the next save rewrites it in v2. */
  legacy?: boolean;
};

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
  oauthCallbackPort: string;
  oauthAuthServerMetadataUrl: string;
  protocol: McpProtocol;
  timeoutStartup: string;
  timeoutCatalog: string;
  timeoutExecution: string;
  codemode: McpCodemodeChoice;
  disabled: boolean;
}

// ============== HELPERS ==============

export const envRecordToArray = (env?: Record<string, string>): Array<{ key: string; value: string }> => {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
};

const envArrayToRecord = (arr: Array<{ key: string; value: string }>): Record<string, string> | undefined => {
  const filtered = arr.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  return Object.fromEntries(filtered.map((e) => [e.key.trim(), e.value]));
};

/** A millisecond/port form field, or undefined when it says nothing usable. */
const positiveInteger = (value: string | undefined): number | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
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
  /** Servers of the project the app is on. Chat and mobile read this one. */
  mcpServers: McpServerWithScope[];
  /** Every directory loaded so far, including the ambient one. */
  serversByDirectory: Record<string, McpServerWithScope[]>;
  selectedMcpName: string | null;
  isLoading: boolean;
  mcpDraft: McpDraft | null;

  setSelectedMcp: (name: string | null) => void;
  setMcpDraft: (draft: McpDraft | null) => void;
  loadMcpConfigs: (options?: { force?: boolean; directory?: string | null }) => Promise<boolean>;
  createMcp: (config: McpDraft, directory?: string | null) => Promise<McpMutationResult>;
  updateMcp: (name: string, config: Partial<McpDraft>, directory?: string | null) => Promise<McpMutationResult>;
  deleteMcp: (name: string, directory?: string | null) => Promise<McpMutationResult>;
  getMcpByName: (name: string, directory?: string | null) => McpServerWithScope | undefined;
  getMcpServersForDirectory: (directory?: string | null) => McpServerWithScope[];
}

const invalidateMcpCache = (directory: string | null) => {
  mcpLastLoadedAt.delete(getMcpCacheKey(directory));
};

const EMPTY_MCP_SERVERS: McpServerWithScope[] = [];

/**
 * Servers of one project. Returns a stored array so components can select it
 * directly; an omitted directory means the project the app is on.
 */
export const selectMcpServersForDirectory = (
  state: Pick<McpConfigStore, 'serversByDirectory'>,
  directory?: string | null,
): McpServerWithScope[] => {
  const cacheKey = getMcpCacheKey(resolveDirectory(directory));
  return state.serversByDirectory[cacheKey] ?? EMPTY_MCP_SERVERS;
};

export const useMcpConfigStore = create<McpConfigStore>()(
  devtools(
    persist(
      (set, get) => ({
        mcpServers: [],
        serversByDirectory: {},
        selectedMcpName: null,
        isLoading: false,
        mcpDraft: null,

        setSelectedMcp: (name) => set({ selectedMcpName: name }),

        setMcpDraft: (draft) => set({ mcpDraft: draft }),

        loadMcpConfigs: async (options) => {
          const configDirectory = resolveDirectory(options?.directory);
          const cacheKey = getMcpCacheKey(configDirectory);
          const isAmbient = cacheKey === getMcpCacheKey(getConfigDirectory());
          const now = Date.now();
          const loadedAt = mcpLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedConfigs = (get().serversByDirectory[cacheKey] ?? (isAmbient ? get().mcpServers : [])).length > 0;

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
              const response = await runtimeFetch(`/api/config/mcp${queryParams}`, {
                headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
              });
              if (!response.ok) {
                throw new Error('Failed to load MCP configs');
              }
              const data: McpServerWithScope[] = await response.json();
              set((state) => {
                const next: Partial<McpConfigStore> = {
                  serversByDirectory: { ...state.serversByDirectory, [cacheKey]: data },
                  isLoading: false,
                };
                if (isAmbient) next.mcpServers = data;
                return next;
              });
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

        createMcp: async (config: McpDraft, directory?: string | null) => {
          try {
            const body = buildMcpBody(config);
            const configDirectory = resolveDirectory(directory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await runtimeFetch(`/api/config/mcp/${encodeURIComponent(config.name)}${queryParams}`, {
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

            invalidateMcpCache(configDirectory);

            if (payload?.requiresManualRestart) {
              await get().loadMcpConfigs({ force: true, directory: configDirectory });
              return {
                ok: true,
                requiresManualRestart: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            if (payload?.requiresReload) {
              startConfigUpdate('Creating MCP server configuration…');
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              await get().loadMcpConfigs({ force: true, directory: configDirectory });
              return {
                ok: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            await get().loadMcpConfigs({ force: true, directory: configDirectory });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to create MCP:', error);
            return { ok: false };
          }
        },

        updateMcp: async (name: string, config: Partial<McpDraft>, directory?: string | null) => {
          try {
            const body = buildMcpBody(config);
            const configDirectory = resolveDirectory(directory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await runtimeFetch(`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`, {
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

            invalidateMcpCache(configDirectory);

            if (payload?.requiresManualRestart) {
              await get().loadMcpConfigs({ force: true, directory: configDirectory });
              return {
                ok: true,
                requiresManualRestart: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            if (payload?.requiresReload) {
              startConfigUpdate('Updating MCP server configuration…');
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
              await get().loadMcpConfigs({ force: true, directory: configDirectory });
              return {
                ok: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            await get().loadMcpConfigs({ force: true, directory: configDirectory });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to update MCP:', error);
            throw error;
          }
        },

        deleteMcp: async (name: string, directory?: string | null) => {
          try {
            const configDirectory = resolveDirectory(directory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
            const response = await runtimeFetch(`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error || 'Failed to delete MCP server');
            }

            invalidateMcpCache(configDirectory);

            if (get().selectedMcpName === name) {
              set({ selectedMcpName: null });
            }

            if (payload?.requiresManualRestart) {
              await get().loadMcpConfigs({ force: true, directory: configDirectory });
              return {
                ok: true,
                requiresManualRestart: true,
                reloadFailed: payload?.reloadFailed === true,
                message: payload?.message,
                warning: payload?.warning,
              };
            }

            if (payload?.requiresReload) {
              startConfigUpdate('Deleting MCP server configuration…');
              await refreshAfterOpenCodeRestart({
                message: payload.message,
                delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
                scopes: ['all'],
              });
            }

            await get().loadMcpConfigs({ force: true, directory: configDirectory });
            return {
              ok: true,
              reloadFailed: payload?.reloadFailed === true,
              message: payload?.message,
              warning: payload?.warning,
            };
          } catch (error) {
            console.error('[McpConfigStore] Failed to delete MCP:', error);
            return { ok: false };
          }
        },

        getMcpByName: (name: string, directory?: string | null) => {
          return get().getMcpServersForDirectory(directory).find((s) => s.name === name);
        },

        getMcpServersForDirectory: (directory?: string | null) => {
          return selectMcpServersForDirectory(get(), directory);
        },
      }),
      {
        name: 'mcp-config-store',
        storage: createDeferredSafeJSONStorage(),
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

  // v2 requires `type`: an entry without it is dropped when the config loads.
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

  const touchesOAuth =
    config.oauthEnabled !== undefined ||
    config.oauthClientId !== undefined ||
    config.oauthClientSecret !== undefined ||
    config.oauthScope !== undefined ||
    config.oauthRedirectUri !== undefined ||
    config.oauthCallbackPort !== undefined ||
    config.oauthAuthServerMetadataUrl !== undefined;

  if (touchesOAuth) {
    if (config.oauthEnabled === false) {
      body.oauth = false;
    } else {
      const callbackPort = positiveInteger(config.oauthCallbackPort);
      const oauth: McpOAuthConfig = {};
      const clientId = trimOptionalString(config.oauthClientId);
      const clientSecret = trimOptionalString(config.oauthClientSecret);
      const scope = trimOptionalString(config.oauthScope);
      const redirectUri = trimOptionalString(config.oauthRedirectUri);
      const authServerMetadataUrl = trimOptionalString(config.oauthAuthServerMetadataUrl);
      if (clientId) oauth.client_id = clientId;
      if (clientSecret) oauth.client_secret = clientSecret;
      if (scope) oauth.scope = scope;
      if (redirectUri) oauth.redirect_uri = redirectUri;
      if (callbackPort !== undefined) oauth.callback_port = callbackPort;
      // An emptied field drops the key: the object is rebuilt from the form
      // every save rather than merged onto what is already stored.
      if (authServerMetadataUrl) oauth.auth_server_metadata_url = authServerMetadataUrl;

      if (Object.keys(oauth).length > 0 || config.oauthEnabled) {
        body.oauth = oauth;
      } else {
        body.oauth = false;
      }
    }
  }

  const touchesTimeout =
    config.timeoutStartup !== undefined ||
    config.timeoutCatalog !== undefined ||
    config.timeoutExecution !== undefined;

  if (touchesTimeout) {
    const timeout: McpTimeout = {};
    const startup = positiveInteger(config.timeoutStartup);
    const catalog = positiveInteger(config.timeoutCatalog);
    const execution = positiveInteger(config.timeoutExecution);
    // `startup` is meaningless for a server OpenChamber does not spawn.
    if (startup !== undefined && config.type !== 'remote') timeout.startup = startup;
    if (catalog !== undefined) timeout.catalog = catalog;
    if (execution !== undefined) timeout.execution = execution;
    body.timeout = Object.keys(timeout).length > 0 ? timeout : null;
  }

  if (config.codemode !== undefined) {
    // `default` removes the key so OpenCode's own per-server default applies.
    body.codemode = config.codemode === 'default' ? null : config.codemode === 'on';
  }

  if (config.disabled !== undefined) {
    body.disabled = config.disabled;
  }

  if (config.protocol !== undefined) {
    // `legacy` is what OpenCode does without the key, so it is written as a
    // removal: the config file only ever names a non-default negotiation.
    body.protocol = config.protocol === 'legacy' ? null : config.protocol;
  }

  return body;
}
