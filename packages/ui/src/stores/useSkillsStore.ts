import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { waitForOpenCodeConnection } from "@/stores/waitForOpenCodeConnection";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { runBackgroundNetworkTask } from "@/lib/background-network";
import { useProjectsStore } from "@/stores/useProjectsStore";

import { opencodeClient } from '@/lib/opencode/client';
import type { IntegrationPolicy } from '@/lib/opencode/projection';
import { filterSkillsByRuntimeFlags } from './skillVisibility';
import {
  applySkillSwitch,
  filterAvailableSkills,
  getSkillSwitchState,
  isSwitchedOffByOwnDeny,
  keepSwitchedOffSkills,
  skillIdFromPath,
} from './skillSwitch';

// Prefer the active project path so Settings/Skills discovery matches the
// project selector (and Commands/Agents). Falling back only to the session
// directory misses repository-local `.agents/skills` when the client directory
// is unset or points elsewhere while an active project exists.
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

    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[SkillsStore] Error resolving config directory:', err);
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

interface SkillSources {
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
    /** The model only loads the skill when asked for it by name. */
    disableModelInvocation?: boolean;
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
  userClaudeMd?: { exists: boolean; path: string | null };
  userAgentsMd?: { exists: boolean; path: string | null };
}

export interface DiscoveredSkill {
  /** OpenCode's id for the skill, which `skill:<id>` policies name; it can differ from `name`. */
  id: string;
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  /** Domain folder parsed from file path, e.g. "automation-ai", "lark-ecosystem" */
  group?: string;
  /** Authoritative server flag: skill lives under a managed root and can be renamed in place. */
  renamable?: boolean;
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
  /** Sent for built-in skills, whose `<built-in>` path does not carry the id. */
  id?: string;
  name: string;
  path: string;
  scope?: SkillScope;
  source?: SkillSource;
  renamable?: boolean;
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
  targetPath?: string;
  supportingFiles?: Array<{ path: string; content: string }>;
  disableModelInvocation?: boolean;
}

export interface PendingFile {
  path: string;
  content: string;
}

interface SkillDraft {
  name: string;
  scope: SkillScope;
  source?: SkillSource;
  description: string;
  instructions?: string;
  pendingFiles?: PendingFile[];
}

interface SkillDetail {
  name: string;
  sources: SkillSources;
  scope?: SkillScope | null;
  source?: SkillSource | null;
}

interface SkillsStore {
  selectedSkillName: string | null;
  /** Skills of the project the app is on. Chat and autocompletes read this one. */
  skills: DiscoveredSkill[];
  /** Every directory loaded so far, including the ambient one. Holds switched-off skills too. */
  skillsByDirectory: Record<string, DiscoveredSkill[]>;
  /**
   * The `integration.use` statements OpenCode applies per directory, which
   * decide the skills agents can use (`skillSwitch.ts`). A failed read keeps
   * the last ones known; a directory never read has no entry.
   */
  policiesByDirectory: Record<string, IntegrationPolicy[]>;
  isLoading: boolean;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (name: string | null) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: (directory?: string | null) => Promise<boolean>;
  /**
   * Turns a skill off or back on for agents. Nothing changes before the server
   * answers; false when the write failed.
   */
  setSkillEnabled: (skill: DiscoveredSkill, enabled: boolean, directory?: string | null) => Promise<boolean>;
  getSkillDetail: (name: string, directory?: string | null) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig, directory?: string | null) => Promise<boolean>;
  updateSkill: (name: string, config: Partial<SkillConfig>, directory?: string | null) => Promise<boolean>;
  renameSkill: (name: string, newName: string, directory?: string | null) => Promise<boolean>;
  /** `location` deletes only the copy in that scope and source; without it every copy of the name goes. */
  deleteSkill: (name: string, directory?: string | null, location?: { scope: SkillScope; source: SkillSource }) => Promise<boolean>;
  getSkillByName: (name: string, directory?: string | null) => DiscoveredSkill | undefined;
  /**
   * Skills are discovered on the connected instance and cached by directory,
   * which two instances can share — so a switch must drop the caches rather
   * than report the previous instance's skills for the new one.
   */
  resetForRuntimeSwitch: () => void;

  // Supporting files
  readSupportingFile: (skillName: string, filePath: string, directory?: string | null) => Promise<string | null>;
  writeSupportingFile: (skillName: string, filePath: string, content: string, directory?: string | null) => Promise<boolean>;
  deleteSupportingFile: (skillName: string, filePath: string, directory?: string | null) => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_skills_store__?: UseBoundStore<StoreApi<SkillsStore>>;
  }
}

