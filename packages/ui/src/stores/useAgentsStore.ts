import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Agent, PermissionConfig } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges, type ConfigChangeScope } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { noteDeferredRestartFromPayload } from "@/lib/opencode/deferredRestart";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useConfigStore } from "@/stores/useConfigStore";
import { invalidateCommandsLoadCache, useCommandsStore } from "@/stores/useCommandsStore";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { useSkillsCatalogStore } from "@/stores/useSkillsCatalogStore";
import { invalidateSkillsLoadCache, useSkillsStore } from "@/stores/useSkillsStore";
import { runtimeFetch } from "@/lib/runtime-fetch";

// Note: useDirectoryStore cannot be imported at top level to avoid circular dependency
// useDirectoryStore -> useAgentsStore (for refreshAfterOpenCodeRestart)
// useAgentsStore -> useDirectoryStore (for currentDirectory)
const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__zustand_directory_store__;
    if (store) {
      return store.getState().currentDirectory;
    }
  } catch {
    // ignore
  }

  return null;
};

/**
 * Directory a call operates on. Settings can browse another project without
 * moving the app, so every entry point takes one; omitting it means the project
 * the app is currently on.
 */
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
    
    // 1. Primary: Active project path from store
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    // 2. Fallback: current OpenCode directory (session / runtime)
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
const agentsLoadInFlight = new Map<string, Promise<boolean>>();

const getAgentsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_AGENTS_CACHE_KEY;
};

const invalidateAgentsLoadCache = (directory: string | null = getConfigDirectory()) => {
  agentsLastLoadedAt.delete(getAgentsCacheKey(directory));
};

const buildAgentsSignature = (agents: Agent[]): string => {
  return agents
    .map((agent) => {
      const extended = agent as AgentWithExtras;
      return [
        agent.name,
        extended.mode ?? '',
        typeof extended.model === 'object' && extended.model
          ? `${extended.model.providerID ?? ''}/${extended.model.modelID ?? ''}`
          : String(extended.model ?? ''),
        String(extended.temperature ?? ''),
        String((extended as { topP?: unknown; top_p?: unknown }).topP ?? (extended as { topP?: unknown; top_p?: unknown }).top_p ?? ''),
        extended.prompt ?? '',
        JSON.stringify(extended.permission ?? null),
        extended.scope ?? '',
        extended.group ?? '',
        extended.description ?? '',
        String(extended.hidden === true),
        String(extended.native === true),
      ].join('|');
    })
    .join('||');
};

export type AgentScope = 'user' | 'project';

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string | null;
  variant?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  prompt?: string | null;
  mode?: "primary" | "subagent" | "all";
  permission?: PermissionConfig | null;

  disable?: boolean;
  scope?: AgentScope;
}

/**
 * Result of an agent config mutation.
 * `requiresManualRestart` is true when the change was persisted to disk but the
 * connected (external) OpenCode server could not be reloaded by OpenChamber, so
 * the user must restart that server before the change takes effect.
 * `restartDeferred` is true when the change is saved and waiting for an explicit
 * Apply & Restart OpenCode action.
 */
export interface AgentMutationResult {
  ok: boolean;
  requiresManualRestart?: boolean;
  restartDeferred?: boolean;
}

// Extended Agent type for API properties not in SDK types
export type AgentWithExtras = Agent & {
  native?: boolean;
  hidden?: boolean;
  options?: { hidden?: boolean };
  scope?: AgentScope;
  /** Subfolder name parsed from file path, e.g. "business", "development" */
  group?: string;
};

/** Parse the subfolder group name from an agent file path.
 *  e.g. "~/.config/opencode/agents/business/ceo.md" → "business"
 *  e.g. "~/.config/opencode/agents/ceo.md"          → undefined
 */
function parseAgentGroup(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const normalizedPath = path.replace(/\\/g, '/');
  const idx = normalizedPath.lastIndexOf('/agents/');
  if (idx === -1) return undefined;
  const relative = normalizedPath.substring(idx + '/agents/'.length);
  const parts = relative.split('/');
  // parts[0] = group, parts[1] = filename; need at least 2 parts
  return parts.length > 1 ? parts[0] : undefined;
}

// Helper to check if agent is built-in (handles both SDK 'builtIn' and API 'native')
export const isAgentBuiltIn = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.native === true || extended.builtIn === true;
};

