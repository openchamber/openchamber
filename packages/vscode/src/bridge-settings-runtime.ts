import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUILT_IN_SKILL_LOCATION, type DiscoveredSkill, type SkillScope, type SkillSource } from './opencodeConfig';
import type { BridgeContext } from './bridge';
import { filterPersistableSettingsChanges, withoutSecretSettings } from './settings-registry-gate';
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

// Test seam: lets the settings tests redirect the module-level shared settings
// path to a temp file without touching the real user file. The preferences
// file is always derived from the effective shared path.
let sharedSettingsPathOverride: string | null = null;
const getSharedSettingsPath = (): string => sharedSettingsPathOverride ?? OPENCHAMBER_SHARED_SETTINGS_PATH;
const getSharedPreferencesPath = (): string => preferencesFilePathFor(getSharedSettingsPath());

// Not exported in the package surface; tests import the compiled module and
// call this to point the shared settings file at a temp path. Exported solely
// so `bun test` can reach it across the module boundary.
export const __setSharedSettingsPathForTest = (filePath: string | null): void => {
  sharedSettingsPathOverride = filePath;
};
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
        const content = typeof item?.content === 'string' ? item.content : '';
        if (!name || !location) {
          return null;
        }
        if (location === BUILT_IN_SKILL_LOCATION) {
          return {
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

// Settings live in two files beside each other (see `settings-files.ts`):
// `settings.json` holds instance facts and legacy keys, `preferences.json`
// holds the profile keys with their `updatedAt` stamps. Reads return the
// merged view; writes split a merged document back into the two files.
//
// A settings.json parse failure (corrupt or non-object file) is still coerced
// to `{}`, which lets the next write replace it; tracked in the settings-scopes
// plan. preferences.json already fails closed below.
const readSettingsJsonFromDisk = (): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(getSharedSettingsPath(), 'utf8');
    // SAFETY: JSON.parse returns untyped data; the check below keeps only a plain object.
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // SAFETY: a non-array object parsed from JSON is a string-keyed dictionary.
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

type PreferencesReadResult =
  | { status: 'ok'; fields: PreferenceFields }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

// True after preferences.json was found but could not be read or parsed. While
// set, the file is left alone: reads return settings.json only and writes drop
// profile keys instead of replacing a file whose content we cannot see.
let preferencesUnavailable = false;
let preferencesUnavailableLogged = false;

const readPreferencesFromDisk = (): PreferencesReadResult => {
  let result: PreferencesReadResult;
  try {
    const parsed = parsePreferencesDocument(fs.readFileSync(getSharedPreferencesPath(), 'utf8'));
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
      console.warn(`[OpenChamber] ${getSharedPreferencesPath()} could not be read (${result.reason}); profile settings are unavailable until the file is fixed or removed.`);
    }
  } else {
    preferencesUnavailable = false;
  }
  return result;
};

// Atomic write: tmp file + rename, so readers never see a partial JSON. Throws
// on failure (after removing the tmp file) so a failed save is reported, not
// mistaken for success.
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

// Merged view of both files. A missing preferences.json is seeded once from the
// profile keys settings.json still carries; every write keeps a copy of the
// profile's base values in settings.json, so an older build can still read it.
const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  const settings = readSettingsJsonFromDisk();
  let preferences = readPreferencesFromDisk();
  if (preferences.status === 'missing') {
    const seeded = seedPreferencesFrom(stripDerived(settings), Date.now());
    try {
      writeJsonAtomicSync(getSharedPreferencesPath(), serializePreferencesDocument(seeded));
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

// Write a complete merged document: profile keys go to preferences.json (keeping
// the stamps of unchanged values), everything else to settings.json. A key the
// document no longer carries leaves whichever file owned it.
const writeSharedSettingsToDisk = async (
  document: Record<string, unknown>,
  changedKeys: Iterable<string> | null = null,
): Promise<void> => {
  const preferences = readPreferencesFromDisk();
  if (preferencesUnavailable) {
    console.warn('[OpenChamber] preferences.json is unreadable; profile settings were not saved.');
    // settings.json keeps whatever legacy profile copy it already holds.
    const onDisk = readSettingsJsonFromDisk();
    await writeJsonAtomic(getSharedSettingsPath(), JSON.stringify({
      ...instancePartOf(document),
      ...profilePartOf(onDisk),
    }, null, 2));
    return;
  }
  const previousFields = preferences.status === 'ok' ? preferences.fields : {};
  // This host is always the VS Code surface kind: per-surface profile keys it
  // changed land under `surfaces.vscode`; keys it did not change keep their entry.
  const nextFields = buildPreferencesFields(previousFields, document, Date.now(), {
    surface: VSCODE_SETTINGS_SURFACE,
    changedKeys,
  });
  await writeJsonAtomic(getSharedPreferencesPath(), serializePreferencesDocument(nextFields));
  // The legacy copy of the profile's base values rides along for older builds.
  await writeJsonAtomic(getSharedSettingsPath(), JSON.stringify(legacySettingsDocumentOf(document, nextFields), null, 2));
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
      void writeSharedSettingsToDisk({ ...fromDisk, ...missingFromDisk }).catch((error: unknown) => {
        console.warn('[OpenChamber] Failed to migrate settings from globalState:', error instanceof Error ? error.message : String(error));
      });
    }
  }

  return { ...fromGlobalState, ...fromDisk };
};

// Everything the webview may see: the persisted document minus the keys the
// registry marks `secret` (a UI password, tunnel tokens), which are write-only.
export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const persisted = withoutSecretSettings(readPersistedSettings(ctx));
  const persistedOpencodeBinary =
    typeof persisted.opencodeBinary === 'string' ? String(persisted.opencodeBinary).trim() : '';
  // globalState/disk payloads are untyped: only the two known values survive;
  // an old doc without the field, or a foreign value, reads as undefined.
  const persistedOpencodeRuntime =
    persisted.opencodeRuntime === 'stable' || persisted.opencodeRuntime === 'beta'
      ? persisted.opencodeRuntime
      : undefined;
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
    // Always recomputed: an invalid persisted value must not leak through raw.
    opencodeRuntime: persistedOpencodeRuntime,
  };
};