const CONFIG_EVENT_SOURCE = "useSkillsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SKILLS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_SKILLS_CACHE_KEY = '__default__';
const skillsLastLoadedAt = new Map<string, number>();
const skillsLoadInFlight = new Map<string, Promise<boolean>>();
// Bumped on every runtime switch. Skills are discovered on the connected
// instance and cached by directory, which two instances can share, so a load
// already in flight for the previous instance must not write into the new one.
let skillsGeneration = 0;
// Switch writes per directory. A policy read started before the latest write
// can answer with OpenCode's old config, so it is not committed.
const skillSwitchWrites = new Map<string, number>();
// OpenCode applies a config file change once its watcher reports it.
const SKILL_SWITCH_RECHECK_MS = [300, 1000, 2000];
const EMPTY_POLICIES: IntegrationPolicy[] = [];

/**
 * Merge a partial list (OpenCode's own skill list failed, only the disk scan
 * came back) with what was known before. Previously known skills the disk scan
 * cannot vouch for — built-ins and anything OpenCode found through its config —
 * are kept instead of vanishing on one failed fetch. Managed-root skills
 * (`renamable`) are covered by the disk scan, so their absence is real.
 */
const mergePartialSkills = (
  partial: DiscoveredSkill[],
  previous: DiscoveredSkill[],
): DiscoveredSkill[] => {
  const partialNames = new Set(partial.map((skill) => skill.name));
  const carried = previous.filter((skill) => !partialNames.has(skill.name) && skill.renamable !== true);
  return carried.length > 0 ? [...partial, ...carried] : partial;
};

/** A switched-off skill nothing else describes: only its id is known, and nothing about it is editable. */
const switchedOffSkillFromId = (id: string): DiscoveredSkill => ({
  id,
  name: id,
  path: '<built-in>',
  scope: 'user',
  source: 'opencode',
  description: '',
});

const getSkillsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_SKILLS_CACHE_KEY;
};

export const invalidateSkillsLoadCache = (directory: string | null = getRequestDirectory()) => {
  skillsLastLoadedAt.delete(getSkillsCacheKey(directory));
};

const upsertSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  get: () => SkillsStore,
  name: string,
  config: Partial<SkillConfig>,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  const isAmbient = cacheKey === getSkillsCacheKey(getRequestDirectory());
  const current = get().skillsByDirectory[cacheKey] ?? [];
  const existing = current.find((skill) => skill.name === name);
  const path = config.targetPath ?? existing?.path ?? '';
  const nextSkill: DiscoveredSkill = {
    ...existing,
    id: skillIdFromPath(path, name),
    name,
    path,
    scope: config.scope ?? existing?.scope ?? 'user',
    source: config.source ?? existing?.source ?? 'opencode',
    description: config.description ?? existing?.description ?? '',
    group: parseSkillGroup(path),
  };
  const nextSkills = current.some((skill) => skill.name === name)
    ? current.map((skill) => (skill.name === name ? nextSkill : skill))
    : [...current, nextSkill];
  set((state) => {
    const next: Partial<SkillsStore> = {
      skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: nextSkills },
    };
    if (isAmbient) next.skills = nextSkills;
    return next;
  });
};

