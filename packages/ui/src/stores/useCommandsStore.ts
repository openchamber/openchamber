import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { opencodeClient } from "@/lib/opencode/client";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { noteDeferredRestartFromPayload } from "@/lib/opencode/deferredRestart";


export type CommandScope = 'user' | 'project';

export interface CommandConfig {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
  source?: string;
  template?: string;
  scope?: CommandScope;
}

export interface Command extends CommandConfig {
  isBuiltIn?: boolean;
}

// Built-in commands provided by OpenCode (not defined in user config directories)
const BUILTIN_COMMAND_NAMES = new Set(['init', 'review']);

export const isCommandBuiltIn = (command: Command): boolean => {
  return BUILTIN_COMMAND_NAMES.has(command.name);
};

const CONFIG_EVENT_SOURCE = "useCommandsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const COMMANDS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_COMMANDS_CACHE_KEY = '__default__';
const commandsLastLoadedAt = new Map<string, number>();
const commandsLoadInFlight = new Map<string, Promise<boolean>>();

const getCommandsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_COMMANDS_CACHE_KEY;
};

export const invalidateCommandsLoadCache = (directory: string | null = getRequestDirectory()) => {
  commandsLastLoadedAt.delete(getCommandsCacheKey(directory));
};

const buildCommandsSignature = (commands: Command[]): string => {
  return commands
    .map((command) => [
      command.name,
      command.scope ?? '',
      command.description ?? '',
      command.agent ?? '',
      command.model ?? '',
      String(command.isBuiltIn === true),
    ].join('|'))
    .join('||');
};

const upsertCommandLocal = (
  set: (updater: (state: CommandsStore) => Partial<CommandsStore>) => void,
  get: () => CommandsStore,
  name: string,
  config: Partial<CommandConfig>,
  directory: string | null,
) => {
  const cacheKey = getCommandsCacheKey(directory);
  const isAmbient = cacheKey === getCommandsCacheKey(getRequestDirectory());
  const current = get().commandsByDirectory[cacheKey] ?? [];
  const existing = current.find((command) => command.name === name);
  const nextCommand: Command = {
    ...existing,
    name,
    ...config,
    source: config.source ?? existing?.source,
    scope: config.scope ?? existing?.scope,
    isBuiltIn: existing?.isBuiltIn,
  };
  const nextCommands = current.some((command) => command.name === name)
    ? current.map((command) => (command.name === name ? nextCommand : command))
    : [...current, nextCommand];
  set((state) => {
    const next: Partial<CommandsStore> = {
      commandsByDirectory: { ...state.commandsByDirectory, [cacheKey]: nextCommands },
    };
    if (isAmbient) next.commands = nextCommands;
    return next;
  });
};

const removeCommandLocal = (
  set: (updater: (state: CommandsStore) => Partial<CommandsStore>) => void,
  get: () => CommandsStore,
  name: string,
  directory: string | null,
) => {
  const cacheKey = getCommandsCacheKey(directory);
  const isAmbient = cacheKey === getCommandsCacheKey(getRequestDirectory());
  const nextCommands = (get().commandsByDirectory[cacheKey] ?? []).filter((command) => command.name !== name);
  const clearSelection = get().selectedCommandName === name;
  set((state) => {
    const next: Partial<CommandsStore> = {
      commandsByDirectory: { ...state.commandsByDirectory, [cacheKey]: nextCommands },
    };
    if (isAmbient) next.commands = nextCommands;
    if (clearSelection) next.selectedCommandName = null;
    return next;
  });
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
  return getRequestDirectory();
};

const getRequestDirectory = (): string | null => {
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
    console.warn('[CommandsStore] Error resolving config directory:', err);
  }

  return null;
};

const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

export interface CommandDraft {
  name: string;
  scope: CommandScope;
  description?: string;
  agent?: string | null;
  model?: string | null;
  template?: string;
}

interface CommandsStore {

  selectedCommandName: string | null;
  /** Commands of the project the app is on. Chat and autocompletes read this one. */
  commands: Command[];
  /** Every directory loaded so far, including the ambient one. */
  commandsByDirectory: Record<string, Command[]>;
  isLoading: boolean;
  commandDraft: CommandDraft | null;

