import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Agent } from "@/lib/opencode/model";
import { opencodeClient } from "@/lib/opencode/client";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges, type ConfigChangeScope } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { waitForOpenCodeConnection } from "@/stores/waitForOpenCodeConnection";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useConfigStore, invalidateConfigCatalogsForReload } from "@/stores/useConfigStore";
import { invalidateCommandsLoadCache, useCommandsStore } from "@/stores/useCommandsStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { useSkillsCatalogStore } from "@/stores/useSkillsCatalogStore";
import { invalidateSkillsLoadCache, useSkillsStore } from "@/stores/useSkillsStore";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { z } from "zod";
import { formatModelSelection, parseModelSelection } from "@/lib/modelIdentifier";
import { getRuntimeKey } from "@/lib/runtime-switch";

const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const store = (window as any).__zustand_directory_store__;
    if (store) {
      return store.getState().currentDirectory;
    }
  } catch {
    // ignore
  }

  return null;
};

const resolveDirectory = (directory?: string | null): string | null => {
  if (directory !== undefined) {
    const trimmed = directory?.trim();
    return trimmed ? trimmed : null;
  }
  return getConfigDirectory();
};

export const getConfigDirectory = (): string | null => {
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
    console.warn('[AgentsStore] Error resolving config directory:', err);
  }

  return null;
};

const AGENTS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_AGENTS_CACHE_KEY = '__default__';
const agentsLastLoadedAt = new Map<string, number>();
const agentsLoadGeneration = new Map<string, number>();
const agentsLoadInFlight = new Map<string, { generation: number; request: Promise<boolean> }>();
let agentsGeneration = 0;
let agentsReloadEpoch = 0;

const getAgentsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_AGENTS_CACHE_KEY;
};

export const invalidateAgentsLoadCache = (directory: string | null = getConfigDirectory()) => {
  const cacheKey = getAgentsCacheKey(directory);
  agentsLastLoadedAt.delete(cacheKey);
  agentsLoadGeneration.set(cacheKey, (agentsLoadGeneration.get(cacheKey) ?? 0) + 1);
  opencodeClient.invalidateAgentList(directory);
};

export const invalidateAllAgentsLoadCaches = () => {
  agentsReloadEpoch += 1;
  agentsLastLoadedAt.clear();
  agentsLoadGeneration.clear();
  agentsLoadInFlight.clear();
  opencodeClient.clearAgentListRequests();
};

const buildAgentsSignature = (agents: Agent[]): string => {
  return agents
    .map((agent) => {
      const extended = agent as AgentWithExtras;
      return [
        agent.name,
        extended.mode ?? '',
        formatModelSelection(
          agent.model
            ? { providerID: agent.model.providerID, modelID: agent.model.id, variant: agent.model.variant }
            : null,
        ) ?? '',
        String(agent.steps ?? ''),
        String(agent.request?.body?.temperature ?? ''),
        String(agent.request?.body?.top_p ?? ''),
        agent.system ?? '',
        JSON.stringify(agent.permissions ?? null),
        extended.scope ?? '',
        extended.group ?? '',
        extended.description ?? '',
        extended.color ?? '',
        String(agent.hidden === true),
        String(extended.native === true),
        String(extended.legacy === true),
      ].join('|');
    })
    .join('||');
};

export type AgentScope = 'user' | 'project';

export type PermissionEffect = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface AgentRequestBody {
  temperature?: number;
  top_p?: number;
}

export interface AgentRequest {
  headers?: Record<string, string>;
  body?: AgentRequestBody;
}

export interface AgentEntity {
  description?: string | null;
  model?: string | null;
  system?: string | null;
  mode?: "primary" | "subagent" | "all";
  hidden?: boolean;
  color?: string | null;
  steps?: number | null;
  disabled?: boolean | null;
  request?: AgentRequest | null;
  permissions?: PermissionRule[] | null;
}

export interface AgentConfig extends AgentEntity {
  name: string;
  scope?: AgentScope;
}