const removeSkillLocal = (
  set: (state: Partial<SkillsStore>) => void,
  get: () => SkillsStore,
  name: string,
) => {
  const nextState: Partial<SkillsStore> = {
    skills: get().skills.filter((skill) => skill.name !== name),
  };
  if (get().selectedSkillName === name) {
    nextState.selectedSkillName = null;
  }
  set(nextState);
};

const EMPTY_SKILLS: DiscoveredSkill[] = [];

/**
 * Skills of one project. Returns a stored array so components can select it
 * directly; an omitted directory means the project the app is on.
 */
export const selectSkillsForDirectory = (
  state: Pick<SkillsStore, 'skillsByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
};

/**
 * Whether one project's skills have been read; until then its empty list is
 * not an answer. A failed read settles it to the skills known before.
 */
export const selectSkillsLoadedForDirectory = (
  state: Pick<SkillsStore, 'skillsByDirectory'>,
  directory?: string | null,
): boolean => Object.hasOwn(state.skillsByDirectory, getSkillsCacheKey(resolveDirectory(directory)));

/**
 * The policy statements of one project, or null while none could be read; an
 * omitted directory means the project the app is on.
 */
export const selectSkillPoliciesForDirectory = (
  state: Pick<SkillsStore, 'policiesByDirectory'>,
  directory?: string | null,
): IntegrationPolicy[] | null => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.policiesByDirectory[cacheKey] ?? null;
};

const availableSkillsCache = new WeakMap<DiscoveredSkill[], { policies: IntegrationPolicy[] | null; available: DiscoveredSkill[] }>();

/**
 * The skills of one project agents can use: everything the chat offers or
 * attaches reads this, while Settings lists every installed skill. The result
 * is kept per input, so a selector returns the same array until either changes.
 */
export const selectAvailableSkillsForDirectory = (
  state: Pick<SkillsStore, 'skillsByDirectory' | 'policiesByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const skills = selectSkillsForDirectory(state, directory);
  const policies = selectSkillPoliciesForDirectory(state, directory);
  const cached = availableSkillsCache.get(skills);
  if (cached?.policies === policies) return cached.available;
  const available = filterAvailableSkills(skills, policies);
  availableSkillsCache.set(skills, { policies, available });
  return available;
};

/** The skill of that name when its own exact deny switches it off, else null. */
const switchedOffSkillNamed = (
  state: Pick<SkillsStore, 'skillsByDirectory' | 'policiesByDirectory'>,
  name: string,
  directory: string | null,
): DiscoveredSkill | null => {
  const skill = selectSkillsForDirectory(state, directory).find((entry) => entry.name === name);
  if (!skill) return null;
  return isSwitchedOffByOwnDeny(state.policiesByDirectory[getSkillsCacheKey(directory)] ?? null, skill.id) ? skill : null;
};

/**
 * Drops the row a load kept for a switched-off id (`keepSwitchedOffSkills`)
 * once its rule is gone, so a renamed or deleted skill leaves no row behind.
 */
const dropSkillRow = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  directory: string | null,
  id: string,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  set((state) => {
    const skills = state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
    const kept = skills.filter((skill) => skill.id !== id);
    if (kept.length === skills.length) return {};
    const next: Partial<SkillsStore> = { skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: kept } };
    if (cacheKey === getSkillsCacheKey(getRequestDirectory())) next.skills = kept;
    return next;
  });
};

