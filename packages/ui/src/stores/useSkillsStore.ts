import { create } from "zustand";
import { z } from "zod";
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
import { runtimeFetch, type RuntimeFetchOptions } from "@/lib/runtime-fetch";
import { runBackgroundNetworkTask } from "@/lib/background-network";
import { useProjectsStore } from "@/stores/useProjectsStore";

import { opencodeClient, type SkillAttachmentRef } from '@/lib/opencode/client';
import { buildSkillMentionInstruction, parseSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { normalizePath } from '@/lib/pathNormalization';
import type { QueuedContextPart } from './messageQueueStore';
import { filterSkillsByRuntimeFlags } from './skillVisibility';
import {
  filterAvailableSkills,
  isSkillSwitchedOff,
  parseSkillPolicyRead,
  parseSkillPolicyWrite,
  type SkillPolicyRead,
  type SkillPolicyScope,
  type SkillPolicyState,
  type SkillPolicyWriteResult,
} from './skillAvailability';

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
  /**
   * OpenCode's skill id: the folder of `SKILL.md`, which the frontmatter
   * `name` can differ from. Unique within one directory's list, so it is the
   * key for selection, local updates and mutations; `name` is only a label.
   */
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

/**
 * OpenCode's id for a skill file, the way the server derives it
 * (`skillIdFromPath`): the folder of a `SKILL.md`, or a loose `<id>.md`.
 */
const skillIdFromPath = (path: string): string | null => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? '';
  if (file === 'SKILL.md') return parts.at(-2) ?? null;
  if (file.endsWith('.md')) return file.slice(0, -3) || null;
  return null;
};

// Raw skill response from API before transformation
interface RawSkillResponse {
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

/** The fields that name one installed skill to the server. */
type SkillTarget = Pick<DiscoveredSkill, 'id' | 'name'>;
/** A skill target with the file it was listed at. */
type SkillRef = SkillTarget & Pick<DiscoveredSkill, 'path'>;
/** One skill folder location: a scope and the tool convention it follows. */
type SkillLocation = { scope: SkillScope; source: SkillSource };

const renameAnswerSchema = z.object({
  id: z.string().min(1).optional(),
  switches: z.object({
    oldRuleCleanupFailed: z.array(z.object({ scope: z.enum(['global', 'project']), path: z.string() })),
  }).nullable().optional(),
});

/**
 * What a rename did. `ok` follows the server's answer alone: a list that
 * fails to reload afterwards does not make a done rename look failed.
 * `oldRuleCleanupFailed` names the config files that still hold the switch
 * rule for the old id after the skill moved: the rename and the carried rule
 * for the new id are in place, only that leftover could not be removed.
 */
export type SkillRenameResult =
  | { ok: true; id: string; oldRuleCleanupFailed: Array<{ scope: SkillPolicyScope; path: string }> }
  | { ok: false };

/** The policy state Settings shows for one directory. */
export interface SkillPolicyView {
  /** The latest state read, or the last one known when the latest read failed; null before any. */
  state: SkillPolicyState | null;
  /** Why the latest read failed; null when it succeeded. */
  error: string | null;
}

type DecidedSkillState = 'enabled' | 'disabled';

/** A switch write for one skill in one directory, from the click until the next policy read. */
type SkillSwitchStatus =
  | { phase: 'pending'; scope: SkillPolicyScope }
  /** Saved in the file, but OpenCode had not applied it when the write answered. */
  | { phase: 'unconfirmed'; scope: SkillPolicyScope }
  | { phase: 'failed'; scope: SkillPolicyScope; message: string };

interface SkillsStore {
  /** Id of the skill Settings shows, or the name of an unsaved draft. */
  selectedSkillId: string | null;
  /** Installed skills of the project the app is on. */
  skills: DiscoveredSkill[];
  /** Installed skills of every directory loaded so far, including the ambient one. Settings reads this. */
  skillsByDirectory: Record<string, DiscoveredSkill[]>;
  /** The ambient directory's skills agents can use: chat and autocompletes read this one. */
  availableSkills: DiscoveredSkill[];
  /** Per directory, the installed skills minus the ones a policy switches off. */
  availableSkillsByDirectory: Record<string, DiscoveredSkill[]>;
  policyByDirectory: Record<string, SkillPolicyView>;
  /**
   * Per directory and skill id, the last `enabled` or `disabled` a policy read
   * or switch reported, kept through later `unknown` answers. Only queued
   * delivery reads it, so a skill last seen off stays out of a queued
   * instruction; Settings and the composer show the latest state as it is.
   */
  lastDecidedByDirectory: Record<string, ReadonlyMap<string, DecidedSkillState>>;
  /** Keyed by `skillSwitchKey(directory, id)`. */
  switchStatus: Record<string, SkillSwitchStatus>;
  isLoading: boolean;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (id: string | null) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: (directory?: string | null) => Promise<boolean>;
  /**
   * Switches a skill on or off in one scope's config file. One write per skill
   * and directory at a time; a second call while one runs answers `pending`.
   * The policy the server answers replaces the shown one, failed or not saved
   * alike: nothing is assumed before the answer.
   */
  setSkillEnabled: (
    id: string,
    scope: SkillPolicyScope,
    enabled: boolean,
    directory?: string | null,
  ) => Promise<SkillPolicyWriteResult>;
  /** Null when the read failed or the server answered for another file. */
  getSkillDetail: (skill: SkillRef, directory?: string | null) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig, directory?: string | null) => Promise<boolean>;
  updateSkill: (skill: SkillRef, config: Partial<SkillConfig>, directory?: string | null) => Promise<boolean>;
  renameSkill: (skill: SkillTarget, newName: string, directory?: string | null) => Promise<SkillRenameResult>;
  /**
   * Without `location` the server deletes exactly the listed skill with this
   * id. With it, only the folder named by the id in that scope and source,
   * whichever copy OpenCode lists first.
   */
  deleteSkill: (skill: SkillTarget, directory?: string | null, location?: SkillLocation) => Promise<boolean>;
  getSkillById: (id: string, directory?: string | null) => DiscoveredSkill | undefined;
  /**
   * Skills are discovered on the connected instance and cached by directory,
   * which two instances can share — so a switch must drop the caches rather
   * than report the previous instance's skills for the new one.
   */
  resetForRuntimeSwitch: () => void;

