import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { getSafeStorage } from "./utils/safeStorage";

import { opencodeClient } from '@/lib/opencode/client';

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

export type SkillScope = 'user' | 'project';
export type SkillSource = 'opencode' | 'claude' | 'agents';

export interface SupportingFile {
  name: string;
  path: string;
  fullPath: string;
}

export interface SkillSources {
  md: {
    exists: boolean;
    path: string | null;
    dir: string | null;
    fields: string[];
    scope?: SkillScope | null;
    source?: SkillSource | null;
    supportingFiles: SupportingFile[];
    // Actual content values
    name?: string;
    description?: string;
    instructions?: string;
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  /** Domain folder parsed from file path, e.g. "automation-ai", "lark-ecosystem" */
  group?: string;
}

/** Parse the domain group folder from a skill file path.
 *  e.g. "~/.config/opencode/skills/automation-ai/ai-production/SKILL.md" → "automation-ai"
 *  e.g. "~/.config/opencode/skills/theme-system/SKILL.md"                → undefined (flat)
 */
function parseSkillGroup(path: string): string | undefined {
  const normalizedPath = path.replace(/\\/g, '/');
  const idx = normalizedPath.lastIndexOf('/skills/');
  if (idx === -1) return undefined;
  const relative = normalizedPath.substring(idx + '/skills/'.length);
  const parts = relative.split('/');
  // Grouped layout: <group>/<name>/SKILL.md → parts.length >= 3
  // Flat layout:    <name>/SKILL.md         → parts.length == 2
  return parts.length >= 3 ? parts[0] : undefined;
}

// Raw skill response from API before transformation
interface RawSkillResponse {
  name: string;
  path: string;
  scope?: SkillScope;
  source?: SkillSource;
  sources?: {
    md?: {
      description?: string;
    };
  };
}

export interface SkillConfig {
  name: string;
  description: string;
  instructions?: string;
  scope?: SkillScope;
  source?: SkillSource;
  supportingFiles?: Array<{ path: string; content: string }>;
}

export interface PendingFile {
  path: string;
  content: string;
}

export interface SkillDraft {
  name: string;
  scope: SkillScope;
  source?: SkillSource;
  description: string;
  instructions?: string;
  pendingFiles?: PendingFile[];
}

export interface SkillDetail {
  name: string;
  sources: SkillSources;
  scope?: SkillScope | null;
  source?: SkillSource | null;
}

interface SkillsStore {
  selectedSkillName: string | null;
  skills: DiscoveredSkill[];
  isLoading: boolean;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (name: string | null) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: () => Promise<boolean>;
  getSkillDetail: (name: string) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig) => Promise<boolean>;
  updateSkill: (name: string, config: Partial<SkillConfig>) => Promise<boolean>;
  deleteSkill: (name: string) => Promise<boolean>;
  getSkillByName: (name: string) => DiscoveredSkill | undefined;
  
  // Supporting files
  readSupportingFile: (skillName: string, filePath: string) => Promise<string | null>;
  writeSupportingFile: (skillName: string, filePath: string, content: string) => Promise<boolean>;
  deleteSupportingFile: (skillName: string, filePath: string) => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_skills_store__?: UseBoundStore<StoreApi<SkillsStore>>;
  }
}

const CONFIG_EVENT_SOURCE = "useSkillsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillName: null,
        skills: [],
        isLoading: false,
        skillDraft: null,

        setSelectedSkill: (name: string | null) => {
          set({ selectedSkillName: name });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async () => {
          set({ isLoading: true });
          const previousSkills = get().skills;
          let lastError: unknown = null;

          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const currentDirectory = getCurrentDirectory();
              const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
              
              const response = await fetch(`/api/config/skills${queryParams}`);
              if (!response.ok) {
                throw new Error(`Failed to list skills: ${response.status}`);
              }
              
              const data = await response.json();
              const rawSkills: RawSkillResponse[] = data.skills || [];
              const skills: DiscoveredSkill[] = rawSkills.map((s) => ({
                name: s.name,
                path: s.path,
                scope: s.scope ?? 'user',
                source: s.source ?? 'opencode',
                description: s.sources?.md?.description || '',
                group: parseSkillGroup(s.path),
              }));
              
              set({ skills, isLoading: false });
              return true;
            } catch (error) {
              lastError = error;
              const waitMs = 200 * (attempt + 1);
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }

          console.error("Failed to load skills:", lastError);
          set({ skills: previousSkills, isLoading: false });
          return false;
        },

        getSkillDetail: async (name: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await fetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`);
            if (!response.ok) {
              return null;
            }
            
            return await response.json() as SkillDetail;
          } catch {
            return null;
          }
        },

        createSkill: async (config: SkillConfig) => {
          startConfigUpdate("Creating skill...");
          let requiresReload = false;
          try {
            const skillConfig: Record<string, unknown> = {
              name: config.name,
              description: config.description,
            };

            if (config.instructions) skillConfig.instructions = config.instructions;
            if (config.scope) skillConfig.scope = config.scope;
            if (config.source) skillConfig.source = config.source;
            if (config.supportingFiles) skillConfig.supportingFiles = config.supportingFiles;

            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await fetch(`/api/config/skills/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            if (needsReload) {
              requiresReload = true;
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills();
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        updateSkill: async (name: string, config: Partial<SkillConfig>) => {
          startConfigUpdate("Updating skill...");
          let requiresReload = false;
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;

            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await fetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            if (needsReload) {
              requiresReload = true;
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills();
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        deleteSkill: async (name: string) => {
          startConfigUpdate("Deleting skill...");
          let requiresReload = false;
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await fetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE'
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            if (needsReload) {
              requiresReload = true;
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills();
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }

            if (get().selectedSkillName === name) {
              set({ selectedSkillName: null });
            }

            return loaded;
          } catch {
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        getSkillByName: (name: string) => {
          const { skills } = get();
          return skills.find((s) => s.name === name);
        },

        readSupportingFile: async (skillName: string, filePath: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `&directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await fetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}?${queryParams.slice(1)}`
            );
            if (!response.ok) {
              return null;
            }
            
            const data = await response.json();
            return data.content ?? null;
          } catch {
            return null;
          }
        },

        writeSupportingFile: async (skillName: string, filePath: string, content: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await fetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
              }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skillName: string, filePath: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await fetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              { method: 'DELETE' }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },
      }),
      {
        name: "skills-store",
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          selectedSkillName: state.selectedSkillName,
        }),
      },
    ),
    {
      name: "skills-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_skills_store__ = useSkillsStore;
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

export async function refreshSkillsAfterOpenCodeRestart(options?: { message?: string; delayMs?: number }) {
  try {
    updateConfigUpdateMessage(options?.message || "Refreshing skills…");
  } catch {
    // ignore
  }

  try {
    await waitForOpenCodeConnection(options?.delayMs);
    updateConfigUpdateMessage("Refreshing skills…");
    const skillsStore = useSkillsStore.getState();
    const loaded = await skillsStore.loadSkills();
    if (loaded) {
      emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
    }
  } catch {
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry.");
    await sleep(1500);
  } finally {
    finishConfigUpdate();
  }
}

// Subscribe to config changes from other stores
let unsubscribeSkillsConfigChanges: (() => void) | null = null;

if (!unsubscribeSkillsConfigChanges) {
  unsubscribeSkillsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "skills")) {
      const { loadSkills } = useSkillsStore.getState();
      void loadSkills();
    }
  });
}
