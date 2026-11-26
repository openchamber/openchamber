import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUILT_IN_SKILL_LOCATION, type DiscoveredSkill, type SkillScope, type SkillSource } from './opencodeConfig';
import { checkOpenCodeDirectoryTrust, openCodeTrust, type OpenCodeTrustGuard } from './opencodeTrust';
import type { BridgeContext } from './bridge';
import { filterPersistableSettingsChanges, withoutSecretSettings } from './settings-registry-gate';
import { createProjectSetupStore } from './bridge-project-setup-runtime';
import { execGit } from './bridge-git-process-runtime';
import { createMagicPromptService, repositoryOfGitResult, workspaceProjectsOf } from './magic-prompts';
import { createWorktreeRegistry } from '../../web/server/lib/git/worktree-registry.js';
import { resolveWorkspaceFolders } from './workspaceResolver';
import { dropUnorderedSessionCostChanges } from './settings-session-cost';
import {
  buildPreferencesFields,
  flattenPreferences,
  instancePartOf,
  legacySettingsDocumentOf,
  profilePartOf,
  parsePreferencesDocument,
  preferencesFilePathFor,
  seedPreferencesFrom,
  serializePreferencesDocument,
  type PreferenceFields,
  VSCODE_SETTINGS_SURFACE,
} from './settings-files';

const SETTINGS_KEY = 'openchamber.settings';
const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
const OPENCHAMBER_PREFERENCES_PATH = preferencesFilePathFor(OPENCHAMBER_SHARED_SETTINGS_PATH);
const OPENCHAMBER_MAGIC_PROMPTS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'magic-prompts.json');

const worktreeRegistry = createWorktreeRegistry(async (directory, args, failure) => {
  const result = await execGit(args, directory, { env: { LC_ALL: 'C', LANGUAGE: '' } });
  if (result.exitCode !== 0) throw Object.assign(new Error(failure), { stderr: result.stderr });
  return result;
});

export const projectSetupStore = createProjectSetupStore();

export const magicPrompts = createMagicPromptService({
  globalFilePath: OPENCHAMBER_MAGIC_PROMPTS_PATH,
  sharedFiles: projectSetupStore,
  listProjects: () => workspaceProjectsOf(resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? [])),
  repositoryOf: async (directory) => {
    const porcelain = await worktreeRegistry.readPorcelain(directory).catch((error: Error & { stderr?: string }) => {
      if (error.stderr === undefined) throw error;
      return { stdout: '', stderr: error.stderr, exitCode: 1 };
    });
    return repositoryOfGitResult(typeof porcelain === 'string' ? { stdout: porcelain, stderr: '', exitCode: 0 } : porcelain);
  },
});

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
    OPENCODE_CONFIG_DIR,
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

export const loadSkillBody = async (
  ctx: BridgeContext | undefined,
  skill: DiscoveredSkill,
  workingDirectory?: string,
  trust: OpenCodeTrustGuard = openCodeTrust,
): Promise<DiscoveredSkill> => {
  const apiUrl = ctx?.manager?.getApiUrl();
  if (skill.path !== BUILT_IN_SKILL_LOCATION || skill.content || !apiUrl) return skill;
  const route = `/api/experimental/skill/${encodeURIComponent(skill.id ?? skill.name)}/file/SKILL.md`;
  if (await checkOpenCodeDirectoryTrust(workingDirectory, { path: route, trust })) return skill;
  const headers = new Headers(ctx?.manager?.getOpenCodeAuthHeaders());
  if (workingDirectory) headers.set('x-opencode-directory', encodeURIComponent(workingDirectory));
  try {
    const response = await fetch(new URL(route, apiUrl).toString(), { headers, signal: AbortSignal.timeout(8_000) });
    return response.ok ? { ...skill, content: await response.text() } : skill;
  } catch {
    return skill;
  }
};