  // Supporting files
  readSupportingFile: (skill: SkillTarget, filePath: string, directory?: string | null) => Promise<string | null>;
  writeSupportingFile: (skill: SkillTarget, filePath: string, content: string, directory?: string | null) => Promise<boolean>;
  deleteSupportingFile: (skill: SkillTarget, filePath: string, directory?: string | null) => Promise<boolean>;
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
// Bumped per directory whenever its skills or policies may have changed: a
// write from here, or an event announcing one. A read that started before the
// bump can answer with the old state, so it is not committed; the load reads
// again instead.
const skillsRevision = new Map<string, number>();
const LOAD_RESTARTS = 3;
// Switch writes running, by `skillSwitchKey`.
const skillSwitchesInFlight = new Set<string>();

const revisionOf = (cacheKey: string): number => skillsRevision.get(cacheKey) ?? 0;

const markSkillsChanged = (cacheKey: string): void => {
  skillsRevision.set(cacheKey, revisionOf(cacheKey) + 1);
  skillsLastLoadedAt.delete(cacheKey);
};

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
  const partialIds = new Set(partial.map((skill) => skill.id));
  const carried = previous.filter((skill) => !partialIds.has(skill.id) && skill.renamable !== true);
  return carried.length > 0 ? [...partial, ...carried] : partial;
};

const toDiscoveredSkill = (raw: RawSkillResponse): DiscoveredSkill => ({
  // The server sends the id; an entry without one gets the id OpenCode would
  // derive from its path, and only a path without one falls back to the name.
  id: raw.id || skillIdFromPath(raw.path) || raw.name,
  name: raw.name,
  path: raw.path,
  scope: raw.scope ?? 'user',
  source: raw.source ?? 'opencode',
  description: raw.sources?.md?.description || '',
  group: parseSkillGroup(raw.path),
  renamable: raw.renamable === true,
});

/**
 * A route under `/api/config/skills/:name`. The path keeps the display name
 * older servers read; the `id` query selects the skill, and a server given an
 * id matches it exactly, never by name, so two ids sharing a name stay apart.
 */
const skillRoute = (skill: SkillTarget, subPath = ''): string => (
  `/api/config/skills/${encodeURIComponent(skill.name)}${subPath}`
);

const directoryHeaders = (directory: string | null, hasBody: boolean): Headers => {
  const headers = new Headers();
  if (hasBody) headers.set('Content-Type', 'application/json');
  if (directory) headers.set('x-opencode-directory', directory);
  return headers;
};

