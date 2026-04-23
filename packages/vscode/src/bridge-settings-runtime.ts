import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { type DiscoveredSkill, type SkillScope, type SkillSource } from './opencodeConfig';
import type { BridgeContext } from './bridge';

const SETTINGS_KEY = 'openchamber.settings';
const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
const OPENCHAMBER_MAGIC_PROMPTS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'magic-prompts.json');
const MAGIC_PROMPTS_FILE_VERSION = 1;
const MAGIC_PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const MAGIC_PROMPT_TEXT_MAX_LENGTH = 200_000;
const isVisiblePromptId = (id: string): boolean => id.endsWith('.visible');

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const findWorktreeRootForSkills = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;
  let current = path.resolve(workingDirectory);
  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        return current;
      }
    } catch {
      // Continue climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const getProjectAncestors = (workingDirectory?: string): string[] => {
  if (!workingDirectory) return [];
  const result: string[] = [];
  let current = path.resolve(workingDirectory);
  const stop = findWorktreeRootForSkills(workingDirectory) || current;
  while (true) {
    result.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

const inferSkillScopeAndSourceFromLocation = (location: string, workingDirectory?: string): { scope: SkillScope; source: SkillSource } => {
  const resolvedPath = path.resolve(location);
  const source: SkillSource = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
    ? 'agents'
    : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
      ? 'claude'
      : 'opencode';

  const projectAncestors = getProjectAncestors(workingDirectory);
  const isProjectScoped = projectAncestors.some((ancestor) => {
    const candidates = [
      path.join(ancestor, '.opencode'),
      path.join(ancestor, '.claude', 'skills'),
      path.join(ancestor, '.agents', 'skills'),
    ];
    return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
  });

  if (isProjectScoped) {
    return { scope: 'project', source };
  }

  const home = os.homedir();
  const userRoots = [
    path.join(home, '.config', 'opencode'),
    path.join(home, '.opencode'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
    process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
  ].filter((value): value is string => Boolean(value));

  if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
    return { scope: 'user', source };
  }

  return { scope: 'user', source };
};

export const fetchOpenCodeSkillsFromApi = async (
  ctx: BridgeContext | undefined,
  workingDirectory?: string,
): Promise<DiscoveredSkill[] | null> => {
  const apiUrl = ctx?.manager?.getApiUrl();
  if (!apiUrl) {
    return null;
  }

  try {
    const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    const url = new URL('skill', base);
    if (workingDirectory) {
      url.searchParams.set('directory', workingDirectory);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(ctx?.manager?.getOpenCodeAuthHeaders() || {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    return payload
      .map((item) => {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        const location = typeof item?.location === 'string' ? item.location : '';
        const description = typeof item?.description === 'string' ? item.description : '';
        if (!name || !location) {
          return null;
        }
        const inferred = inferSkillScopeAndSourceFromLocation(location, workingDirectory);
        return {
          name,
          path: location,
          scope: inferred.scope,
          source: inferred.source,
          description,
        } as DiscoveredSkill;
      })
      .filter((item): item is DiscoveredSkill => item !== null);
  } catch {
    return null;
  }
};

const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SHARED_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const writeSharedSettingsToDisk = async (changes: Record<string, unknown>): Promise<void> => {
  try {
    await fs.promises.mkdir(path.dirname(OPENCHAMBER_SHARED_SETTINGS_PATH), { recursive: true });
    const current = readSharedSettingsFromDisk();
    const next: Record<string, unknown> = { ...current, ...changes };
    // Atomic write: tmp file + rename. Readers never see a partial/truncated
    // JSON that would fail to parse and silently get coerced to {}.
    const tmp = `${OPENCHAMBER_SHARED_SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.promises.rename(tmp, OPENCHAMBER_SHARED_SETTINGS_PATH);
  } catch {
    // ignore
  }
};

// Fields derived from runtime context — never persisted, always recomputed.
const DERIVED_FIELDS = new Set(['themeVariant', 'lastDirectory']);

const sanitizeMagicPromptOverrides = (input: unknown): Record<string, string> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!MAGIC_PROMPT_ID_PATTERN.test(key) || typeof value !== 'string') {
      continue;
    }
    next[key] = value;
  }
  return next;
};

const readMagicPromptFile = (): { version: number; overrides: Record<string, string> } => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_MAGIC_PROMPTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { overrides?: unknown };
    return {
      version: MAGIC_PROMPTS_FILE_VERSION,
      overrides: sanitizeMagicPromptOverrides(parsed?.overrides),
    };
  } catch {
    return {
      version: MAGIC_PROMPTS_FILE_VERSION,
      overrides: {},
    };
  }
};

const writeMagicPromptFile = async (state: { version: number; overrides: Record<string, string> }): Promise<void> => {
  await fs.promises.mkdir(path.dirname(OPENCHAMBER_MAGIC_PROMPTS_PATH), { recursive: true });
  await fs.promises.writeFile(OPENCHAMBER_MAGIC_PROMPTS_PATH, JSON.stringify(state, null, 2), 'utf8');
};

const stripDerived = (source: Record<string, unknown>): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...source };
  for (const key of DERIVED_FIELDS) {
    delete next[key];
  }
  return next;
};

let eagerMigrationAttempted = false;

// Read the merged persisted settings: shared file is canonical (synced with
// Desktop and Web clients), globalState is kept as a migration fallback for
// users upgrading from the pre-shared-sync era. Disk wins on conflicts.
//
// On first read per process, if globalState has keys that are missing on
// disk, copy them to disk so other clients see them immediately — without
// waiting for the user to save again.
const readPersistedSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const fromGlobalState = stripDerived(
    ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {},
  );
  const fromDisk = stripDerived(readSharedSettingsFromDisk());

  if (!eagerMigrationAttempted) {
    eagerMigrationAttempted = true;
    const missingFromDisk: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fromGlobalState)) {
      if (!(key in fromDisk)) {
        missingFromDisk[key] = value;
      }
    }
    if (Object.keys(missingFromDisk).length > 0) {
      // Fire-and-forget; readers already have an in-memory merged view.
      void writeSharedSettingsToDisk(missingFromDisk);
    }
  }

  return { ...fromGlobalState, ...fromDisk };
};

export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const persisted = readPersistedSettings(ctx);
  const persistedOpencodeBinary =
    typeof persisted.opencodeBinary === 'string' ? String(persisted.opencodeBinary).trim() : '';
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const themeVariant =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';

  return {
    ...persisted,
    themeVariant,
    lastDirectory: workspaceFolder,
    opencodeBinary: persistedOpencodeBinary || undefined,
  };
};

export const persistSettings = async (changes: Record<string, unknown>, ctx?: BridgeContext): Promise<Record<string, unknown>> => {
  const current = readSettings(ctx);
  const restChanges = stripDerived({ ...(changes || {}) });

  const keysToClear = new Set<string>();

  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId', 'opencodeBinary']) {
    const value = restChanges[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      keysToClear.add(key);
      delete restChanges[key];
    }
  }

  if (typeof restChanges.usageAutoRefresh !== 'boolean') {
    delete restChanges.usageAutoRefresh;
  }

  if (typeof restChanges.usageRefreshIntervalMs === 'number' && Number.isFinite(restChanges.usageRefreshIntervalMs)) {
    restChanges.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(restChanges.usageRefreshIntervalMs)));
  } else {
    delete restChanges.usageRefreshIntervalMs;
  }

  if (typeof restChanges.opencodeBinary === 'string') {
    restChanges.opencodeBinary = restChanges.opencodeBinary.trim();
  }

  // Persistable state = current persisted (no derived fields) + sanitized changes.
  const persistedCurrent = readPersistedSettings(ctx);
  const persistable: Record<string, unknown> = { ...persistedCurrent, ...restChanges };
  for (const key of keysToClear) {
    delete persistable[key];
  }

  // Write to the shared file (canonical, cross-client). Also mirror into
  // globalState so older builds can still read recent values if a user
  // downgrades the extension.
  await writeSharedSettingsToDisk(persistable);
  await ctx?.context?.globalState.update(SETTINGS_KEY, persistable);

  // Return the same shape as readSettings (with derived fields re-applied).
  return {
    ...persistable,
    themeVariant: current.themeVariant,
    lastDirectory: current.lastDirectory,
    opencodeBinary:
      typeof persistable.opencodeBinary === 'string' && persistable.opencodeBinary.length > 0
        ? persistable.opencodeBinary
        : undefined,
  };
};

export const readMagicPromptOverrides = (): { version: number; overrides: Record<string, string> } => {
  return readMagicPromptFile();
};

export const saveMagicPromptOverride = async (id: string, text: string): Promise<{ version: number; overrides: Record<string, string> }> => {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!MAGIC_PROMPT_ID_PATTERN.test(normalizedId)) {
    throw new Error('Invalid prompt id');
  }
  if (typeof text !== 'string') {
    throw new Error('Prompt text must be a string');
  }
  if (isVisiblePromptId(normalizedId) && text.trim().length === 0) {
    throw new Error('Visible prompt text cannot be empty');
  }
  if (text.length > MAGIC_PROMPT_TEXT_MAX_LENGTH) {
    throw new Error('Prompt text is too long');
  }

  const current = readMagicPromptFile();
  const next = {
    version: MAGIC_PROMPTS_FILE_VERSION,
    overrides: {
      ...current.overrides,
      [normalizedId]: text,
    },
  };
  await writeMagicPromptFile(next);
  return next;
};

export const resetMagicPromptOverride = async (id: string): Promise<{ version: number; overrides: Record<string, string> }> => {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!MAGIC_PROMPT_ID_PATTERN.test(normalizedId)) {
    throw new Error('Invalid prompt id');
  }

  const current = readMagicPromptFile();
  if (!Object.prototype.hasOwnProperty.call(current.overrides, normalizedId)) {
    return current;
  }
  const nextOverrides = { ...current.overrides };
  delete nextOverrides[normalizedId];
  const next = {
    version: MAGIC_PROMPTS_FILE_VERSION,
    overrides: nextOverrides,
  };
  await writeMagicPromptFile(next);
  return next;
};

export const resetAllMagicPromptOverrides = async (): Promise<{ version: number; overrides: Record<string, string> }> => {
  const next = {
    version: MAGIC_PROMPTS_FILE_VERSION,
    overrides: {},
  };
  await writeMagicPromptFile(next);
  return next;
};