/** Writes one skill's switch through the server; answers the config files it changed. */
const writeSkillSwitch = async (
  skill: Pick<DiscoveredSkill, 'id' | 'scope'>,
  enabled: boolean,
  directory: string | null,
): Promise<string[]> => {
  const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skill-switch${queryParams}`, {
    method: 'PUT',
    // A plain object, so runtimeFetch can URI-encode a non-Latin-1 directory; Headers.set would throw.
    headers: directory
      ? { 'Content-Type': 'application/json', 'x-opencode-directory': directory }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: skill.id, enabled, scope: skill.scope }),
  });
  const payload: { changed?: string[]; error?: string } | null = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to switch skill');
  }
  return payload?.changed ?? [];
};

/**
 * Reads OpenCode's statements again after a switch write until they show it,
 * then commits them. The last read is committed either way: OpenCode's view is
 * the authority, and a rule elsewhere may keep the skill as it was.
 */
const recheckSkillPolicies = async (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  directory: string | null,
  id: string,
  enabled: boolean,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  const write = skillSwitchWrites.get(cacheKey);
  const generation = skillsGeneration;
  const isCurrent = () => generation === skillsGeneration && skillSwitchWrites.get(cacheKey) === write;
  for (const [attempt, delay] of SKILL_SWITCH_RECHECK_MS.entries()) {
    await sleep(delay);
    if (!isCurrent()) return;
    let policies: IntegrationPolicy[];
    try {
      policies = await opencodeClient.getIntegrationPolicies(directory);
    } catch {
      continue;
    }
    if (!isCurrent()) return;
    const hasDeny = policies.some((policy) => policy.resource === `skill:${id}` && policy.effect === 'deny');
    if (hasDeny === enabled && attempt < SKILL_SWITCH_RECHECK_MS.length - 1) continue;
    set((state) => ({ policiesByDirectory: { ...state.policiesByDirectory, [cacheKey]: policies } }));
    emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
    return;
  }
};

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillName: null,
        skills: [],
        skillsByDirectory: {},
        policiesByDirectory: {},
        isLoading: false,
        skillDraft: null,

        resetForRuntimeSwitch: () => {
          skillsGeneration += 1;
          skillsLastLoadedAt.clear();
          skillsLoadInFlight.clear();
          set({ skills: [], skillsByDirectory: {}, policiesByDirectory: {}, isLoading: false });
        },

        setSelectedSkill: (name: string | null) => {
          set({ selectedSkillName: name });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async (requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const isAmbient = cacheKey === getSkillsCacheKey(getRequestDirectory());
          const now = Date.now();
          const loadedAt = skillsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedSkills = (get().skillsByDirectory[cacheKey] ?? (isAmbient ? get().skills : [])).length > 0;

          if (hasCachedSkills && now - loadedAt < SKILLS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = skillsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const generation = skillsGeneration;
          const request = (async () => {
            set({ isLoading: true });
            // Failure must never look like an empty project. The mirror is the
            // fallback so a directory loaded before this map existed still counts.
            const previousSkills = get().skillsByDirectory[cacheKey] ?? (isAmbient ? get().skills : []);
            let lastError: unknown = null;

            // The statements that decide which skills agents get, read beside
            // the list. A failed read keeps the last ones known: it must not
            // turn every skill back on.
            const switchWrite = skillSwitchWrites.get(cacheKey);
            const policiesRequest = (async () => {
              try {
                return await opencodeClient.getIntegrationPolicies(directory);
              } catch (error) {
                console.warn('[SkillsStore] could not read OpenCode skill policies:', error instanceof Error ? error.message : String(error));
                return null;
              }
            })();

            for (let attempt = 0; attempt < 3; attempt++) {
              if (generation !== skillsGeneration) return false;
              try {
                const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

                const response = await runBackgroundNetworkTask(() => runtimeFetch(`/api/config/skills${queryParams}`, {
                  priority: 'low',
                  headers: directory ? { 'x-opencode-directory': directory } : undefined,
                }));
                if (response === undefined) return false;
                if (!response.ok) {
                  throw new Error(`Failed to list skills: ${response.status}`);
                }

                const data = await response.json();
                const rawSkills: RawSkillResponse[] = data.skills || [];
                const configSkills: DiscoveredSkill[] = rawSkills.map((s) => ({
                  id: s.id ?? skillIdFromPath(s.path, s.name),
                  name: s.name,
                  path: s.path,
                  scope: s.scope ?? 'user',
                  source: s.source ?? 'opencode',
                  description: s.sources?.md?.description || '',
                  group: parseSkillGroup(s.path),
                  renamable: s.renamable === true,
                }));

                // OpenCode loads a narrower set than this scan finds, and the
                // rules live in server-side env flags the browser cannot read.
                // The route reports them; `filterSkillsByRuntimeFlags` mirrors
                // OpenCode's discovery, including the `.agents`-wins dedup that
                // matters when `.claude/skills` are symlinks back into it.
                //
                // Deliberately not OpenCode's own skill endpoint: measured
                // against 1.18.14 it lists only global and builtin skills and
                // omits the project skills the agent actually has.
                const scannedSkills = filterSkillsByRuntimeFlags(
                  configSkills,
                  data.externalSkills ?? null,
                );
                // The server answers with only its disk scan when OpenCode's
                // own list could not be read. That is not a complete list:
                // keep what was known and retry on the next load.
                const isPartial = data.openCodeSkillsUnavailable === true;
                const visibleSkills = isPartial
                  ? mergePartialSkills(scannedSkills, previousSkills)
                  : scannedSkills;

                const policies = await policiesRequest;
                if (generation !== skillsGeneration) return false;
                set((state) => {
                  const freshPolicies = policies && skillSwitchWrites.get(cacheKey) === switchWrite ? policies : null;
                  const directorySkills = keepSwitchedOffSkills(
                    visibleSkills,
                    previousSkills,
                    freshPolicies ?? state.policiesByDirectory[cacheKey] ?? EMPTY_POLICIES,
                    switchedOffSkillFromId,
                  );
                  const next: Partial<SkillsStore> = {
                    skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: directorySkills },
                    isLoading: false,
                  };
                  if (freshPolicies) {
                    next.policiesByDirectory = { ...state.policiesByDirectory, [cacheKey]: freshPolicies };
                  }
                  if (isAmbient) next.skills = directorySkills;
                  return next;
                });
                // Unread statements are not a complete answer either.
                if (isPartial || !policies) {
                  skillsLastLoadedAt.delete(cacheKey);
                } else {
                  skillsLastLoadedAt.set(cacheKey, Date.now());
                }
                return true;
              } catch (error) {
                lastError = error;
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
            }

            console.error("Failed to load skills:", lastError);
            if (generation !== skillsGeneration) return false;
            set((state) => {
              const next: Partial<SkillsStore> = {
                skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: previousSkills },
                isLoading: false,
              };
              if (isAmbient) next.skills = previousSkills;
              return next;
            });
            return false;
          })();

          skillsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            skillsLoadInFlight.delete(cacheKey);
          }
        },

        setSkillEnabled: async (skill: DiscoveredSkill, enabled: boolean, requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const generation = skillsGeneration;
          let changed: string[];
          try {
            changed = await writeSkillSwitch(skill, enabled, directory);
          } catch (error) {
            console.error('Failed to switch skill:', error);
            return false;
          }
          if (generation !== skillsGeneration) return false;
          // Nothing written while the outcome should change: the rule lives
          // where the server cannot edit it (a file it cannot parse, config
          // with no file), so the switch did nothing.
          const current = get().policiesByDirectory[cacheKey] ?? null;
          if (changed.length === 0 && current && getSkillSwitchState(current, skill.id).enabled !== enabled) {
            return false;
          }

          // OpenCode applies the files once its watcher sees them. Show the
          // write now in every directory that reads the changed files: a user
          // skill's rule is in the global config, which every project reads.
          // The recheck confirms it here; other directories read again on
          // their next load.
          const affected = skill.scope === 'project'
            ? [cacheKey]
            : Object.keys(get().policiesByDirectory).concat(cacheKey);
          for (const key of new Set(affected)) {
            skillSwitchWrites.set(key, (skillSwitchWrites.get(key) ?? 0) + 1);
            skillsLastLoadedAt.delete(key);
          }
          set((state) => {
            const policiesByDirectory = { ...state.policiesByDirectory };
            for (const key of new Set(affected)) {
              const policies = state.policiesByDirectory[key];
              if (policies || key === cacheKey) {
                policiesByDirectory[key] = applySkillSwitch(policies ?? EMPTY_POLICIES, skill.id, enabled, changed);
              }
            }
            return { policiesByDirectory };
          });
          void recheckSkillPolicies(set, directory, skill.id, enabled);
          return true;
        },

        getSkillDetail: async (name: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });
            if (!response.ok) {
              return null;
            }
            
            return await response.json() as SkillDetail;
          } catch {
            return null;
          }
        },

        createSkill: async (config: SkillConfig, requestedDirectory?: string | null) => {
          try {
            const skillConfig: Record<string, unknown> = {
              name: config.name,
              description: config.description,
            };

            if (config.instructions) skillConfig.instructions = config.instructions;
            if (config.scope) skillConfig.scope = config.scope;
            if (config.source) skillConfig.source = config.source;
            if (config.supportingFiles) skillConfig.supportingFiles = config.supportingFiles;
            if (config.disableModelInvocation) skillConfig.disableModelInvocation = true;

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertSkillLocal(set, get, config.name, config, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Creating skill...");
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        updateSkill: async (name: string, config: Partial<SkillConfig>, requestedDirectory?: string | null) => {
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;
            if (config.targetPath !== undefined) skillConfig.targetPath = config.targetPath;
            if (config.disableModelInvocation !== undefined) skillConfig.disableModelInvocation = config.disableModelInvocation;

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertSkillLocal(set, get, name, config, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Updating skill...");
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        renameSkill: async (name: string, newName: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            const switchedOff = switchedOffSkillNamed(get(), name, directory);

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify({ renameTo: newName }),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to rename skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            invalidateSkillsLoadCache(directory);
            if (needsReload) {
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            // The folder, and so the id, takes the new name. The rule follows
            // it, or the skill would come back on under its new id.
            if (switchedOff) {
              await get().setSkillEnabled({ ...switchedOff, id: newName, name: newName }, false, directory);
              await get().setSkillEnabled(switchedOff, true, directory);
              dropSkillRow(set, directory, switchedOff.id);
            }
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        deleteSkill: async (name: string, requestedDirectory?: string | null, location?: { scope: SkillScope; source: SkillSource }) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const params = new URLSearchParams();
            if (directory) params.set('directory', directory);
            if (location) {
              params.set('scope', location.scope);
              params.set('source', location.source);
            }
            const query = params.toString();
            const queryParams = query ? `?${query}` : '';
            // Deleting every copy leaves the skill's own rule with nothing to
            // switch; deleting one copy keeps it for the copies left.
            const switchedOff = location ? null : switchedOffSkillNamed(get(), name, directory);

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              removeSkillLocal(set, get, name);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Deleting skill...");
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (switchedOff) {
              await get().setSkillEnabled(switchedOff, true, directory);
              dropSkillRow(set, directory, switchedOff.id);
            }
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }

            if (get().selectedSkillName === name) {
              set({ selectedSkillName: null });
            }

            return loaded;
          } catch {
            return false;
          }
        },

        getSkillByName: (name: string, requestedDirectory?: string | null) => {
          return selectSkillsForDirectory(get(), requestedDirectory).find((skill) => skill.name === name);
        },

        readSupportingFile: async (skillName: string, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `&directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}?${queryParams.slice(1)}`,
              { headers: directory ? { 'x-opencode-directory': directory } : undefined },
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

        writeSupportingFile: async (skillName: string, filePath: string, content: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  ...(directory ? { 'x-opencode-directory': directory } : {}),
                },
                body: JSON.stringify({ content })
              }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skillName: string, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'DELETE',
                headers: directory ? { 'x-opencode-directory': directory } : undefined,
              }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },
      }),
      {
        name: "skills-store",
        storage: createDeferredSafeJSONStorage(),
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
    invalidateSkillsLoadCache();
    const loaded = await skillsStore.loadSkills();
    if (loaded) {
      emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
    }
  } catch (error) {
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry.");
    await sleep(1500);
    throw error;
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