export const persistSettings = async (changes: Record<string, unknown>, ctx?: BridgeContext): Promise<Record<string, unknown>> => {
  const current = readSettings(ctx);
  // Only keys the settings registry knows as stored shared fields reach disk.
  const restChanges = filterPersistableSettingsChanges(stripDerived({ ...(changes || {}) }));

  const keysToClear = new Set<string>();

  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId', 'opencodeBinary', 'smallModelOverride', 'walkthroughModelOverride']) {
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

  if ('opencodeRuntime' in restChanges) {
    // Unknown/empty values must not land on disk; keep the existing value.
    if (restChanges.opencodeRuntime !== 'stable' && restChanges.opencodeRuntime !== 'beta') {
      delete restChanges.opencodeRuntime;
    }
  }

  // Persistable state = current persisted (no derived fields) + sanitized changes.
  const persistedCurrent = readPersistedSettings(ctx);
  const persistable: Record<string, unknown> = { ...persistedCurrent, ...restChanges };
  for (const key of keysToClear) {
    delete persistable[key];
  }

  // Write to the shared files (canonical, cross-client); a failed write rejects
  // so the webview reports the save as failed. Also mirror into globalState so
  // older builds can still read recent values if a user downgrades the extension.
  await writeSharedSettingsToDisk(persistable, [...Object.keys(restChanges), ...keysToClear]);
  await ctx?.context?.globalState.update(SETTINGS_KEY, persistable);

  // Return the same shape as readSettings (derived fields re-applied, secrets withheld).
  return {
    ...withoutSecretSettings(persistable),
    themeVariant: current.themeVariant,
    lastDirectory: current.lastDirectory,
    opencodeBinary:
      typeof persistable.opencodeBinary === 'string' && persistable.opencodeBinary.length > 0
        ? persistable.opencodeBinary
        : undefined,
    opencodeRuntime:
      persistable.opencodeRuntime === 'stable' || persistable.opencodeRuntime === 'beta'
        ? persistable.opencodeRuntime
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