const skillRouteInit = (
  skill: SkillTarget,
  directory: string | null,
  init: RequestInit = {},
  location?: SkillLocation,
): RuntimeFetchOptions => ({
  ...init,
  query: { id: skill.id, directory, ...location },
  headers: directoryHeaders(directory, Boolean(init.body)),
});

const supportingFilePath = (filePath: string): string => `/files/${encodeURIComponent(filePath)}`;

const BUILT_IN_SKILL_LOCATION = '<built-in>';

const normalizeSkillPath = (path: string): string => path.replace(/\\/g, '/');

/** Whether a detail answer describes the file `skill` points at. */
const isDetailFor = (skill: SkillRef, detail: SkillDetail): boolean => {
  const detailPath = detail.sources.md.path;
  if (skill.path === BUILT_IN_SKILL_LOCATION) return detailPath === null;
  return detailPath !== null && normalizeSkillPath(detailPath) === normalizeSkillPath(skill.path);
};

const getSkillsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_SKILLS_CACHE_KEY;
};

const ambientCacheKey = (): string => getSkillsCacheKey(getRequestDirectory());

/** The `switchStatus` key of one skill in one directory. */
export const skillSwitchKey = (directory: string | null | undefined, id: string): string => (
  `${getSkillsCacheKey(resolveDirectory(directory))}\n${id}`
);

/**
 * Marks a directory's skills as possibly changed: the next load reads again,
 * and a load already running reads again before it commits, so an answer
 * started before the change cannot land.
 */
export const invalidateSkillsLoadCache = (directory: string | null = getRequestDirectory()) => {
  markSkillsChanged(getSkillsCacheKey(directory));
};

/**
 * Marks every directory read so far as possibly changed, without reading any:
 * a global config file applies to all of them, and each re-reads when it is
 * next shown. Returns the directories that hold a list.
 */
export const invalidateAllSkillsLoads = (): string[] => {
  const keys = Object.keys(useSkillsStore.getState().skillsByDirectory);
  for (const key of keys) markSkillsChanged(key);
  markSkillsChanged(ambientCacheKey());
  return keys.filter((key) => key !== DEFAULT_SKILLS_CACHE_KEY);
};

/** `lastDecided` updated with the `enabled` and `disabled` states of `policy`; null when that changes nothing. */
const withDecided = (
  lastDecided: ReadonlyMap<string, DecidedSkillState> | undefined,
  policy: SkillPolicyState | null,
): ReadonlyMap<string, DecidedSkillState> | null => {
  const changes: Array<[string, DecidedSkillState]> = [];
  for (const [id, { effective }] of policy?.skills ?? []) {
    if (effective !== 'unknown' && lastDecided?.get(id) !== effective) changes.push([id, effective]);
  }
  return changes.length > 0 ? new Map([...(lastDecided ?? []), ...changes]) : null;
};

/**
 * One directory's lists after a change to its inventory or policy, with the
 * available list derived from both and the ambient mirrors following when the
 * directory is the one the app is on now.
 */
const commitDirectory = (
  state: SkillsStore,
  cacheKey: string,
  patch: { skills?: DiscoveredSkill[]; policy?: SkillPolicyView },
): Partial<SkillsStore> => {
  const skills = patch.skills ?? state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
  const policy = patch.policy ?? state.policyByDirectory[cacheKey] ?? null;
  const available = filterAvailableSkills(skills, policy?.state ?? null);
  const next: Partial<SkillsStore> = {
    skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: skills },
    availableSkillsByDirectory: { ...state.availableSkillsByDirectory, [cacheKey]: available },
  };
  if (patch.policy) {
    next.policyByDirectory = { ...state.policyByDirectory, [cacheKey]: patch.policy };
    const lastDecided = withDecided(state.lastDecidedByDirectory[cacheKey], patch.policy.state);
    if (lastDecided) next.lastDecidedByDirectory = { ...state.lastDecidedByDirectory, [cacheKey]: lastDecided };
  }
  if (cacheKey === ambientCacheKey()) {
    next.skills = skills;
    next.availableSkills = available;
  }
  return next;
};