export interface AgentEntityEnvelope {
  source: 'md' | 'json' | 'none';
  scope: AgentScope | null;
  path: string | null;
  legacy: boolean;
  config: AgentEntity;
}

interface AgentPermissionsEnvelope {
  global: PermissionRule[];
  agent: PermissionRule[];
  effective: Array<PermissionRule & { source: 'global' | 'agent' }>;
  source: 'md' | 'json' | 'none';
  path: string | null;
}

export interface AgentMutationResult {
  ok: boolean;
  requiresManualRestart?: boolean;
}

export type AgentWithExtras = Agent & {
  native?: boolean;
  options?: { hidden?: boolean };
  scope?: AgentScope;
  group?: string;
  path?: string | null;
  legacy?: boolean;
};

function parseAgentGroup(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const normalizedPath = path.replace(/\\/g, '/');
  const idx = normalizedPath.lastIndexOf('/agents/');
  if (idx === -1) return undefined;
  const relative = normalizedPath.substring(idx + '/agents/'.length);
  const parts = relative.split('/');
  return parts.length > 1 ? parts[0] : undefined;
}

export const isAgentBuiltIn = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.native === true || extended.builtIn === true;
};

export const isAgentHidden = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras;
  return extended.hidden === true || extended.options?.hidden === true;
};

export const filterVisibleAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !isAgentHidden(agent));

export const isAgentManageable = (agent: Agent): boolean => {
  if (!isAgentHidden(agent)) return true;
  // SAFETY: store entries are SDK agents that loadAgents may extend with the
  // optional config-lookup flags; reading an absent flag yields undefined.
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.native === false && extended.builtIn !== true;
};

const CONFIG_EVENT_SOURCE = "useAgentsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hasValue = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

const toModelRef = (model: string | null | undefined): Agent['model'] | undefined => {
  const parsed = parseModelSelection(model);
  if (!parsed) return undefined;
  return { providerID: parsed.providerID, id: parsed.modelID, variant: parsed.variant };
};

const buildOptimisticAgent = (
  name: string,
  config: Partial<AgentConfig>,
  previous?: Agent,
): AgentWithExtras => {
  const previousExtras = previous as AgentWithExtras | undefined;
  const model = 'model' in config ? toModelRef(config.model) : previous?.model;
  const request = config.request !== undefined
    ? (config.request ?? { settings: {}, headers: {}, body: {} })
    : previous?.request;
  return {
    ...(previous || { name }),
    name,
    description: config.description !== undefined ? (config.description || undefined) : previous?.description,
    mode: config.mode ?? previous?.mode ?? 'subagent',
    model,
    steps: 'steps' in config ? (config.steps ?? undefined) : previous?.steps,
    system: config.system !== undefined ? (config.system || undefined) : previous?.system,
    color: 'color' in config ? (config.color ?? undefined) : previous?.color,
    request,
    permissions: config.permissions !== undefined
      ? (config.permissions ?? [])
      : (previous?.permissions ?? []),
    scope: config.scope ?? previousExtras?.scope,
    group: previousExtras?.group,
  } as unknown as AgentWithExtras;
};

const upsertOptimisticAgentLocal = (
  set: (partial: { agents: Agent[] }) => void,
  get: () => { agents: Agent[] },
  name: string,
  config: Partial<AgentConfig>,
) => {
  const agents = get().agents;
  const existing = agents.find((agent) => agent.name === name);
  const nextAgent = buildOptimisticAgent(name, config, existing);
  if (existing) {
    set({
      agents: agents.map((agent) => (agent.name === name ? nextAgent : agent)),
    });
  } else {
    set({ agents: [...agents, nextAgent] });
  }
};

interface AgentDraft {
  name: string;
  scope: AgentScope;
  description?: string;
  model?: string | null;
  system?: string;
  steps?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  mode?: "primary" | "subagent" | "all";
  permissions?: PermissionRule[];
  hidden?: boolean;
}

interface AgentsStore {

  selectedAgentName: string | null;
  agents: Agent[];
  agentsByDirectory: Record<string, Agent[]>;
  isLoading: boolean;
  agentDraft: AgentDraft | null;