export const fetchOpenCodeSkillsFromApi = async (
  ctx: BridgeContext | undefined,
  workingDirectory?: string,
  trust: OpenCodeTrustGuard = openCodeTrust,
): Promise<DiscoveredSkill[] | null> => {
  const refusal = await checkOpenCodeDirectoryTrust(workingDirectory, { path: '/api/skill', trust });
  if (refusal) {
    return null;
  }

  const apiUrl = ctx?.manager?.getApiUrl();
  if (!apiUrl) {
    return null;
  }

  try {
    const url = new URL('/api/skill', apiUrl);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(workingDirectory ? { 'x-opencode-directory': encodeURIComponent(workingDirectory) } : {}),
        ...(ctx?.manager?.getOpenCodeAuthHeaders() || {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { data?: unknown } | null;
    const skills = payload?.data;
    if (!Array.isArray(skills)) {
      return null;
    }

    return skills
      .map((item) => {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        const rawLocation = typeof item?.path === 'string' ? item.path : (typeof item?.location === 'string' ? item.location : '');
        const location = rawLocation.startsWith('/builtin/') || rawLocation.startsWith('skill://') ? BUILT_IN_SKILL_LOCATION : rawLocation;
        const description = typeof item?.description === 'string' ? item.description : '';
        const content = typeof item?.content === 'string' ? item.content : '';
        if (!name || !location) {
          return null;
        }
        if (location === BUILT_IN_SKILL_LOCATION) {
          return {
            id: String(item?.id || name),
            name,
            path: location,
            scope: 'user',
            source: 'opencode',
            description,
            content,
          } as DiscoveredSkill;
        }
        const inferred = inferSkillScopeAndSourceFromLocation(location, workingDirectory);
        return {
          name,
          path: location,
          scope: inferred.scope,
          source: inferred.source,
          description,
          content,
        } as DiscoveredSkill;
      })
      .filter((item): item is DiscoveredSkill => item !== null);
  } catch {
    return null;
  }
};

const readSettingsJsonFromDisk = (): Record<string, unknown> => {
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse returns untyped data; the check below keeps only a plain object.
    parsed = JSON.parse(fs.readFileSync(OPENCHAMBER_SHARED_SETTINGS_PATH, 'utf8')) as unknown;
  } catch (error) {
    // SAFETY: fs errors carry a `code` string; anything else is a read failure.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {};
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings.json does not hold a JSON object');
  }
  // SAFETY: a non-array object parsed from JSON is a string-keyed dictionary.
  return parsed as Record<string, unknown>;
};

let settingsUnreadableLogged = false;

type PreferencesReadResult =
  | { status: 'ok'; fields: PreferenceFields }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

let preferencesUnavailable = false;
let preferencesUnavailableLogged = false;

const readPreferencesFromDisk = (): PreferencesReadResult => {
  let result: PreferencesReadResult;
  try {
    const parsed = parsePreferencesDocument(fs.readFileSync(OPENCHAMBER_PREFERENCES_PATH, 'utf8'));
    result = parsed.ok ? { status: 'ok', fields: parsed.fields } : { status: 'unreadable', reason: parsed.reason };
  } catch (error) {
    // SAFETY: fs errors carry a `code` string; anything else is reported by message.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    result = code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }

  if (result.status === 'unreadable') {
    preferencesUnavailable = true;
    if (!preferencesUnavailableLogged) {
      preferencesUnavailableLogged = true;
      console.warn(`[OpenChamber] ${OPENCHAMBER_PREFERENCES_PATH} could not be read (${result.reason}); profile settings are unavailable until the file is fixed or removed.`);
    }
  } else {
    preferencesUnavailable = false;
  }
  return result;
};

const writeJsonAtomic = async (filePath: string, text: string): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

const writeJsonAtomicSync = (filePath: string, text: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    throw error;
  }
};

const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  const settings = readSettingsJsonFromDisk();
  let preferences = readPreferencesFromDisk();
  if (preferences.status === 'missing') {
    const seeded = seedPreferencesFrom(stripDerived(settings), Date.now());
    try {
      writeJsonAtomicSync(OPENCHAMBER_PREFERENCES_PATH, serializePreferencesDocument(seeded));
    } catch (error) {
      console.warn('[OpenChamber] Failed to seed preferences.json:', error instanceof Error ? error.message : String(error));
    }
    preferences = { status: 'ok', fields: seeded };
  }
  if (preferences.status !== 'ok') {
    return settings;
  }
  return { ...settings, ...flattenPreferences(preferences.fields, VSCODE_SETTINGS_SURFACE) };
};

const writeSharedSettingsToDisk = async (
  document: Record<string, unknown>,
  changedKeys: Iterable<string> | null = null,
): Promise<void> => {
  const preferences = readPreferencesFromDisk();
  if (preferencesUnavailable) {
    console.warn('[OpenChamber] preferences.json is unreadable; profile settings were not saved.');
    const onDisk = readSettingsJsonFromDisk();
    await writeJsonAtomic(OPENCHAMBER_SHARED_SETTINGS_PATH, JSON.stringify({
      ...instancePartOf(document),
      ...profilePartOf(onDisk),
    }, null, 2));
    return;
  }
  const previousFields = preferences.status === 'ok' ? preferences.fields : {};
  const nextFields = buildPreferencesFields(previousFields, document, Date.now(), {
    surface: VSCODE_SETTINGS_SURFACE,
    changedKeys,
  });
  await writeJsonAtomic(OPENCHAMBER_PREFERENCES_PATH, serializePreferencesDocument(nextFields));
  await writeJsonAtomic(OPENCHAMBER_SHARED_SETTINGS_PATH, JSON.stringify(legacySettingsDocumentOf(document, nextFields), null, 2));
};