/** Drops the `unconfirmed` notes of a directory once a fresh policy read replaced them. */
const withoutUnconfirmed = (statuses: Record<string, SkillSwitchStatus>, cacheKey: string): Record<string, SkillSwitchStatus> => {
  const prefix = `${cacheKey}\n`;
  const entries = Object.entries(statuses);
  const kept = entries.filter(([key, status]) => !(key.startsWith(prefix) && status.phase === 'unconfirmed'));
  return kept.length === entries.length ? statuses : Object.fromEntries(kept);
};

/** A new skill's folder, and so its id, is the name it is created with. */
const upsertSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  skill: Pick<DiscoveredSkill, 'id' | 'name'> & { path?: string },
  config: Partial<SkillConfig>,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  set((state) => {
    const current = state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
    const existing = current.find((entry) => entry.id === skill.id);
    const path = skill.path ?? existing?.path ?? '';
    const nextSkill: DiscoveredSkill = {
      ...existing,
      id: skill.id,
      name: skill.name,
      path,
      scope: config.scope ?? existing?.scope ?? 'user',
      source: config.source ?? existing?.source ?? 'opencode',
      description: config.description ?? existing?.description ?? '',
      group: parseSkillGroup(path),
    };
    const nextSkills = existing
      ? current.map((entry) => (entry.id === skill.id ? nextSkill : entry))
      : [...current, nextSkill];
    return commitDirectory(state, cacheKey, { skills: nextSkills });
  });
};

const removeSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  id: string,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  set((state) => {
    const nextSkills = (state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS).filter((skill) => skill.id !== id);
    const next = commitDirectory(state, cacheKey, { skills: nextSkills });
    if (state.selectedSkillId === id) next.selectedSkillId = null;
    return next;
  });
};

const EMPTY_SKILLS: DiscoveredSkill[] = [];

/**
 * Installed skills of one project, switched off or not: what Settings lists.
 * Returns a stored array so components can select it directly; an omitted
 * directory means the project the app is on.
 */
export const selectSkillsForDirectory = (
  state: Pick<SkillsStore, 'skillsByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
};

/** Skills of one project agents can use: what the composer offers and sends. */
export const selectAvailableSkillsForDirectory = (
  state: Pick<SkillsStore, 'availableSkillsByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.availableSkillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
};

export const selectSkillPolicyForDirectory = (
  state: Pick<SkillsStore, 'policyByDirectory'>,
  directory?: string | null,
): SkillPolicyView | null => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.policyByDirectory[cacheKey] ?? null;
};

/**
 * The instruction that names skills a prompt could not attach. A skill the
 * directory's policy switches off is never named: the model would be told to
 * use a skill OpenCode refuses to load.
 */
export const skillFallbackInstruction = (directory: string | null | undefined) => (
  skills: readonly SkillAttachmentRef[],
): string | null => {
  const policy = selectSkillPolicyForDirectory(useSkillsStore.getState(), directory)?.state ?? null;
  return buildSkillMentionInstruction(
    skills.filter((skill) => !isSkillSwitchedOff(policy, skill.id)).map((skill) => skill.name),
  );
};

/**
 * A directory's stored lists, found also when the caller spells the directory
 * the way the message queue does (`normalizePath`) and the store was loaded
 * with another spelling of the same path.
 */
const findDirectoryKey = (state: SkillsStore, directory: string | null | undefined): string => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  if (state.skillsByDirectory[cacheKey] || state.policyByDirectory[cacheKey] || !directory) return cacheKey;
  const wanted = normalizePath(directory);
  return Object.keys(state.skillsByDirectory).find((key) => normalizePath(key) === wanted) ?? cacheKey;
};

/**
 * A queued message's captured context, checked again when it is delivered:
 * its skill instruction leaves out skills switched off in the directory, and
 * goes when it names none left. A skill is off when the latest policy read
 * says so, or says `unknown` and the last `enabled` or `disabled` before it
 * was `disabled` (the server queue's rule). A token from an instruction
 * queued without ids is dropped only when every installed skill it names by
 * name or id is off. Everything else, and an instruction this check cannot
 * read, is delivered as captured. The message text itself is never changed.
 */