  setSelectedAgent: (name: string | null) => void;
  setAgentDraft: (draft: AgentDraft | null) => void;
  loadAgents: (directory?: string | null) => Promise<boolean>;
  resetForRuntimeSwitch: () => void;
  fetchAgentEntity: (name: string, directory?: string | null) => Promise<AgentEntityEnvelope | null>;
  fetchAgentPermissions: (name: string, directory?: string | null) => Promise<AgentPermissionsEnvelope | null>;
  createAgent: (config: AgentConfig, directory?: string | null) => Promise<AgentMutationResult>;
  updateAgent: (name: string, config: Partial<AgentConfig>, directory?: string | null) => Promise<AgentMutationResult>;
  deleteAgent: (name: string, scope?: AgentScope, directory?: string | null) => Promise<AgentMutationResult>;
  getAgentByName: (name: string, directory?: string | null) => Agent | undefined;
  disabledAgentsByDirectory: Record<string, DisabledAgent[]>;
  loadDisabledAgents: (directory?: string | null) => Promise<boolean>;
  getVisibleAgents: (directory?: string | null) => Agent[];
}

declare global {
  interface Window {
    __zustand_agents_store__?: UseBoundStore<StoreApi<AgentsStore>>;
  }
}

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_DISABLED_AGENTS: DisabledAgent[] = [];

const DisabledAgentsResponseSchema = z.object({
  agents: z.array(z.object({
    name: z.string().min(1),
    scope: z.enum(['user', 'project']).nullable(),
    path: z.string().nullable(),
    description: z.string().optional(),
  })),
});

type DisabledAgent = z.infer<typeof DisabledAgentsResponseSchema>['agents'][number];

export const selectDisabledAgentsForDirectory = (
  state: Pick<AgentsStore, 'disabledAgentsByDirectory'>,
  directory?: string | null,
): DisabledAgent[] => state.disabledAgentsByDirectory[getAgentsCacheKey(resolveDirectory(directory))] ?? EMPTY_DISABLED_AGENTS;

async function fetchAgentResource<T>(
  name: string,
  resource: 'config' | 'permissions',
  requestedDirectory?: string | null,
): Promise<T | null> {
  const directory = resolveDirectory(requestedDirectory);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  try {
    const response = await runtimeFetch(
      `/api/config/agents/${encodeURIComponent(name)}/${resource}${query}`,
      {
        headers: {
          'Cache-Control': 'no-cache',
          ...(directory ? { 'x-opencode-directory': directory } : {}),
        },
      },
    );
    if (!response.ok) return null;
    // SAFETY: `/api/config/agents/:name/{config,permissions}` is OpenChamber's
    // own route; it normalizes every entry through `config-v2.js` before
    // answering, so the payload is already in the canonical v2 shape.
    return (await response.json()) as T;
  } catch (error) {
    console.warn(`[AgentsStore] Failed to read agent ${resource} for ${name}:`, error);
    return null;
  }
}

export const selectAgentsForDirectory = (
  state: Pick<AgentsStore, 'agentsByDirectory'>,
  directory?: string | null,
): Agent[] => {
  const cacheKey = getAgentsCacheKey(resolveDirectory(directory));
  return state.agentsByDirectory[cacheKey] ?? EMPTY_AGENTS;
};