const DERIVED_FIELDS = new Set(['themeVariant', 'lastDirectory']);

const stripDerived = (source: Record<string, unknown>): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...source };
  for (const key of DERIVED_FIELDS) {
    delete next[key];
  }
  return next;
};

let eagerMigrationAttempted = false;

const globalStateSettingsOf = (ctx?: BridgeContext) => stripDerived(
  ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {},
);

const readPersistedSettingsFromDisk = (ctx?: BridgeContext) => {
  const fromGlobalState = globalStateSettingsOf(ctx);
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
      void writeSharedSettingsToDisk({ ...fromDisk, ...missingFromDisk }).catch((error: unknown) => {
        console.warn('[OpenChamber] Failed to migrate settings from globalState:', error instanceof Error ? error.message : String(error));
      });
    }
  }

  return { ...fromGlobalState, ...fromDisk };
};

const readPersistedSettings = (ctx?: BridgeContext) => {
  try {
    const settings = readPersistedSettingsFromDisk(ctx);
    settingsUnreadableLogged = false;
    return settings;
  } catch (error) {
    if (!settingsUnreadableLogged) {
      settingsUnreadableLogged = true;
      console.warn(`[OpenChamber] ${OPENCHAMBER_SHARED_SETTINGS_PATH} could not be read (${error instanceof Error ? error.message : String(error)}); settings are not saved until it reads again.`);
    }
    return globalStateSettingsOf(ctx);
  }
};

export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const persisted = withoutSecretSettings(readPersistedSettings(ctx));
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
  eagerMigrationAttempted = true;
  const current = readSettings(ctx);
  const restChanges = filterPersistableSettingsChanges(stripDerived({ ...(changes || {}) }));

  const keysToClear = new Set<string>();

  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId', 'opencodeBinary', 'smallModelOverride', 'smallModelVariant', 'walkthroughModelOverride', 'walkthroughModelVariant']) {
    const value = restChanges[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      keysToClear.add(key);
      delete restChanges[key];
    }
  }

  if ('smallModelUseDefault' in restChanges && typeof restChanges.smallModelUseDefault !== 'boolean') {
    delete restChanges.smallModelUseDefault;
  }

  if ('sessionRecapEnabled' in restChanges && typeof restChanges.sessionRecapEnabled !== 'boolean') {
    delete restChanges.sessionRecapEnabled;
  }

  if ('sessionSuggestionEnabled' in restChanges && typeof restChanges.sessionSuggestionEnabled !== 'boolean') {
    delete restChanges.sessionSuggestionEnabled;
  }

  if ('sessionWorkEnabled' in restChanges && typeof restChanges.sessionWorkEnabled !== 'boolean') {
    delete restChanges.sessionWorkEnabled;
  }

  if ('sessionWorkIncludesPinned' in restChanges && typeof restChanges.sessionWorkIncludesPinned !== 'boolean') {
    delete restChanges.sessionWorkIncludesPinned;
  }

  if ('sessionGoalEnabled' in restChanges && typeof restChanges.sessionGoalEnabled !== 'boolean') {
    delete restChanges.sessionGoalEnabled;
  }

  if ('sessionGoalDefaultBudgetEnabled' in restChanges && typeof restChanges.sessionGoalDefaultBudgetEnabled !== 'boolean') {
    delete restChanges.sessionGoalDefaultBudgetEnabled;
  }

  if ('sessionGoalDefaultBudget' in restChanges) {
    const budget = restChanges.sessionGoalDefaultBudget;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
      delete restChanges.sessionGoalDefaultBudget;
    }
  }

  if (typeof restChanges.opencodeBinary === 'string') {
    restChanges.opencodeBinary = restChanges.opencodeBinary.trim();
  }

  const persistedCurrent = readPersistedSettingsFromDisk(ctx);
  dropUnorderedSessionCostChanges(persistedCurrent, restChanges);
  const persistable: Record<string, unknown> = { ...persistedCurrent, ...restChanges };
  for (const key of keysToClear) {
    delete persistable[key];
  }

  await writeSharedSettingsToDisk(persistable, [...Object.keys(restChanges), ...keysToClear]);
  await ctx?.context?.globalState.update(SETTINGS_KEY, persistable);

  return {
    ...withoutSecretSettings(persistable),
    themeVariant: current.themeVariant,
    lastDirectory: current.lastDirectory,
    opencodeBinary:
      typeof persistable.opencodeBinary === 'string' && persistable.opencodeBinary.length > 0
        ? persistable.opencodeBinary
        : undefined,
  };
};