export const withoutSwitchedOffQueuedSkills = (
  context: readonly QueuedContextPart[],
  directory: string | null | undefined,
): QueuedContextPart[] => {
  const state = useSkillsStore.getState();
  const cacheKey = findDirectoryKey(state, directory);
  const policy = state.policyByDirectory[cacheKey]?.state ?? null;
  const lastDecided = state.lastDecidedByDirectory[cacheKey];
  if (!policy && !lastDecided) return [...context];
  const installed = state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
  const isOff = (id: string): boolean => {
    const effective = policy?.skills.get(id)?.effective;
    return (effective === 'enabled' || effective === 'disabled' ? effective : lastDecided?.get(id)) === 'disabled';
  };
  const tokenIsOff = (token: string): boolean => {
    const candidates = installed.filter((skill) => skill.name === token || skill.id === token);
    return candidates.length > 0 && candidates.every((skill) => isOff(skill.id));
  };

  const revised: QueuedContextPart[] = [];
  for (const part of context) {
    if (part.kind !== 'instruction') {
      revised.push(part);
      continue;
    }
    if (part.skills) {
      const kept = part.skills.filter((skill) => !isOff(skill.id));
      if (kept.length === part.skills.length) revised.push(part);
      else if (kept.length > 0) revised.push({ kind: 'instruction', text: buildSkillMentionInstruction(kept.map((skill) => skill.name)) ?? '', skills: kept });
      continue;
    }
    const tokens = parseSkillMentionInstruction(part.text);
    if (!tokens) {
      revised.push(part);
      continue;
    }
    const kept = tokens.filter((token) => !tokenIsOff(token));
    if (kept.length === tokens.length) revised.push(part);
    else if (kept.length > 0) revised.push({ kind: 'instruction', text: buildSkillMentionInstruction(kept) ?? '' });
  }
  return revised;
};

/** What one `GET /api/config/skills` gave, before it is committed. */
type SkillsSnapshot = {
  skills: DiscoveredSkill[];
  /** Only the disk scan answered; known skills it cannot vouch for are kept. */
  partial: boolean;
  policy: SkillPolicyRead;
};

/** Reads one directory's skills, retrying twice; null when every attempt failed. */
const fetchSkillsSnapshot = async (directory: string | null): Promise<SkillsSnapshot | null> => {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const response = await runBackgroundNetworkTask(() => runtimeFetch(`/api/config/skills${queryParams}`, {
        priority: 'low',
        headers: directory ? { 'x-opencode-directory': directory } : undefined,
      }));
      if (!response.ok) {
        throw new Error(`Failed to list skills: ${response.status}`);
      }

      const data = await response.json();
      const rawSkills: RawSkillResponse[] = data.skills || [];
      // OpenCode loads a narrower set than this scan finds, and the
      // rules live in server-side env flags the browser cannot read.
      // The route reports them; `filterSkillsByRuntimeFlags` mirrors
      // OpenCode's discovery, including the `.agents`-wins dedup that
      // matters when `.claude/skills` are symlinks back into it.
      //
      // Deliberately not OpenCode's own skill endpoint: measured
      // against 1.18.14 it lists only global and builtin skills and
      // omits the project skills the agent actually has. On 2.x it also
      // drops a switched-off skill, which Settings still lists.
      const skills = filterSkillsByRuntimeFlags(rawSkills.map(toDiscoveredSkill), data.externalSkills ?? null);
      return {
        skills,
        // The server answers with only its disk scan when OpenCode's
        // own list could not be read. That is not a complete list.
        partial: data.openCodeSkillsUnavailable === true,
        policy: parseSkillPolicyRead(data.skillPolicy),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(200 * (attempt + 1));
    }
  }
  console.error("Failed to load skills:", lastError);
  return null;
};

/**
 * The policy view after a read: a fresh state replaces the shown one, a failed
 * read keeps the last known state and says why, and an answer without policy
 * (an older server) keeps what was known.
 */
