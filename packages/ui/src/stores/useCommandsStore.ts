import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { opencodeClient } from "@/lib/opencode/client";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import { getSafeStorage } from "./utils/safeStorage";
import { useProjectsStore } from "@/stores/useProjectsStore";


export type CommandScope = 'user' | 'project';

export interface CommandConfig {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
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
  commands: Command[];
  isLoading: boolean;
  commandDraft: CommandDraft | null;

  setSelectedCommand: (name: string | null) => void;
  setCommandDraft: (draft: CommandDraft | null) => void;
  loadCommands: () => Promise<boolean>;
  createCommand: (config: CommandConfig) => Promise<boolean>;
  updateCommand: (name: string, config: Partial<CommandConfig>) => Promise<boolean>;
  deleteCommand: (name: string) => Promise<boolean>;
  getCommandByName: (name: string) => Command | undefined;
}

declare global {
  interface Window {
    __zustand_commands_store__?: UseBoundStore<StoreApi<CommandsStore>>;
  }
}

export const useCommandsStore = create<CommandsStore>()(
  devtools(
    persist(
      (set, get) => ({

        selectedCommandName: null,
        commands: [],
        isLoading: false,
        commandDraft: null,

        setSelectedCommand: (name: string | null) => {
          set({ selectedCommandName: name });
        },

        setCommandDraft: (draft: CommandDraft | null) => {
          set({ commandDraft: draft });
        },

        loadCommands: async () => {
          set({ isLoading: true });
          const previousCommands = get().commands;
          let lastError: unknown = null;

          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const directory = getRequestDirectory();
              const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
              
              // Ensure the list is scoped to the same directory we use for config source detection.
              const commands = await opencodeClient.withDirectory(
                directory,
                () => opencodeClient.listCommandsWithDetails()
              );
              
              const commandsWithScope = await Promise.all(
                commands.map(async (cmd) => {
                  try {
                    // Force no-cache
                    const response = await fetch(`/api/config/commands/${encodeURIComponent(cmd.name)}${queryParams}`, {
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
              
              if (JSON.stringify(previousCommands) !== JSON.stringify(commandsWithScope)) {
                set({ commands: commandsWithScope, isLoading: false });
              } else {
                set({ isLoading: false });
              }
              return true;
            } catch (error) {
              lastError = error;
              const waitMs = 200 * (attempt + 1);
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }

          console.error("Failed to load commands:", lastError);
          set({ commands: previousCommands, isLoading: false });
          return false;
        },

        createCommand: async (config: CommandConfig) => {
          startConfigUpdate("Creating command configuration…");
          let requiresReload = false;
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

            const directory = getRequestDirectory();
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await fetch(`/api/config/commands/${encodeURIComponent(config.name)}${queryParams}`, {
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

            const needsReload = payload?.requiresReload ?? true;
            if (needsReload) {
              requiresReload = true;
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadCommands();
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch (error) {
            console.error("[CommandsStore] Failed to create command:", error);
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        updateCommand: async (name: string, config: Partial<CommandConfig>) => {
          startConfigUpdate("Updating command configuration…");
          let requiresReload = false;
          try {
            console.log('[CommandsStore] Updating command:', name);
            console.log('[CommandsStore] Config received:', config);

            const commandConfig: Record<string, unknown> = {};

            if (config.description !== undefined) commandConfig.description = config.description;
            if (config.agent !== undefined) commandConfig.agent = config.agent;
            if (config.model !== undefined) commandConfig.model = config.model;
            if (config.template !== undefined) commandConfig.template = config.template;

            console.log('[CommandsStore] Command config to update:', commandConfig);

            const directory = getRequestDirectory();
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await fetch(`/api/config/commands/${encodeURIComponent(name)}${queryParams}`, {
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

            const needsReload = payload?.requiresReload ?? true;
            if (needsReload) {
              requiresReload = true;
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadCommands();
            if (loaded) {
              emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch (error) {
            console.error("[CommandsStore] Failed to update command:", error);
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        deleteCommand: async (name: string) => {
          startConfigUpdate("Deleting command configuration…");
          let requiresReload = false;
          try {
            // Use active project root for project-level command support
            const directory = getRequestDirectory();
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await fetch(`/api/config/commands/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete command';
              throw new Error(message);
            }

            console.log('[CommandsStore] Command deleted successfully');

            const needsReload = payload?.requiresReload ?? true;
            if (needsReload) {
              requiresReload = true;
              await performFullConfigRefresh({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadCommands();
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
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        getCommandByName: (name: string) => {
          const { commands } = get();
          return commands.find((c) => c.name === name);
        },
      }),
      {
        name: "commands-store",
        storage: createJSONStorage(() => getSafeStorage()),
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

    await commandsStore.loadCommands();

    emitConfigChange("commands", { source: CONFIG_EVENT_SOURCE });
  } catch (error) {
    console.error("[CommandsStore] Failed to refresh configuration after OpenCode restart:", error);
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry refreshing configuration manually.");
    await sleep(1500);
  } finally {
    finishConfigUpdate();
  }
}

export async function reloadOpenCodeConfiguration(options?: { message?: string; delayMs?: number }) {
  startConfigUpdate(options?.message || "Reloading OpenCode configuration…");

  try {
    const response = await fetch('/api/config/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error || 'Failed to reload configuration';
      throw new Error(message);
    }

    if (payload?.requiresReload) {
      await performFullConfigRefresh({
        message: payload.message,
        delayMs: payload.reloadDelayMs,
      });
    } else {
      await performFullConfigRefresh(options);
    }
  } catch (error) {
    console.error('[reloadOpenCodeConfiguration] Failed:', error);
    updateConfigUpdateMessage('Failed to reload configuration. Please try again.');
    await sleep(2000);
    finishConfigUpdate();
    throw error;
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