export const useAgentsStore = create<AgentsStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedAgentName: null,
        agents: [],
        agentsByDirectory: {},
        disabledAgentsByDirectory: {},
        isLoading: false,
        agentDraft: null,

        loadDisabledAgents: async (requestedDirectory?: string | null) => {
          const configDirectory = resolveDirectory(requestedDirectory);
          const query = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';
          try {
            const response = await runtimeFetch(`/api/config/disabled-agents${query}`, {
              headers: {
                'Cache-Control': 'no-cache',
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
            });
            if (!response.ok) return false;
            const parsed = DisabledAgentsResponseSchema.safeParse(await response.json().catch(() => null));
            if (!parsed.success) return false;
            const cacheKey = getAgentsCacheKey(configDirectory);
            set((state) => ({ disabledAgentsByDirectory: { ...state.disabledAgentsByDirectory, [cacheKey]: parsed.data.agents } }));
            return true;
          } catch (error) {
            console.warn('[AgentsStore] Failed to read disabled agents:', error);
            return false;
          }
        },

        setSelectedAgent: (name: string | null) => {
          set({ selectedAgentName: name });
        },

        setAgentDraft: (draft: AgentDraft | null) => {
          set({ agentDraft: draft });
        },

        resetForRuntimeSwitch: () => {
          agentsGeneration += 1;
          agentsLastLoadedAt.clear();
          agentsLoadInFlight.clear();
          agentsLoadGeneration.clear();
          opencodeClient.clearAgentListRequests();
          set({ agents: [], agentsByDirectory: {}, isLoading: false });
        },

        loadAgents: async (requestedDirectory?: string | null) => {
          const configDirectory = resolveDirectory(requestedDirectory);
          const cacheKey = getAgentsCacheKey(configDirectory);
          const isAmbient = cacheKey === getAgentsCacheKey(getConfigDirectory());
          const now = Date.now();
          const loadedAt = agentsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedAgents = (get().agentsByDirectory[cacheKey] ?? (isAmbient ? get().agents : [])).length > 0;

          if (hasCachedAgents && now - loadedAt < AGENTS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const runtimeGeneration = agentsGeneration;
          const reloadEpoch = agentsReloadEpoch;
          const runtimeKey = getRuntimeKey();
          const wasRetired = (loadGeneration: number) => (
            agentsGeneration === runtimeGeneration
            && getRuntimeKey() === runtimeKey
            && (agentsReloadEpoch !== reloadEpoch
              || (agentsLoadGeneration.get(cacheKey) ?? 0) !== loadGeneration)
          );

          let inFlight = agentsLoadInFlight.get(cacheKey);
          while (inFlight) {
            if (inFlight.generation === (agentsLoadGeneration.get(cacheKey) ?? 0)) {
              const joined = inFlight;
              const loaded = await joined.request;
              return wasRetired(joined.generation) ? get().loadAgents(configDirectory) : loaded;
            }
            await inFlight.request;
            inFlight = agentsLoadInFlight.get(cacheKey);
          }

          const generation = agentsLoadGeneration.get(cacheKey) ?? 0;
          const isCurrentLoad = () => (
            agentsGeneration === runtimeGeneration
            && agentsReloadEpoch === reloadEpoch
            && (agentsLoadGeneration.get(cacheKey) ?? 0) === generation
            && getRuntimeKey() === runtimeKey
          );
          const request = (async () => {
            set({ isLoading: true });
            const previousAgents = get().agentsByDirectory[cacheKey] ?? (isAmbient ? get().agents : []);
            const previousSignature = buildAgentsSignature(previousAgents);

            for (let attempt = 0; attempt < 3; attempt++) {
              if (!isCurrentLoad()) return false;
              try {
                const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';

                const agents = await opencodeClient.listAgents(configDirectory);
                if (!isCurrentLoad()) return false;

                const agentsWithScope = await Promise.all(
                  agents.map(async (agent) => {
                    try {
                      const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(agent.name)}${queryParams}`, {
                        headers: {
                          'Cache-Control': 'no-cache',
                          ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
                        }
                      });

                      if (response.ok) {
                        const data = await response.json();

                        let scope = data.scope;

                        if (!scope && data.sources) {
                          const sources = data.sources;
                          scope = (sources.md?.exists ? sources.md.scope : undefined)
                            ?? (sources.json?.exists ? sources.json.scope : undefined)
                            ?? sources.md?.scope
                            ?? sources.json?.scope;
                        }

                        const mdPath: string | null | undefined = data.sources?.md?.path;
                        const group = parseAgentGroup(mdPath);

                        const activeSource = data.sources?.md?.exists
                          ? data.sources.md
                          : (data.sources?.json?.exists ? data.sources.json : null);
                        const legacy = activeSource?.legacy === true;
                        const sourcePath: string | null = activeSource?.path ?? null;
                        const native = data.isBuiltIn === true;

                        if (scope === 'project' || scope === 'user') {
                          return { ...agent, scope: scope as AgentScope, group, legacy, path: sourcePath, native };
                        }

                        return { ...agent, scope: undefined, group, legacy, path: sourcePath, native };
                      }
                    } catch (err) {
                      console.warn(`[AgentsStore] Failed to fetch config for agent ${agent.name}:`, err);
                    }
                    return agent;
                  })
                );

                if (!isCurrentLoad()) return false;
                const nextSignature = buildAgentsSignature(agentsWithScope);
                if (previousSignature !== nextSignature) {
                  set((state) => {
                    const next: Partial<AgentsStore> = {
                      agentsByDirectory: { ...state.agentsByDirectory, [cacheKey]: agentsWithScope },
                      isLoading: false,
                    };
                    if (isAmbient) next.agents = agentsWithScope;
                    return next;
                  });
                } else {
                  set({ isLoading: false });
                }
                if (generation === (agentsLoadGeneration.get(cacheKey) ?? 0)) {
                  agentsLastLoadedAt.set(cacheKey, Date.now());
                }
                return true;
              } catch {
                if (!isCurrentLoad()) return false;
              }
            }

            if (isCurrentLoad()) {
              set({ isLoading: false });
            }
            return false;
          })();

          const entry = { generation, request };
          agentsLoadInFlight.set(cacheKey, entry);
          let loaded: boolean;
          try {
            loaded = await request;
          } finally {
            if (agentsLoadInFlight.get(cacheKey) === entry) agentsLoadInFlight.delete(cacheKey);
          }
          return wasRetired(generation) ? get().loadAgents(configDirectory) : loaded;
        },

        fetchAgentEntity: async (name: string, requestedDirectory?: string | null) => {
          const envelope = await fetchAgentResource<AgentEntityEnvelope>(name, 'config', requestedDirectory);
          if (!envelope) return null;
          return { ...envelope, config: envelope.config ?? {} };
        },

        fetchAgentPermissions: async (name: string, requestedDirectory?: string | null) => {
          const envelope = await fetchAgentResource<AgentPermissionsEnvelope>(name, 'permissions', requestedDirectory);
          if (!envelope) return null;
          return {
            ...envelope,
            global: envelope.global ?? [],
            agent: envelope.agent ?? [],
            effective: envelope.effective ?? [],
          };
        },

        createAgent: async (config: AgentConfig, requestedDirectory?: string | null) => {
          try {
            console.log('[AgentsStore] Creating agent:', config.name);

            const agentConfig: Record<string, unknown> = {
              mode: config.mode || 'subagent',
            };

            if (config.description) agentConfig.description = config.description;
            if (config.model) agentConfig.model = config.model;
            if (hasValue(config.steps)) agentConfig.steps = config.steps;
            if (config.system) agentConfig.system = config.system;
            if (config.color) agentConfig.color = config.color;
            if (config.hidden !== undefined) agentConfig.hidden = config.hidden;
            if (config.request) agentConfig.request = config.request;
            if (config.permissions?.length) agentConfig.permissions = config.permissions;
            if (config.scope) agentConfig.scope = config.scope;

            console.log('[AgentsStore] Agent config to save:', agentConfig);

            const configDirectory = resolveDirectory(requestedDirectory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';

            const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(agentConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create agent';
              throw new Error(message);
            }

            invalidateAgentsLoadCache(configDirectory);

            if (payload?.requiresManualRestart) {
              upsertOptimisticAgentLocal(set, get, config.name, config);
              return { ok: true, requiresManualRestart: true };
            }

            const loaded = await get().loadAgents(configDirectory);
            if (loaded) {
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
            }
            return { ok: loaded };
          } catch (error) {
            console.error('Failed to create agent:', error);
            return { ok: false };
          }
        },

        updateAgent: async (name: string, config: Partial<AgentConfig>, requestedDirectory?: string | null) => {
          try {
            const agentConfig: Record<string, unknown> = {};

            if (config.mode !== undefined) agentConfig.mode = config.mode;
            if (config.description !== undefined) agentConfig.description = config.description;
            if (config.model !== undefined) agentConfig.model = config.model;
            if ('steps' in config) agentConfig.steps = config.steps ?? null;
            if (config.system !== undefined) agentConfig.system = config.system;
            if ('color' in config) agentConfig.color = config.color ?? null;
            if (config.hidden !== undefined) agentConfig.hidden = config.hidden;
            if ('disabled' in config) agentConfig.disabled = config.disabled ? true : null;
            if (config.request !== undefined) agentConfig.request = config.request;
            if (config.permissions !== undefined) agentConfig.permissions = config.permissions ?? [];

            const configDirectory = resolveDirectory(requestedDirectory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';

            const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify(agentConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update agent';
              throw new Error(message);
            }

            invalidateAgentsLoadCache(configDirectory);

            if (payload?.requiresManualRestart) {
              upsertOptimisticAgentLocal(set, get, name, config);
              return { ok: true, requiresManualRestart: true };
            }

            const [loaded] = await Promise.all([
              get().loadAgents(configDirectory),
              'disabled' in config ? get().loadDisabledAgents(configDirectory) : Promise.resolve(true),
            ]);
            if (loaded) {
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
            }
            return { ok: loaded };
          } catch (error) {
            console.error('Failed to update agent:', error);
            throw error;
          }
        },

        deleteAgent: async (name: string, scope?: AgentScope, requestedDirectory?: string | null) => {
          try {
            const configDirectory = resolveDirectory(requestedDirectory);
            const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';

            const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
              },
              body: JSON.stringify({ scope }),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete agent';
              throw new Error(message);
            }

            invalidateAgentsLoadCache(configDirectory);

            if (get().selectedAgentName === name) {
              set({ selectedAgentName: null });
            }

            const removeLocal = () => {
              set({ agents: get().agents.filter((agent) => agent.name !== name) });
            };

            if (payload?.requiresManualRestart) {
              removeLocal();
              return { ok: true, requiresManualRestart: true };
            }

            const loaded = await get().loadAgents(configDirectory);
            if (loaded) {
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
            }
            return { ok: loaded };
          } catch (error) {
            console.error('Failed to delete agent:', error);
            throw error;
          }
        },


        getAgentByName: (name: string, requestedDirectory?: string | null) => {
          return selectAgentsForDirectory(get(), requestedDirectory).find((agent) => agent.name === name);
        },

        getVisibleAgents: (requestedDirectory?: string | null) => {
          return filterVisibleAgents(selectAgentsForDirectory(get(), requestedDirectory));
        },
      }),
      {
        name: "agents-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedAgentName: state.selectedAgentName,
        }),
      },
    ),
    {
      name: "agents-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_agents_store__ = useAgentsStore;
}

const normalizeRefreshScopes = (scopes?: ConfigChangeScope[]): ConfigChangeScope[] => {
  if (!scopes || scopes.length === 0) {
    return ["all"];
  }

  const unique = Array.from(new Set(scopes));
  if (unique.includes("all")) {
    return ["all"];
  }

  return unique;
};

async function performConfigRefresh(options: {
  message?: string;
  delayMs?: number;
  scopes?: ConfigChangeScope[];
} = {}) {
  const { message, delayMs } = options;
  const scopes = normalizeRefreshScopes(options.scopes);

  try {
    updateConfigUpdateMessage(message || "Refreshing configuration…");
  } catch {
    // ignore
  }

  try {
    await waitForOpenCodeConnection(delayMs);

    const configStore = useConfigStore.getState();
    const agentConfigStore = useAgentsStore.getState();
    const commandsStore = useCommandsStore.getState();
    const skillsStore = useSkillsStore.getState();
    const skillsCatalogStore = useSkillsCatalogStore.getState();

    const refreshProviders = scopes.includes("all") || scopes.includes("providers");
    const refreshSdkAgents = scopes.includes("all") || scopes.includes("agents");
    const refreshAgentConfigs = scopes.includes("all") || scopes.includes("agents");
    const refreshCommands = scopes.includes("all") || scopes.includes("commands");
    const refreshSkills = scopes.includes("all") || scopes.includes("skills");

    const currentDirectory = getCurrentDirectory();
    if (refreshProviders || refreshSdkAgents) {
      invalidateConfigCatalogsForReload([
        ...(refreshProviders ? ["provider" as const] : []),
        ...(refreshSdkAgents ? ["agent" as const] : []),
      ]);
    }
    if (refreshAgentConfigs) {
      invalidateAllAgentsLoadCaches();
    }

    const sdkRefreshTasks: Promise<void>[] = [];
    if (refreshProviders) {
      sdkRefreshTasks.push(configStore.loadProviders({
        directory: currentDirectory,
        source: 'agentsStore:refreshConfig',
        fresh: true,
      }).then(() => undefined));
    }
    if (refreshSdkAgents) {
      sdkRefreshTasks.push(configStore.loadAgents({
        directory: currentDirectory,
        source: 'agentsStore:refreshConfig',
        fresh: true,
      }).then(() => undefined));
    }

    const uiRefreshTasks: Promise<void>[] = [];
    if (refreshAgentConfigs) {
      uiRefreshTasks.push(agentConfigStore.loadAgents(currentDirectory).then(() => undefined));
    }
    if (refreshCommands) {
      invalidateCommandsLoadCache(currentDirectory);
      uiRefreshTasks.push(commandsStore.loadCommands(currentDirectory).then(() => undefined));
    }
    if (refreshSkills) {
      invalidateSkillsLoadCache();
      uiRefreshTasks.push(skillsStore.loadSkills().then(() => undefined));
      uiRefreshTasks.push(skillsCatalogStore.loadCatalog({ refresh: true }).then(() => undefined));
    }

    updateConfigUpdateMessage("Refreshing configuration…");
    await Promise.all([...sdkRefreshTasks, ...uiRefreshTasks]);
  } catch (error) {
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry.");
    await sleep(1500);
    throw error;
  } finally {
    finishConfigUpdate();
  }
}

export async function refreshAfterOpenCodeRestart(options?: {
  message?: string;
  delayMs?: number;
  scopes?: ConfigChangeScope[];
}) {
  await performConfigRefresh(options);
}

export async function reloadOpenCodeConfiguration(options?: {
  message?: string;
  delayMs?: number;
  scopes?: ConfigChangeScope[];
}) {
  startConfigUpdate(options?.message || "Reloading OpenCode configuration…");

  try {

    const response = await runtimeFetch('/api/config/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error || 'Failed to reload configuration';
      throw new Error(message);
    }

    if (payload?.requiresManualRestart) {
      finishConfigUpdate();
      const error = new Error(
        payload?.message || 'Restart your connected OpenCode server to apply the changes.',
      );
      (error as Error & { requiresManualRestart?: boolean }).requiresManualRestart = true;
      throw error;
    }

    const refreshOptions = {
      ...options,
      scopes: options?.scopes ?? ["all"],
    };

    if (payload?.requiresReload) {
      await refreshAfterOpenCodeRestart({
        ...refreshOptions,
        message: payload.message,
        delayMs: payload.reloadDelayMs,
      });
    } else {
      await refreshAfterOpenCodeRestart(refreshOptions);
    }
  } catch (error) {
    console.error('[reloadOpenCodeConfiguration] Failed:', error);
    if ((error as Error & { requiresManualRestart?: boolean })?.requiresManualRestart) {
      throw error;
    }
    updateConfigUpdateMessage('Failed to reload configuration. Please try again.');
    await sleep(2000);
    finishConfigUpdate();
    throw error;
  }
}

let unsubscribeAgentsConfigChanges: (() => void) | null = null;

if (!unsubscribeAgentsConfigChanges) {
  unsubscribeAgentsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "agents")) {
      const { loadAgents } = useAgentsStore.getState();
      void loadAgents();
    }
  });
}