const nextPolicyView = (previous: SkillPolicyView | null, read: SkillPolicyRead): SkillPolicyView => {
  if (read.kind === 'state') return { state: read.state, error: null };
  if (read.kind === 'error') return { state: previous?.state ?? null, error: read.message };
  return previous ?? { state: null, error: null };
};

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillId: null,
        skills: [],
        skillsByDirectory: {},
        availableSkills: [],
        availableSkillsByDirectory: {},
        policyByDirectory: {},
        lastDecidedByDirectory: {},
        switchStatus: {},
        isLoading: false,
        skillDraft: null,

        resetForRuntimeSwitch: () => {
          skillsGeneration += 1;
          skillsLastLoadedAt.clear();
          skillsLoadInFlight.clear();
          skillsRevision.clear();
          skillSwitchesInFlight.clear();
          set({
            skills: [],
            skillsByDirectory: {},
            availableSkills: [],
            availableSkillsByDirectory: {},
            policyByDirectory: {},
            lastDecidedByDirectory: {},
            switchStatus: {},
            isLoading: false,
          });
        },

        setSelectedSkill: (id: string | null) => {
          set({ selectedSkillId: id });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async (requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const loadedAt = skillsLastLoadedAt.get(cacheKey) ?? 0;
          const cached = get().skillsByDirectory[cacheKey];

          if (cached && cached.length > 0 && Date.now() - loadedAt < SKILLS_LOAD_CACHE_TTL_MS) {
            // The app may have moved to this directory since it was read:
            // the mirrors follow the directory the app is on now.
            if (cacheKey === ambientCacheKey() && get().skills !== cached) {
              set((state) => commitDirectory(state, cacheKey, {}));
            }
            return true;
          }

          const inFlight = skillsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const generation = skillsGeneration;
          const request = (async () => {
            set({ isLoading: true });
            for (let restart = 0; restart < LOAD_RESTARTS; restart++) {
              const revision = revisionOf(cacheKey);
              const snapshot = await fetchSkillsSnapshot(directory);
              if (generation !== skillsGeneration) return false;
              // Something changed while this read was out; its answer may
              // predate the change. Read again.
              if (revision !== revisionOf(cacheKey)) continue;
              // Failure must never look like an empty project: the lists
              // stay as they are.
              if (!snapshot) {
                set({ isLoading: false });
                return false;
              }
              set((state) => {
                const previousSkills = state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
                const policy = nextPolicyView(state.policyByDirectory[cacheKey] ?? null, snapshot.policy);
                const next = commitDirectory(state, cacheKey, {
                  skills: snapshot.partial ? mergePartialSkills(snapshot.skills, previousSkills) : snapshot.skills,
                  policy,
                });
                next.isLoading = false;
                if (snapshot.policy.kind === 'state') next.switchStatus = withoutUnconfirmed(state.switchStatus, cacheKey);
                return next;
              });
              if (snapshot.partial) {
                skillsLastLoadedAt.delete(cacheKey);
              } else {
                skillsLastLoadedAt.set(cacheKey, Date.now());
              }
              return true;
            }
            // Changes kept landing while reading; leave the lists for the
            // next load rather than commit an answer that may be stale.
            if (generation === skillsGeneration) set({ isLoading: false });
            return false;
          })();

          skillsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            if (skillsLoadInFlight.get(cacheKey) === request) skillsLoadInFlight.delete(cacheKey);
          }
        },

        setSkillEnabled: async (id, scope, enabled, requestedDirectory) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const switchKey = `${cacheKey}\n${id}`;
          if (skillSwitchesInFlight.has(switchKey)) {
            return { ok: false, code: 'pending', message: 'A change to this skill is still being saved' };
          }
          skillSwitchesInFlight.add(switchKey);
          const generation = skillsGeneration;
          const setStatus = (status: SkillSwitchStatus | null) => set((state) => {
            const switchStatus = { ...state.switchStatus };
            if (status) switchStatus[switchKey] = status;
            else delete switchStatus[switchKey];
            return { switchStatus };
          });
          setStatus({ phase: 'pending', scope });

          let result: SkillPolicyWriteResult;
          try {
            const response = await runtimeFetch('/api/config/skill-policy', {
              method: 'PUT',
              query: { directory },
              headers: directoryHeaders(directory, true),
              body: JSON.stringify({ id, scope, enabled }),
            });
            result = parseSkillPolicyWrite(await response.json().catch(() => null), response.status);
          } catch (error) {
            result = { ok: false, code: 'network', message: error instanceof Error ? error.message : String(error) };
          } finally {
            skillSwitchesInFlight.delete(switchKey);
          }
          if (generation !== skillsGeneration) return result;

          if (!result.ok) {
            // Nothing was written: the shown policy stays the last confirmed one.
            setStatus({ phase: 'failed', scope, message: result.message });
            return result;
          }

          const { write } = result;
          // A global file applies to every directory; a project file to its own.
          const affected = scope === 'global'
            ? new Set([cacheKey, ambientCacheKey(), ...Object.keys(get().skillsByDirectory)])
            : new Set([cacheKey]);
          for (const key of affected) markSkillsChanged(key);
          set((state) => {
            const previous = state.policyByDirectory[cacheKey]?.state ?? null;
            const policy: SkillPolicyView = {
              state: { ...write.state, skills: new Map(previous?.skills).set(id, write.policy) },
              error: null,
            };
            const next = commitDirectory(state, cacheKey, { policy });
            const switchStatus = { ...state.switchStatus };
            if (write.confirmed) delete switchStatus[switchKey];
            else switchStatus[switchKey] = { phase: 'unconfirmed', scope };
            next.switchStatus = switchStatus;
            return next;
          });
          emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
          // OpenCode applied it: re-read the lists it changes. Switching a
          // built-in skill back on brings it back into the list, and chat
          // reads the directory the app is on, which a global change reaches
          // too. An unconfirmed write is re-read when OpenCode announces the
          // config change, or when the user asks to check again.
          if (write.confirmed) {
            void get().loadSkills(directory);
            const ambient = ambientCacheKey();
            if (affected.has(ambient) && ambient !== cacheKey) void get().loadSkills();
          }
          return result;
        },

        getSkillDetail: async (skill: SkillRef, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory));
            if (!response.ok) {
              return null;
            }
            
            // An answer about another file must not fill the editor that
            // saves back to this one.
            const detail = await response.json() as SkillDetail;
            return isDetailFor(skill, detail) ? detail : null;
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
              upsertSkillLocal(set, { id: config.name, name: config.name }, config, directory);
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

        updateSkill: async (skill: SkillRef, config: Partial<SkillConfig>, requestedDirectory?: string | null) => {
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;
            if (config.disableModelInvocation !== undefined) skillConfig.disableModelInvocation = config.disableModelInvocation;
            // The file the skill was listed at, which the server checks
            // against the selected skill before it writes.
            if (skill.path && skill.path !== BUILT_IN_SKILL_LOCATION) skillConfig.targetPath = skill.path;

            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory, {
              method: 'PATCH',
              body: JSON.stringify(skillConfig),
            }));

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertSkillLocal(set, skill, config, directory);
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

        renameSkill: async (skill: SkillTarget, newName: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory, {
              method: 'PATCH',
              body: JSON.stringify({ renameTo: newName }),
            }));

            const payload = await response.json().catch(() => null);
            if (!response.ok) return { ok: false };
            invalidateSkillsLoadCache(directory);

            // The folder takes the new name, so that is the new id unless the
            // server says otherwise.
            const answer = renameAnswerSchema.safeParse(payload);
            const result: SkillRenameResult = {
              ok: true,
              id: (answer.success ? answer.data.id : undefined) ?? newName,
              oldRuleCleanupFailed: (answer.success ? answer.data.switches?.oldRuleCleanupFailed : undefined) ?? [],
            };

            // The rename is done; refreshing the list is best effort and the
            // next load shows the skill if this one fails.
            if (payload?.requiresReload) {
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              }).catch(() => undefined);
              return result;
            }
            if (await get().loadSkills(directory)) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return result;
          } catch {
            return { ok: false };
          }
        },

        deleteSkill: async (skill: SkillTarget, requestedDirectory?: string | null, location?: SkillLocation) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory, { method: 'DELETE' }, location));

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              removeSkillLocal(set, skill.id, directory);
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
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }

            // Delete removes the file OpenCode loads; a lower-priority copy of
            // the same id can remain and then shows up in the refreshed list.
            // The selection stays on the id while the list still has it.
            const idStillListed = loaded
              && selectSkillsForDirectory(get(), directory).some((entry) => entry.id === skill.id);
            if (get().selectedSkillId === skill.id && !idStillListed) {
              set({ selectedSkillId: null });
            }

            return loaded;
          } catch {
            return false;
          }
        },

        getSkillById: (id: string, requestedDirectory?: string | null) => {
          return selectSkillsForDirectory(get(), requestedDirectory).find((skill) => skill.id === id);
        },

        readSupportingFile: async (skill: SkillTarget, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(
              skillRoute(skill, supportingFilePath(filePath)),
              skillRouteInit(skill, directory),
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

        writeSupportingFile: async (skill: SkillTarget, filePath: string, content: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(
              skillRoute(skill, supportingFilePath(filePath)),
              skillRouteInit(skill, directory, { method: 'PUT', body: JSON.stringify({ content }) }),
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skill: SkillTarget, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(
              skillRoute(skill, supportingFilePath(filePath)),
              skillRouteInit(skill, directory, { method: 'DELETE' }),
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
          selectedSkillId: state.selectedSkillId,
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