  setSelectedCommand: (name: string | null) => void;
  setCommandDraft: (draft: CommandDraft | null) => void;
  loadCommands: (directory?: string | null) => Promise<boolean>;
  createCommand: (config: CommandConfig, directory?: string | null) => Promise<boolean>;
  updateCommand: (name: string, config: Partial<CommandConfig>, directory?: string | null) => Promise<boolean>;
  deleteCommand: (name: string, directory?: string | null) => Promise<boolean>;
  getCommandByName: (name: string, directory?: string | null) => Command | undefined;
}

declare global {
  interface Window {
    __zustand_commands_store__?: UseBoundStore<StoreApi<CommandsStore>>;
  }
}

const EMPTY_COMMANDS: Command[] = [];

/**
 * Commands of one project. Returns a stored array so components can select it
 * directly; an omitted directory means the project the app is on.
 */
export const selectCommandsForDirectory = (
  state: Pick<CommandsStore, 'commandsByDirectory'>,
  directory?: string | null,
): Command[] => {
  const cacheKey = getCommandsCacheKey(resolveDirectory(directory));
  return state.commandsByDirectory[cacheKey] ?? EMPTY_COMMANDS;
};

export const useCommandsStore = create<CommandsStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedCommandName: null,
        commands: [],
        commandsByDirectory: {},
        isLoading: false,
        commandDraft: null,

        setSelectedCommand: (name: string | null) => {
          set({ selectedCommandName: name });
        },

        setCommandDraft: (draft: CommandDraft | null) => {
          set({ commandDraft: draft });
        },

        loadCommands: async (requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getCommandsCacheKey(directory);
          const isAmbient = cacheKey === getCommandsCacheKey(getRequestDirectory());
          const now = Date.now();
          const loadedAt = commandsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedCommands = (get().commandsByDirectory[cacheKey] ?? (isAmbient ? get().commands : [])).length > 0;

          if (hasCachedCommands && now - loadedAt < COMMANDS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = commandsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const request = (async () => {
            set({ isLoading: true });
            // Failure must never look like an empty project. The mirror is the
            // fallback so a directory loaded before this map existed still counts.
            const previousCommands = get().commandsByDirectory[cacheKey] ?? (isAmbient ? get().commands : []);
            const previousSignature = buildCommandsSignature(previousCommands);
            let lastError: unknown = null;

            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

                // Ensure the list is scoped to the same directory we use for config source detection.
                const commands = await runBackgroundNetworkTask(() => opencodeClient.withDirectory(
                  directory,
                  () => opencodeClient.listCommandsWithDetails()
                ));

                const configurableCommands = commands.filter((cmd) => cmd.source !== 'skill');
                const commandsWithScope = await Promise.all(
                  configurableCommands.map(async (cmd) => {
                    try {
                      // Force no-cache
                      const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(cmd.name)}${queryParams}`, {
                        headers: {
                          'Cache-Control': 'no-cache',
                          ...(directory ? { 'x-opencode-directory': directory } : {}),
                        }
                      });

                      if (response.ok) {
                        const data = await response.json();

                        // Prioritize explicit scope
                        let scope = data.scope;

                        // Fallback to deducing from sources
                        if (!scope && data.sources) {
                          const sources = data.sources;
                          scope = (sources.md?.exists ? sources.md.scope : undefined)
                            ?? (sources.json?.exists ? sources.json.scope : undefined)
                            ?? sources.md?.scope
                            ?? sources.json?.scope;
                        }

                        if (scope === 'project' || scope === 'user') {
                          return { ...cmd, scope: scope as CommandScope };
                        }

                        // Explicitly set null scope if not found
                        return { ...cmd, scope: undefined };
                      }
                    } catch (err) {
                      console.warn(`[CommandsStore] Failed to fetch config for command ${cmd.name}:`, err);
                    }
                    return cmd;
                  })
                );

                const nextSignature = buildCommandsSignature(commandsWithScope);
                if (previousSignature !== nextSignature) {
                  set((state) => {
                    const next: Partial<CommandsStore> = {
                      commandsByDirectory: { ...state.commandsByDirectory, [cacheKey]: commandsWithScope },
                      isLoading: false,
                    };
                    if (isAmbient) next.commands = commandsWithScope;
                    return next;
                  });
                } else {
                  set({ isLoading: false });
                }
                commandsLastLoadedAt.set(cacheKey, Date.now());
                return true;
              } catch (error) {
                lastError = error;
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
            }

            console.error("Failed to load commands:", lastError);
            set((state) => {
              const next: Partial<CommandsStore> = {
                commandsByDirectory: { ...state.commandsByDirectory, [cacheKey]: previousCommands },
                isLoading: false,
              };
              if (isAmbient) next.commands = previousCommands;
              return next;
            });
            return false;
          })();

          commandsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            commandsLoadInFlight.delete(cacheKey);
          }
        },

        createCommand: async (config: CommandConfig, requestedDirectory?: string | null) => {
          try {
            console.log('[CommandsStore] Creating command:', config.name);

            const commandConfig: Record<string, unknown> = {
              template: config.template || '',
            };

            if (config.description) commandConfig.description = config.description;
            if (config.agent) commandConfig.agent = config.agent;
            if (config.model) commandConfig.model = config.model;
            if (config.scope) commandConfig.scope = config.scope;

            console.log('[CommandsStore] Command config to save:', commandConfig);

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(commandConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command created successfully');

            invalidateCommandsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertCommandLocal(set, get, config.name, config, directory);
              return true;
            }

            if (noteDeferredRestartFromPayload(payload, 'commands', { id: config.name })) {
              upsertCommandLocal(set, get, config.name, config, directory);
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Creating command configuration…");
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadCommands(directory);
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch (error) {
            console.error("[CommandsStore] Failed to create command:", error);
            return false;
          }
        },

        updateCommand: async (name: string, config: Partial<CommandConfig>, requestedDirectory?: string | null) => {
          try {
            console.log('[CommandsStore] Updating command:', name);
            console.log('[CommandsStore] Config received:', config);

            const commandConfig: Record<string, unknown> = {};

            if (config.description !== undefined) commandConfig.description = config.description;
            if (config.agent !== undefined) commandConfig.agent = config.agent;
            if (config.model !== undefined) commandConfig.model = config.model;
            if (config.template !== undefined) commandConfig.template = config.template;

            console.log('[CommandsStore] Command config to update:', commandConfig);

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(commandConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command updated successfully');

            invalidateCommandsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertCommandLocal(set, get, name, config, directory);
              return true;
            }

            if (noteDeferredRestartFromPayload(payload, 'commands', { id: name })) {
              upsertCommandLocal(set, get, name, config, directory);
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Updating command configuration…");
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadCommands(directory);
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch (error) {
            console.error("[CommandsStore] Failed to update command:", error);
            return false;
          }
        },

        deleteCommand: async (name: string, requestedDirectory?: string | null) => {
          try {
            // Use active project root for project-level command support
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command deleted successfully');

            invalidateCommandsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              removeCommandLocal(set, get, name, directory);
              return true;
            }

            if (noteDeferredRestartFromPayload(payload, 'commands', { id: name })) {
              removeCommandLocal(set, get, name, directory);
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Deleting command configuration…");
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadCommands(directory);
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }

            if (get().selectedCommandName === name) {
              set({ selectedCommandName: null });
            }

            return loaded;
          } catch (error) {
            console.error("Failed to delete command:", error);
            return false;
          }
        },

        getCommandByName: (name: string, requestedDirectory?: string | null) => {
          return selectCommandsForDirectory(get(), requestedDirectory).find((command) => command.name === name);
        },
      }),
      {
        name: "commands-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedCommandName: state.selectedCommandName,
        }),
      },
    ),
    {
      name: "commands-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_commands_store__ = useCommandsStore;
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

async function performFullConfigRefresh(options: { message?: string; delayMs?: number } = {}) {
  const { message, delayMs } = options;

  try {
    updateConfigUpdateMessage(message || "Refreshing commands…");
  } catch {
    // ignore
  }

  try {
    await waitForOpenCodeConnection(delayMs);
    updateConfigUpdateMessage("Refreshing commands…");

    const commandsStore = useCommandsStore.getState();

    invalidateCommandsLoadCache();
    await commandsStore.loadCommands();

    emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
  } catch (error) {
    console.error("[CommandsStore] Failed to refresh configuration after OpenCode restart:", error);
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry refreshing configuration manually.");
    await sleep(1500);
    throw error;
  } finally {
    finishConfigUpdate();
  }
}

let unsubscribeCommandsConfigChanges: (() => void) | null = null;

if (!unsubscribeCommandsConfigChanges) {
  unsubscribeCommandsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "commands")) {
      const { loadCommands } = useCommandsStore.getState();
      void loadCommands();
    }
  });
}