// Helper to check if agent is hidden (internal agents like title, compaction, summary)
// Checks both top-level hidden and options.hidden (OpenCode API inconsistency workaround)
export const isAgentHidden = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras;
  return extended.hidden === true || extended.options?.hidden === true;
};

// Helper to filter only visible (non-hidden) agents
export const filterVisibleAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !isAgentHidden(agent));

const CONFIG_EVENT_SOURCE = "useAgentsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

const hasValue = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

const parseModelRef = (model: string | null | undefined): Agent['model'] | undefined => {
  if (!model || typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return { providerID: trimmed, modelID: trimmed };
  }
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
};

const buildOptimisticAgent = (
  name: string,
  config: Partial<AgentConfig>,
  previous?: Agent,
): AgentWithExtras => {
  const previousExtras = previous as AgentWithExtras | undefined;
  const model = 'model' in config
    ? parseModelRef(config.model)
    : previous?.model;
  return {
    ...(previous || { name }),
    name,
    description: config.description !== undefined ? (config.description || undefined) : previous?.description,
    mode: config.mode ?? previous?.mode ?? 'subagent',
    model,
    variant: 'variant' in config ? (config.variant ?? undefined) : previous?.variant,
    temperature: 'temperature' in config ? (config.temperature ?? undefined) : previous?.temperature,
    topP: 'top_p' in config ? (config.top_p ?? undefined) : previous?.topP,
    prompt: config.prompt !== undefined ? (config.prompt || undefined) : previous?.prompt,
    permission: config.permission !== undefined ? (config.permission || undefined) : previous?.permission,
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

export interface AgentDraft {
  name: string;
  scope: AgentScope;
  description?: string;
  model?: string | null;
  variant?: string;
  temperature?: number | null;
  top_p?: number | null;
  prompt?: string;
  mode?: "primary" | "subagent" | "all";
  permission?: PermissionConfig;
  disable?: boolean;
}

interface AgentsStore {

  selectedAgentName: string | null;
  /** Agents of the project the app is on. Chat and pickers read this one. */
  agents: Agent[];
  /** Every directory loaded so far, including the ambient one. */
  agentsByDirectory: Record<string, Agent[]>;
  isLoading: boolean;
  agentDraft: AgentDraft | null;

  setSelectedAgent: (name: string | null) => void;
  setAgentDraft: (draft: AgentDraft | null) => void;
  loadAgents: (directory?: string | null) => Promise<boolean>;
  createAgent: (config: AgentConfig, directory?: string | null) => Promise<AgentMutationResult>;
  updateAgent: (name: string, config: Partial<AgentConfig>, directory?: string | null) => Promise<AgentMutationResult>;
  deleteAgent: (name: string, scope?: AgentScope, directory?: string | null) => Promise<AgentMutationResult>;
  getAgentByName: (name: string, directory?: string | null) => Agent | undefined;
  // Returns only visible agents (excludes hidden internal agents)
  getVisibleAgents: (directory?: string | null) => Agent[];
}

declare global {
  interface Window {
    __zustand_agents_store__?: UseBoundStore<StoreApi<AgentsStore>>;
  }
}

const EMPTY_AGENTS: Agent[] = [];

/**
 * Agents of one project. Returns a stored array so components can select it
 * directly; an omitted directory means the project the app is on.
 */
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
        isLoading: false,
        agentDraft: null,

        setSelectedAgent: (name: string | null) => {
          set({ selectedAgentName: name });
        },

        setAgentDraft: (draft: AgentDraft | null) => {
          set({ agentDraft: draft });
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

          const inFlight = agentsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            // Failure must never look like an empty project. The mirror is the
            // fallback so a directory loaded before this map existed still counts.
            const previousAgents = get().agentsByDirectory[cacheKey] ?? (isAmbient ? get().agents : []);
            const previousSignature = buildAgentsSignature(previousAgents);

            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const queryParams = configDirectory ? `?directory=${encodeURIComponent(configDirectory)}` : '';

                // Ensure we list agents using the correct project context. Pass the
                // directory directly so this shares the in-flight request with the config
                // store instead of issuing a duplicate agents fetch at startup.
                const agents = await opencodeClient.listAgents(configDirectory);

                const agentsWithScope = await Promise.all(
                  agents.map(async (agent) => {
                    try {
                      // Force no-cache to ensure we get the latest scope info
                      const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(agent.name)}${queryParams}`, {
                        headers: {
                          'Cache-Control': 'no-cache',
                          ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
                        }
                      });

                      if (response.ok) {
                        const data = await response.json();

                        // Prioritize explicit scope from server response
                        let scope = data.scope;

                        // Fallback to deducing from sources if top-level scope is missing
                        if (!scope && data.sources) {
                          const sources = data.sources;
                          scope = (sources.md?.exists ? sources.md.scope : undefined)
                            ?? (sources.json?.exists ? sources.json.scope : undefined)
                            ?? sources.md?.scope
                            ?? sources.json?.scope;
                        }

                        // Parse subfolder group from file path
                        const mdPath: string | null | undefined = data.sources?.md?.path;
                        const group = parseAgentGroup(mdPath);

                        if (scope === 'project' || scope === 'user') {
                          return { ...agent, scope: scope as AgentScope, group };
                        }

                        // Explicitly set null scope if not found, to clear stale state
                        return { ...agent, scope: undefined, group };
                      }
                    } catch (err) {
                      console.warn(`[AgentsStore] Failed to fetch config for agent ${agent.name}:`, err);
                    }
                    return agent;
                  })
                );

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
                agentsLastLoadedAt.set(cacheKey, Date.now());
                return true;
              } catch {
                // ignore error
              }
            }

            set({ isLoading: false });
            return false;
          })();

          agentsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            agentsLoadInFlight.delete(cacheKey);
          }
        },

        createAgent: async (config: AgentConfig, requestedDirectory?: string | null) => {
          try {
            console.log('[AgentsStore] Creating agent:', config.name);

            const agentConfig: Record<string, unknown> = {
              mode: config.mode || 'subagent',
            };

            if (config.description) agentConfig.description = config.description;
            if (config.model) agentConfig.model = config.model;
            if (config.variant) agentConfig.variant = config.variant;
            if (hasValue(config.temperature)) agentConfig.temperature = config.temperature;
            if (hasValue(config.top_p)) agentConfig.top_p = config.top_p;
            if (config.prompt) agentConfig.prompt = config.prompt;
            if (config.permission) agentConfig.permission = config.permission;
            if (config.disable !== undefined) agentConfig.disable = config.disable;
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

            if (noteDeferredRestartFromPayload(payload, 'agents', { id: config.name })) {
              upsertOptimisticAgentLocal(set, get, config.name, config);
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
              return { ok: true, restartDeferred: true };
            }

            startConfigUpdate("Creating agent configuration…");
            const needsReload = payload?.requiresReload ?? true;
            if (needsReload) {
              await refreshAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
                scopes: ["agents"],
                mode: "projects",
              });
              return { ok: true };
            }

            const loaded = await get().loadAgents(configDirectory);
            if (loaded) {
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
            }
            finishConfigUpdate();
            return { ok: loaded };
          } catch (error) {
            console.error('Failed to create agent:', error);
            finishConfigUpdate();
            return { ok: false };
          }
        },

        updateAgent: async (name: string, config: Partial<AgentConfig>, requestedDirectory?: string | null) => {
          try {
            const agentConfig: Record<string, unknown> = {};

            if (config.mode !== undefined) agentConfig.mode = config.mode;
            if (config.description !== undefined) agentConfig.description = config.description;
            if (config.model !== undefined) agentConfig.model = config.model;
            if ('variant' in config) agentConfig.variant = config.variant ?? null;
            if ('temperature' in config) agentConfig.temperature = config.temperature ?? null;
            if ('top_p' in config) agentConfig.top_p = config.top_p ?? null;
            if (config.prompt !== undefined) agentConfig.prompt = config.prompt;
            if (config.permission !== undefined) agentConfig.permission = config.permission;
            if (config.disable !== undefined) agentConfig.disable = config.disable;

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

            if (noteDeferredRestartFromPayload(payload, 'agents', { id: name })) {
              upsertOptimisticAgentLocal(set, get, name, config);
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
              return { ok: true, restartDeferred: true };
            }

            startConfigUpdate("Updating agent configuration…");
            const needsReload = payload?.requiresReload ?? true;
            if (needsReload) {
              await refreshAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
                scopes: ["agents"],
                mode: "projects",
              });
              return { ok: true };
            }

            const loaded = await get().loadAgents(configDirectory);
            if (loaded) {
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
            }
            finishConfigUpdate();
            return { ok: loaded };
          } catch (error) {
            console.error('Failed to update agent:', error);
            finishConfigUpdate();
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

            if (noteDeferredRestartFromPayload(payload, 'agents', { id: name })) {
              removeLocal();
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
              return { ok: true, restartDeferred: true };
            }

            startConfigUpdate("Deleting agent configuration…");
            const needsReload = payload?.requiresReload ?? true;
            if (needsReload) {
              await refreshAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
                scopes: ["agents"],
                mode: "projects",
              });
              return { ok: true };
            }

            const loaded = await get().loadAgents(configDirectory);
            if (loaded) {
              emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
            }

            finishConfigUpdate();
            return { ok: loaded };
          } catch (error) {
            console.error('Failed to delete agent:', error);
            finishConfigUpdate();
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

async function waitForOpenCodeConnection(delayMs?: number) {
  const initialPause = typeof delayMs === "number" && delayMs > 0
    ? Math.min(delayMs, FAST_HEALTH_POLL_INTERVAL_MS)
    : 0;

  if (initialPause > 0) {
    await sleep(initialPause);
  }

  const start = Date.now();
  let attempt = 0;
  let lastError: unknown = null;

  while (Date.now() - start < MAX_HEALTH_WAIT_MS) {
    attempt += 1;
    updateConfigUpdateMessage(`Waiting for OpenCode… (attempt ${attempt})`);

    try {
      const isHealthy = await opencodeClient.checkHealth();
      if (isHealthy) {
        return;
      }
      lastError = new Error("OpenCode health check reported not ready");
    } catch (error) {
      lastError = error;
    }

    const elapsed = Date.now() - start;

    const waitMs =
      attempt <= FAST_HEALTH_POLL_ATTEMPTS && elapsed < 1200
        ? FAST_HEALTH_POLL_INTERVAL_MS
        : Math.min(
            SLOW_HEALTH_POLL_BASE_MS +
              Math.max(0, attempt - FAST_HEALTH_POLL_ATTEMPTS) * SLOW_HEALTH_POLL_INCREMENT_MS,
            SLOW_HEALTH_POLL_MAX_MS,
          );

    await sleep(waitMs);
  }

  throw lastError || new Error("OpenCode did not become ready in time");
}

type ConfigRefreshMode = "active" | "projects";

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
  mode?: ConfigRefreshMode;
} = {}) {
  const { message, delayMs } = options;
  const scopes = normalizeRefreshScopes(options.scopes);
  const mode: ConfigRefreshMode = options.mode ?? (scopes.includes("all") ? "projects" : "active");

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
    const projects = mode === "projects" ? useProjectsStore.getState().projects : [];
    const directoriesToRefresh = Array.from(
      new Set([
        ...(currentDirectory ? [currentDirectory] : []),
        ...projects.map((project) => project.path).filter(Boolean),
      ]),
    );

    if (scopes.includes("all") && mode === "projects") {
      useConfigStore.setState({ directoryScoped: {} });
    }

    if (refreshProviders) {
      useConfigStore.getState().invalidateModelMetadataCache();
      useConfigStore.getState().invalidateProviderCache(mode === "active" ? currentDirectory : undefined);
    }

    const sdkRefreshTasks: Promise<void>[] = [];
    for (const directory of directoriesToRefresh) {
      if (refreshProviders) {
        sdkRefreshTasks.push(configStore.loadProviders({ directory, source: 'agentsStore:refreshConfig' }).then(() => undefined));
      }
      if (refreshSdkAgents) {
        sdkRefreshTasks.push(configStore.loadAgents({ directory, source: 'agentsStore:refreshConfig' }).then(() => undefined));
      }
    }

    const uiRefreshTasks: Promise<void>[] = [];
    if (refreshAgentConfigs) {
      invalidateAgentsLoadCache(currentDirectory);
      uiRefreshTasks.push(agentConfigStore.loadAgents().then(() => undefined));
    }
    if (refreshCommands) {
      invalidateCommandsLoadCache(currentDirectory);
      uiRefreshTasks.push(commandsStore.loadCommands().then(() => undefined));
    }
    if (refreshSkills) {
      // Match loadSkills cache key (active-project-first). Passing client/directory-store
      // path here misses the key when those diverge after getRequestDirectory().
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
  mode?: ConfigRefreshMode;
}) {
  await performConfigRefresh(options);
}

export async function reloadOpenCodeConfiguration(options?: {
  message?: string;
  delayMs?: number;
  scopes?: ConfigChangeScope[];
  mode?: ConfigRefreshMode;
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
      mode: options?.mode ?? "projects",
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
