import { isDeepStrictEqual } from 'node:util';
import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
import { createSettingsFileState, SettingsWriteConflict } from './settings-file-state.js';
import { createSessionProjectRegistrar } from './settings-session-project.js';
import { createExclusiveSettingsSave } from './settings-exclusive-save.js';
import { backupHiddenLegacyProfile } from './settings-legacy-profile-backup.js';
import { createSettingsFileReplace } from './settings-file-replace.js';
import { createRuntimeSettingsApplier } from './settings-reconciliation.js';
import type { SettingsDocument, createSettingsHelpers } from './settings-helpers.js';
import type { SettingsProject, createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';
import type { createManagedTunnelConfigRuntime } from '../tunnels/managed-config.js';
import type { PreferenceReadResult, SettingsSurface } from './settings-files.js';
import { directoryReachability } from '../directory-reachability/index.js';
import { createProjectValidation } from './project-validation.js';
import { createMigratedSettingsReader } from './settings-migrated-reader.js';
import { isBoolean, isString } from '../shared/object-guards.js';
import type fsModule from 'node:fs/promises';
import type pathModule from 'node:path';
import type cryptoModule from 'node:crypto';
import {
  buildPreferencesFields,
  isAbandonedSettingsTempFile,
  flattenPreferences,
  instancePartOf,
  legacySettingsDocumentOf,
  profilePartOf,
  isDeviceSettingsKey,
  isProfileSettingsKey,
  normalizeSettingsSurface,
  preferencesFilePathFor,
  seedPreferencesFrom,
  serializePreferencesDocument,
} from './settings-files.js';

type Normalization = ReturnType<typeof createSettingsNormalizationRuntime>;
type Helpers = ReturnType<typeof createSettingsHelpers>;
type TunnelConfig = ReturnType<typeof createManagedTunnelConfigRuntime>;
export type SettingsRuntimeDependencies = Pick<Normalization,
  'sanitizeProjects' | 'normalizeSettingsPaths' | 'normalizeStringArray'
  | 'normalizeManagedRemoteTunnelHostname' | 'normalizeManagedRemoteTunnelPresets'
  | 'normalizeManagedRemoteTunnelPresetTokens'> & Pick<Helpers,
  'sanitizeSettingsUpdate' | 'mergePersistedSettings' | 'formatSettingsResponse'> & {
  refreshCanonicalPaths?: (...documents: SettingsDocument[]) => Promise<void>;
  fsPromises: Pick<typeof fsModule, 'readFile' | 'writeFile' | 'open' | 'mkdir' | 'readdir' | 'access' | 'rename' | 'rm' | 'stat' | 'realpath' | 'copyFile' | 'chmod'>;
  path: Pick<typeof pathModule, 'join' | 'dirname' | 'relative' | 'isAbsolute' | 'resolve' | 'basename'>;
  crypto: Pick<typeof cryptoModule, 'createHash'>;
  SETTINGS_FILE_PATH: string;
  resolveDirectoryCandidate: (value: string) => string | null;
  syncManagedRemoteTunnelConfigWithPresets: TunnelConfig['syncManagedRemoteTunnelConfigWithPresets'];
  upsertManagedRemoteTunnelToken: TunnelConfig['upsertManagedRemoteTunnelToken'];
  chatRoots?: string[];
  onManagedPluginSettingsChanged?: (settings: SettingsDocument) => void;
  onMessageSearchEnabledChanged?: (enabled: boolean) => void;
  onMessageSearchReasoningChanged?: (enabled: boolean) => void;
  onPermissionDefaultModeChanged?: (mode: SettingsDocument[string]) => void;
  onLastDirectoryChanged?: (directory: SettingsDocument[string]) => void;
};

export interface SettingsReadOptions {
  surface?: SettingsSurface | null;
}

export interface SettingsWriteOptions extends SettingsReadOptions {
  profileUnreadable?: boolean;
  changedKeys?: Iterable<string> | null;
}

type NotificationTemplate = { title: string; message: string };
type NotificationTemplates = Record<string, NotificationTemplate>;
type OrphanProject = { orphanId: string; filePath: string; content: SettingsDocument };
const hasFields = (value: unknown): value is SettingsDocument => Boolean(value && typeof value === 'object');
const hasErrorCode = (value: unknown): value is { code?: unknown } => Boolean(value && typeof value === 'object');
const hasOptionalCode = (value: unknown): value is { code?: unknown } => value != null;
const hasTemplateFields = (value: unknown): value is { title?: unknown; message?: unknown } => value != null;
const hasActionFields = (value: unknown): value is { command?: unknown; name?: unknown } => value != null;
const hasProjectFields = (value: unknown): value is { id?: unknown; path?: unknown } => value != null;
const hasPresetFields = (value: unknown): value is { id?: unknown; name?: unknown; hostname?: unknown } => value != null;
const isList = (value: unknown): value is unknown[] => Array.isArray(value);

const EMPTY_NOTIFICATION_TEMPLATES = {
  completion: { title: '', message: '' },
  error: { title: '', message: '' },
  question: { title: '', message: '' },
  subtask: { title: '', message: '' },
};

const emptyNotificationTemplates = () => Object.fromEntries(
  Object.entries(EMPTY_NOTIFICATION_TEMPLATES).map(([event, template]) => [event, { ...template }]),
);

const LEGACY_SEEDED_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
};

const isLegacySeededNotificationTemplates = (templates: NotificationTemplates) => (
  Object.entries(LEGACY_SEEDED_NOTIFICATION_TEMPLATES).every(([event, legacy]) => {
    const candidate = templates?.[event];
    return candidate?.title === legacy.title && candidate?.message === legacy.message;
  })
);

const normalizeNotificationTemplates = (templates: SettingsDocument[string]) => {
  const input = hasFields(templates) ? templates : {};
  let changed = false;
  const next: NotificationTemplates = {};

  for (const [event, base] of Object.entries(EMPTY_NOTIFICATION_TEMPLATES)) {
    const currentEntry = input[event];
    const currentTitle = hasTemplateFields(currentEntry) && isString(currentEntry.title) ? currentEntry.title : base.title;
    const currentMessage = hasTemplateFields(currentEntry) && isString(currentEntry.message) ? currentEntry.message : base.message;
    if (!currentEntry || !hasTemplateFields(currentEntry) || !isString(currentEntry.title) || !isString(currentEntry.message)) {
      changed = true;
    }
    next[event] = { title: currentTitle, message: currentMessage };
  }

  return { templates: next, changed };
};

export const createSettingsRuntime = (deps: SettingsRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH,
    sanitizeProjects,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    normalizeSettingsPaths,
    normalizeStringArray,
    formatSettingsResponse,
    resolveDirectoryCandidate,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    refreshCanonicalPaths = async () => {},
    chatRoots = [],
    onManagedPluginSettingsChanged = async () => {},
    onMessageSearchEnabledChanged = () => {},
    onMessageSearchReasoningChanged = () => {},
    onPermissionDefaultModeChanged = () => {},
    onLastDirectoryChanged = () => {},
  } = deps;

  const PREFERENCES_FILE_PATH = preferencesFilePathFor(SETTINGS_FILE_PATH, path);
  let preferencesUnavailable = false;
  const settingsFileState = createSettingsFileState({
    fsPromises, path, settingsFilePath: SETTINGS_FILE_PATH, preferencesFilePath: PREFERENCES_FILE_PATH,
    sanitizeSettingsUpdate,
  });

  let orphanRecoveryDone = false;

  const PROJECTS_ROOT_DIR = path.join(path.dirname(SETTINGS_FILE_PATH), 'projects');
  const PROJECT_ICONS_DIR = path.join(path.dirname(SETTINGS_FILE_PATH), 'project-icons');

  const sha1Hex = (value: string) => crypto.createHash('sha1').update(value).digest('hex');
  const projectIconBaseName = (projectId: string) => `project-${sha1Hex(projectId)}`;
  const PROJECT_ICON_EXTENSIONS = ['png', 'jpg', 'svg', 'webp', 'ico'];

  const readJsonFile = async (filePath: string) => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return hasFields(parsed) ? parsed : null;
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  const writeJsonFile = async (filePath: string, value: SettingsDocument) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  };

  const uniqueStrings = (values: unknown[]) => Array.from(new Set(values.filter((value): value is string => isString(value) && value.trim().length > 0)));

  const mergeByKey = (oldItems: SettingsDocument[string], newItems: SettingsDocument[string], getKey: (item: SettingsDocument) => SettingsDocument[string]) => {
    const result: SettingsDocument[] = [];
    const seen = new Set();
    for (const item of [...(isList(newItems) ? newItems : []), ...(isList(oldItems) ? oldItems : [])]) {
      if (!hasFields(item)) continue;
      const key = getKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  };

  const remapPlanPaths = (entries: SettingsDocument[string], fromDir: string, toDir: string) => {
    if (!isList(entries) || !fromDir || !toDir || fromDir === toDir) {
      return isList(entries) ? entries : [];
    }
    return entries.map((entry) => {
      if (!hasFields(entry) || !isString(entry.path)) {
        return entry;
      }
      const trimmedPath = entry.path.trim();
      const relativePath = path.relative(fromDir, trimmedPath);
      if (relativePath && (relativePath.startsWith('..') || path.isAbsolute(relativePath))) {
        return entry;
      }
      return {
        ...entry,
        path: relativePath ? path.join(toDir, relativePath) : toDir,
      };
    });
  };

  const mergeProjectConfigData = ({ oldConfig, newConfig, oldStorageDir, newStorageDir, projectPath }: {
    oldConfig: SettingsDocument | null; newConfig: SettingsDocument | null;
    oldStorageDir: string; newStorageDir: string; projectPath: string;
  }) => {
    const oldValue = oldConfig || {};
    const newValue = newConfig || {};
    const oldPlanFiles = remapPlanPaths(oldValue.projectPlanFiles, oldStorageDir, newStorageDir);
    const newPlanFiles = remapPlanPaths(newValue.projectPlanFiles, oldStorageDir, newStorageDir);
    const oldNotes = isString(oldValue.projectNotes) ? oldValue.projectNotes : '';
    const newNotes = isString(newValue.projectNotes) ? newValue.projectNotes : '';

    const merged: SettingsDocument = {
      ...oldValue,
      ...newValue,
    };
    if (projectPath.trim().length > 0) merged.projectPath = projectPath;
    if (uniqueStrings([...(Array.isArray(oldValue['setup-worktree']) ? oldValue['setup-worktree'] : []), ...(Array.isArray(newValue['setup-worktree']) ? newValue['setup-worktree'] : [])]).length > 0) {
      merged['setup-worktree'] = uniqueStrings([...(Array.isArray(oldValue['setup-worktree']) ? oldValue['setup-worktree'] : []), ...(Array.isArray(newValue['setup-worktree']) ? newValue['setup-worktree'] : [])]);
    }
    if (oldNotes || newNotes) merged.projectNotes = newNotes || oldNotes;
    if (mergeByKey(oldValue.projectTodos, newValue.projectTodos, (item) => item.id).length > 0) {
      merged.projectTodos = mergeByKey(oldValue.projectTodos, newValue.projectTodos, (item) => item.id);
    }
    if (mergeByKey(oldValue.projectActions, newValue.projectActions, (item) => item.id).length > 0) {
      merged.projectActions = mergeByKey(oldValue.projectActions, newValue.projectActions, (item) => item.id);
    }
    if (mergeByKey(oldValue.scheduledTasks, newValue.scheduledTasks, (item) => item.id).length > 0) {
      merged.scheduledTasks = mergeByKey(oldValue.scheduledTasks, newValue.scheduledTasks, (item) => item.id);
    }
    if (mergeByKey(oldPlanFiles, newPlanFiles, (item) => item.id || item.path).length > 0) {
      merged.projectPlanFiles = mergeByKey(oldPlanFiles, newPlanFiles, (item) => item.id || item.path);
    }
    if (isString(newValue.projectActionsPrimaryId) && newValue.projectActionsPrimaryId.trim().length > 0) {
      merged.projectActionsPrimaryId = newValue.projectActionsPrimaryId;
    } else if (isString(oldValue.projectActionsPrimaryId) && oldValue.projectActionsPrimaryId.trim().length > 0) {
      merged.projectActionsPrimaryId = oldValue.projectActionsPrimaryId;
    }
    return merged;
  };

  const moveDirectoryContents = async (fromDir: string, toDir: string) => {
    try {
      const entries = await fsPromises.readdir(fromDir, { withFileTypes: true });
      await fsPromises.mkdir(toDir, { recursive: true });

      for (const entry of entries) {
        const fromPath = path.join(fromDir, entry.name);
        const toPath = path.join(toDir, entry.name);
        if (entry.isDirectory()) {
          await moveDirectoryContents(fromPath, toPath);
          continue;
        }
        try {
          await fsPromises.access(toPath);
        } catch {
          await fsPromises.rename(fromPath, toPath);
        }
      }

      await fsPromises.rm(fromDir, { recursive: true, force: true });
    } catch (error) {
      if (!(hasErrorCode(error) && error.code === 'ENOENT')) {
        throw error;
      }
    }
  };

  const migrateProjectIconFiles = async ({ oldId, newId }: { oldId: string; newId: string }) => {
    if (!oldId || !newId || oldId === newId) {
      return;
    }

    const oldBase = projectIconBaseName(oldId);
    const newBase = projectIconBaseName(newId);

    await fsPromises.mkdir(PROJECT_ICONS_DIR, { recursive: true });

    for (const ext of PROJECT_ICON_EXTENSIONS) {
      const oldPath = path.join(PROJECT_ICONS_DIR, `${oldBase}.${ext}`);
      const newPath = path.join(PROJECT_ICONS_DIR, `${newBase}.${ext}`);
      try {
        await fsPromises.access(oldPath);
      } catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      try {
        await fsPromises.access(newPath);
      } catch {
        await fsPromises.rename(oldPath, newPath);
        continue;
      }

      await fsPromises.rm(oldPath, { force: true });
    }
  };

  const mergeProjectContextFiles = async (oldStorageDir: string, newStorageDir: string) => {
    const oldContextPath = path.join(oldStorageDir, 'context.json');
    const newContextPath = path.join(newStorageDir, 'context.json');

    const [oldContext, newContext] = await Promise.all([
      readJsonFile(oldContextPath).catch(() => null),
      readJsonFile(newContextPath).catch(() => null),
    ]);

    if (!oldContext || !newContext) {
      return;
    }

    const mergeNotes = () => {
      const oldIsList = Array.isArray(oldContext.notes);
      const newIsList = Array.isArray(newContext.notes);
      if (oldIsList && newIsList) {
        return mergeByKey(oldContext.notes, newContext.notes, (item) => item.id);
      }
      if (newIsList) return newContext.notes;
      if (oldIsList) return oldContext.notes;
      return newContext.notes || oldContext.notes || '';
    };

    await writeJsonFile(newContextPath, {
      ...oldContext,
      ...newContext,
      notes: mergeNotes(),
      todos: mergeByKey(oldContext.todos, newContext.todos, (item) => item.id),
      plans: mergeByKey(oldContext.plans, newContext.plans, (item) => item.id || item.file),
    });
    await fsPromises.rm(oldContextPath, { force: true });
  };

  const migrateProjectScopedStorage = async ({ oldId, newId, projectPath }: { oldId: string; newId: string; projectPath: string }) => {
    if (!oldId || !newId || oldId === newId) {
      return;
    }

    const oldConfigPath = path.join(PROJECTS_ROOT_DIR, `${projectConfigFileStemOf(oldId)}.json`);
    const newConfigPath = path.join(PROJECTS_ROOT_DIR, `${projectConfigFileStemOf(newId)}.json`);
    const oldStorageDir = path.join(PROJECTS_ROOT_DIR, projectConfigFileStemOf(oldId));
    const newStorageDir = path.join(PROJECTS_ROOT_DIR, projectConfigFileStemOf(newId));

    const [oldConfig, newConfig] = await Promise.all([
      readJsonFile(oldConfigPath),
      readJsonFile(newConfigPath),
    ]);

    if (oldConfig || newConfig) {
      const merged = mergeProjectConfigData({ oldConfig, newConfig, oldStorageDir, newStorageDir, projectPath });
      await writeJsonFile(newConfigPath, merged);
    }

    await mergeProjectContextFiles(oldStorageDir, newStorageDir);
    await moveDirectoryContents(oldStorageDir, newStorageDir);
    await fsPromises.rm(oldConfigPath, { force: true });
  };

  const migrateRawIdStorageFolder = async (projectId: string) => {
    const stem = projectConfigFileStemOf(projectId);
    if (stem === projectId) return;
    const rawStorageDir = path.join(PROJECTS_ROOT_DIR, projectId);
    try {
      await fsPromises.stat(rawStorageDir);
    } catch (error) {
      if (hasOptionalCode(error) && (error.code === 'ENOENT' || error.code === 'ENAMETOOLONG')) return;
      throw error;
    }
    const boundedStorageDir = path.join(PROJECTS_ROOT_DIR, stem);
    await mergeProjectContextFiles(rawStorageDir, boundedStorageDir);
    await moveDirectoryContents(rawStorageDir, boundedStorageDir);
  };

  const migrateSettingsToDeterministicProjectIds = async (current: SettingsDocument) => {
    const settings = current;
    const projects = sanitizeProjects(settings.projects) || [];
    if (projects.length === 0) {
      return { settings, changed: false };
    }

    let changed = false;
    const projectIdMap = new Map();
    const nextProjects = [];

    for (const project of projects) {
      const canonicalId = createProjectIdFromPath(project.path);
      const nextId = canonicalId || project.id;
      projectIdMap.set(project.id, nextId);
      if (nextId !== project.id) {
        changed = true;
        await migrateProjectScopedStorage({ oldId: project.id, newId: nextId, projectPath: project.path });
        await migrateProjectIconFiles({ oldId: project.id, newId: nextId });
      }
      await migrateRawIdStorageFolder(nextId);
      nextProjects.push({ ...project, id: nextId });
    }

    if (!orphanRecoveryDone) {
      orphanRecoveryDone = true;
      try {
        await recoverOrphanProjectFiles(nextProjects);
      } catch (error) {
        console.warn('[projects] Orphan recovery failed, continuing startup:', error);
      }
    }

    if (!changed) {
      return { settings, changed: false };
    }

    const currentActiveId = isString(settings.activeProjectId) ? settings.activeProjectId : '';
    const nextActiveProjectId = projectIdMap.get(currentActiveId) || currentActiveId || nextProjects[0]?.id;

    const nextSettings: SettingsDocument = {
      ...settings,
      projects: nextProjects,
    };
    if (nextActiveProjectId) nextSettings.activeProjectId = nextActiveProjectId;
    return { settings: nextSettings, changed: true };
  };

  const recoverOrphanProjectFiles = async (canonicalProjects: SettingsProject[]) => {
    let entries;
    try {
      entries = await fsPromises.readdir(PROJECTS_ROOT_DIR, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') return;
      throw error;
    }

    const canonicalIds = new Set(canonicalProjects.map((project) => project.id));
    const orphanFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .filter((id) => id && !id.startsWith('path_') && !canonicalIds.has(id));

    if (orphanFiles.length === 0) return;

    console.warn(`[projects] Found ${orphanFiles.length} orphan project config(s) without projectPath.`);

    const orphans: OrphanProject[] = [];
    for (const orphanId of orphanFiles) {
      const filePath = path.join(PROJECTS_ROOT_DIR, `${orphanId}.json`);
      const content = await readJsonFile(filePath);
      if (!content) continue;
      const hasContent = [
        isString(content.projectNotes) && content.projectNotes.trim().length > 0,
        Array.isArray(content.projectTodos) && content.projectTodos.length > 0,
        Array.isArray(content.projectActions) && content.projectActions.length > 0,
        Array.isArray(content['setup-worktree']) && content['setup-worktree'].length > 0,
        Array.isArray(content.projectPlanFiles) && content.projectPlanFiles.length > 0,
      ].some(Boolean);
      if (!hasContent) continue;
      orphans.push({ orphanId, filePath, content });
    }

    if (orphans.length === 0) return;

    const basenameOf = (projectPath: string) => {
      const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '');
      const idx = normalized.lastIndexOf('/');
      return (idx >= 0 ? normalized.slice(idx + 1) : normalized).toLowerCase();
    };

    const extractRootRelPaths = (orphan: OrphanProject) => {
      const commands = [
        ...(Array.isArray(orphan.content['setup-worktree']) ? orphan.content['setup-worktree'] : []),
        ...(isList(orphan.content.projectActions) ? orphan.content.projectActions.map((a) => hasActionFields(a) && isString(a.command) ? a.command : '') : []),
      ].filter(isString);
      const results = new Set<string>();
      const re = /\$(?:\{)?ROOT_(?:PROJECT|WORKTREE)_PATH\}?\/([A-Za-z0-9._/-]+)/g;
      for (const cmd of commands) {
        let match;
        while ((match = re.exec(cmd)) !== null) {
          const relativePath = match[1];
          if (relativePath !== undefined) results.add(relativePath);
        }
      }
      return Array.from(results);
    };

    const fileExistsInProject = async (projectPath: string, relPath: string) => {
      try {
        await fsPromises.access(path.join(projectPath, relPath));
        return true;
      } catch {
        return false;
      }
    };

    const orphanMatchesProject = async (orphan: OrphanProject, project: SettingsProject) => {
      if (!project.path.trim()) return false;
      const rels = extractRootRelPaths(orphan);
      for (const rel of rels) {
        if (await fileExistsInProject(project.path, rel)) {
          return true;
        }
      }
      const name = basenameOf(project.path);
      if (!name) return false;
      const haystacks = [
        ...(Array.isArray(orphan.content['setup-worktree']) ? orphan.content['setup-worktree'] : []),
        ...(isList(orphan.content.projectActions) ? orphan.content.projectActions.map((a) => `${hasActionFields(a) && a.name || ''} ${hasActionFields(a) && a.command || ''}`) : []),
      ].join(' ').toLowerCase();
      return haystacks.includes(name);
    };

    const matches = new Map<string, OrphanProject[]>();
    for (const orphan of orphans) {
      const matchedProjects = [];
      for (const project of canonicalProjects) {
        if (await orphanMatchesProject(orphan, project)) {
          matchedProjects.push(project);
        }
      }
      const project = matchedProjects[0];
      if (matchedProjects.length === 1 && project) {
        const list = matches.get(project.id) || [];
        list.push(orphan);
        matches.set(project.id, list);
      }
    }

    const orphansConsumed = new Set();
    for (const [projectId, orphansForProject] of matches.entries()) {
      const project = canonicalProjects.find((p) => p.id === projectId);
      if (!project) continue;
      const targetStem = projectConfigFileStemOf(project.id);
      const targetPath = path.join(PROJECTS_ROOT_DIR, `${targetStem}.json`);
      const targetStorageDir = path.join(PROJECTS_ROOT_DIR, targetStem);

      for (const orphan of orphansForProject) {
        const targetExisting = (await readJsonFile(targetPath)) || {};
        const orphanStorageDir = path.join(PROJECTS_ROOT_DIR, orphan.orphanId);
        const merged = mergeProjectConfigData({
          oldConfig: orphan.content,
          newConfig: targetExisting,
          oldStorageDir: orphanStorageDir,
          newStorageDir: targetStorageDir,
          projectPath: project.path,
        });
        await writeJsonFile(targetPath, merged);
        await moveDirectoryContents(orphanStorageDir, targetStorageDir);
        await fsPromises.rm(orphan.filePath, { force: true });
        orphansConsumed.add(orphan.orphanId);
        console.log(`[projects] Recovered orphan ${orphan.orphanId} -> ${project.id} (${project.path})`);
      }
    }

    const remaining = orphans.filter((orphan) => !orphansConsumed.has(orphan.orphanId));
    if (remaining.length > 0) {
      console.warn(`[projects] ${remaining.length} orphan project file(s) could not be auto-matched: ${remaining.map((o) => o.orphanId).join(', ')}`);
    }
  };

  const readInstanceSettingsFromDisk = async () => (await settingsFileState.read('settings')).document ?? {};

  const readPreferenceFields = async (): Promise<PreferenceReadResult> => {
    const result = await settingsFileState.readForWrite('preferences');
    if (result.status === 'missing') return { status: 'missing' };
    if (result.status === 'failed') return { status: 'failed', fields: result.document };
    return { status: 'ok', fields: result.document, revision: result.revision, missing: result.missing };
  };

  const readSettingsWithStatus = async ({ surface = null }: SettingsReadOptions = {}): Promise<{ settings: SettingsDocument; profileUnreadable: boolean }> => {
    const instance = await readInstanceSettingsFromDisk();
    const preferences = await readPreferenceFields();
    if (preferences.status === 'failed') {
      preferencesUnavailable = true;
      return { profileUnreadable: true, settings: { ...(preferences.fields ? instancePartOf(instance) : instance), ...flattenPreferences(preferences.fields ?? {}, normalizeSettingsSurface(surface)) } };
    }
    preferencesUnavailable = false;
    if (preferences.status === 'missing') {
      if (settingsFileState.isUnreadable('settings')) return { profileUnreadable: false, settings: instance };
      const seeded = seedPreferencesFrom(instance, Date.now());
      try {
        await writeJsonFileAtomic(PREFERENCES_FILE_PATH, serializePreferencesDocument(seeded), { expectedRevision: preferences.revision ?? 0 });
      } catch (error) {
        console.warn('Failed to seed preferences file:', error);
      }
      return { profileUnreadable: false, settings: instance };
    }
    return { profileUnreadable: false, settings: { ...instancePartOf(instance), ...flattenPreferences(preferences.fields, normalizeSettingsSurface(surface)) } };
  };
  const readSettingsFromDisk = async (options: SettingsReadOptions = {}) => (await readSettingsWithStatus(options)).settings;

  const readSettingsFromDiskStrict = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(SETTINGS_FILE_PATH, 'utf8');
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!hasFields(parsed) || Array.isArray(parsed)) {
      throw new Error('Settings file is malformed (non-object payload)');
    }
    return parsed;
  };

  const { replaceFile, flushToDisk } = createSettingsFileReplace(fsPromises);

  const cleanupOrphanedSettingsTempFiles = async (directory: string) => {
    try {
      const entries = await fsPromises.readdir(directory, { withFileTypes: true });
      const cleanupTasks = entries
        .filter((entry) => entry.isFile() && isAbandonedSettingsTempFile(entry.name, Date.now()))
        .map((entry) => fsPromises.rm(path.join(directory, entry.name), { force: true }).catch(() => {}));
      await Promise.all(cleanupTasks);
    } catch {
      return;
    }
  };

  const writeJsonFileAtomic = async (filePath: string, text: string, { acknowledge = true, expectedRevision = null }: {
    acknowledge?: boolean;
    expectedRevision?: number | null;
  } = {}) => {
    const source = filePath === SETTINGS_FILE_PATH ? 'settings' : filePath === PREFERENCES_FILE_PATH ? 'preferences' : null;
    if (source && (await settingsFileState.readForWrite(source)).status === 'failed') {
      throw new SettingsWriteConflict(`Cannot replace unreadable ${path.basename(filePath)}`);
    }
    if (source && acknowledge && settingsFileState.hasUnreportedChanges(source)) {
      throw new SettingsWriteConflict(`Cannot replace an external ${path.basename(filePath)} update before reconciliation`);
    }
    const publicationRevision = source ? expectedRevision ?? settingsFileState.getRevision(source) : null;
    if (source && settingsFileState.getRevision(source) !== publicationRevision) {
      throw new SettingsWriteConflict(`${path.basename(filePath)} changed before publication`);
    }
    if (source === 'settings') await backupHiddenLegacyProfile({ fsPromises, path, settingsFilePath: SETTINGS_FILE_PATH, settingsFileState, replaceFile, flushToDisk }, text);
    const directory = path.dirname(filePath);
    const created = await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (created && process.platform !== 'win32') await fsPromises.chmod(directory, 0o700);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await flushToDisk(tmp);
      if (process.platform !== 'win32') await fsPromises.chmod(tmp, 0o600);
      if (source) {
        const latest = await settingsFileState.readForWrite(source);
        if (latest.status === 'failed' || settingsFileState.getRevision(source) !== publicationRevision) {
          throw new SettingsWriteConflict(`${path.basename(filePath)} changed during publication`);
        }
      }
      await replaceFile(tmp, filePath);
      if (acknowledge) settingsFileState.acknowledge(filePath, text, { expectedRevision: publicationRevision });
      if (process.platform !== 'win32') await fsPromises.chmod(filePath, 0o600);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      console.warn(`Failed to write ${path.basename(filePath)}:`, error);
      throw error;
    }
  };

  const writeSettingsToDisk = async (settings: SettingsDocument, { surface = null, changedKeys = null, profileUnreadable = preferencesUnavailable }: SettingsWriteOptions = {}) => {
    const instanceSnapshot = await settingsFileState.readForWrite('settings');
    const current: PreferenceReadResult = profileUnreadable ? { status: 'failed' } : await readPreferenceFields();
    if (settingsFileState.hasUnreportedChanges('settings') || (current.status === 'ok' && settingsFileState.hasUnreportedChanges('preferences'))) {
      throw new SettingsWriteConflict('Cannot replace external settings updates before reconciliation');
    }
    if (current.status === 'failed') {
      if (!profileUnreadable) throw new SettingsWriteConflict('Cannot replace unreadable preferences.json');
      const committed = (await settingsFileState.read('preferences')).document;
      const profile = committed ? flattenPreferences(committed) : profilePartOf(await readInstanceSettingsFromDisk());
      await writeJsonFileAtomic(SETTINGS_FILE_PATH, JSON.stringify({ ...instancePartOf(settings), ...profile }, null, 2));
      return;
    }
    const previousFields = current.status === 'ok' ? current.fields : {};
    const nextFields = buildPreferencesFields(previousFields, settings, Date.now(), {
      surface: normalizeSettingsSurface(surface),
      changedKeys,
    });
    await writeJsonFileAtomic(SETTINGS_FILE_PATH, JSON.stringify(legacySettingsDocumentOf(settings, nextFields), null, 2), { expectedRevision: instanceSnapshot.revision ?? 0 });
    if (current.status === 'ok' && !current.missing && isDeepStrictEqual(nextFields, previousFields)) return;
    await writeJsonFileAtomic(PREFERENCES_FILE_PATH, serializePreferencesDocument(nextFields), { expectedRevision: current.revision ?? 0 });
    const published = await settingsFileState.read('settings');
    if (published.status !== 'ok' || settingsFileState.hasUnreportedChanges('settings')) throw new SettingsWriteConflict('settings.json changed during publication');
  };

  const validateProjectEntries = createProjectValidation(fsPromises);

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const isChatDirectory = async (candidate: string) => {
    const roots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
    if (roots.some((root) => isWithinRoot(candidate, root))) {
      return true;
    }
    const realCandidate = await fsPromises.realpath(candidate);
    const realRoots = await Promise.all(roots.map((root) => fsPromises.realpath(root).catch(() => null)));
    return realRoots.some((root) => root && isWithinRoot(realCandidate, root));
  };

  const migrateSettingsFromLegacyLastDirectory = async (current: SettingsDocument) => {
    const settings = current;
    const now = Date.now();

    const sanitizedProjects = sanitizeProjects(settings.projects) || [];
    let nextProjects = sanitizedProjects;
    let nextActiveProjectId =
      isString(settings.activeProjectId) ? settings.activeProjectId : undefined;

    let changed = false;

    if (nextProjects.length === 0) {
      const legacy = isString(settings.lastDirectory) ? settings.lastDirectory.trim() : '';
      const candidate = legacy ? resolveDirectoryCandidate(legacy) : null;

      if (candidate && !await directoryReachability.isUnreachable(candidate)) {
        try {
          const stats = await fsPromises.stat(candidate);
          if (stats.isDirectory() && !(await isChatDirectory(candidate))) {
            const id = createProjectIdFromPath(candidate);
            nextProjects = [
              {
                id,
                path: candidate,
                addedAt: now,
                lastOpenedAt: now,
              },
            ];
            nextActiveProjectId = id;
            changed = true;
          }
        } catch {
          changed = false;
        }
      }
    }

    if (nextProjects.length > 0) {
      const active = nextProjects.find((project) => project.id === nextActiveProjectId) || null;
      if (!active) {
        nextActiveProjectId = nextProjects[0]?.id;
        changed = true;
      }
    } else if (nextActiveProjectId) {
      nextActiveProjectId = undefined;
      changed = true;
    }

    if (!changed) {
      return { settings, changed: false };
    }

    const merged = mergePersistedSettings(settings, {
      ...settings,
      projects: nextProjects,
      ...(nextActiveProjectId ? { activeProjectId: nextActiveProjectId } : { activeProjectId: undefined }),
    });

    return { settings: merged, changed: true };
  };

  const migrateSettingsFromLegacyThemePreferences = async (current: SettingsDocument) => {
    const settings = current;

    const themeId = isString(settings.themeId) ? settings.themeId.trim() : '';
    const themeVariant = isString(settings.themeVariant) ? settings.themeVariant.trim() : '';

    const hasLight = isString(settings.lightThemeId) && settings.lightThemeId.trim().length > 0;
    const hasDark = isString(settings.darkThemeId) && settings.darkThemeId.trim().length > 0;

    if (hasLight && hasDark) {
      return { settings, changed: false };
    }

    const defaultLight = 'openchamber-light';
    const defaultDark = 'openchamber-dark';

    let nextLightThemeId = hasLight ? settings.lightThemeId : undefined;
    let nextDarkThemeId = hasDark ? settings.darkThemeId : undefined;

    if (!hasLight) {
      if (themeId && themeVariant === 'light') {
        nextLightThemeId = themeId;
      } else {
        nextLightThemeId = defaultLight;
      }
    }

    if (!hasDark) {
      if (themeId && themeVariant === 'dark') {
        nextDarkThemeId = themeId;
      } else {
        nextDarkThemeId = defaultDark;
      }
    }

    const changes = { ...settings };
    if (nextLightThemeId) changes.lightThemeId = nextLightThemeId;
    if (nextDarkThemeId) changes.darkThemeId = nextDarkThemeId;
    const merged = mergePersistedSettings(settings, changes);

    return { settings: merged, changed: true };
  };

  const migrateSettingsFromLegacyCollapsedProjects = async (current: SettingsDocument) => {
    const settings = current;
    const collapsed = Array.isArray(settings.collapsedProjects)
      ? normalizeStringArray(settings.collapsedProjects)
      : [];

    if (collapsed.length === 0 || !Array.isArray(settings.projects)) {
      if (collapsed.length === 0) {
        return { settings, changed: false };
      }
      const next = { ...settings };
      delete next.collapsedProjects;
      return { settings: next, changed: true };
    }

    const set = new Set(collapsed);
    const projects = sanitizeProjects(settings.projects) || [];
    let changed = false;

    const nextProjects = projects.map((project) => {
      const shouldCollapse = set.has(project.id);
      if (project.sidebarCollapsed !== shouldCollapse) {
        changed = true;
        return { ...project, sidebarCollapsed: shouldCollapse };
      }
      return project;
    });

    if (!changed) {
      if (Object.prototype.hasOwnProperty.call(settings, 'collapsedProjects')) {
        const next = { ...settings };
        delete next.collapsedProjects;
        return { settings: next, changed: true };
      }
      return { settings, changed: false };
    }

    const next: SettingsDocument = { ...settings, projects: nextProjects };
    delete next.collapsedProjects;
    return { settings: next, changed: true };
  };

  const migrateSettingsNotificationDefaults = async (current: SettingsDocument) => {
    const settings = current;
    let changed = false;
    const next = { ...settings };

    if (!isBoolean(settings.notifyOnSubtasks)) {
      next.notifyOnSubtasks = true;
      changed = true;
    }
    if (!isBoolean(settings.notifyOnCompletion)) {
      next.notifyOnCompletion = true;
      changed = true;
    }
    if (settings.notifyOnPullRequests !== true && settings.notifyOnPullRequests !== false) {
      next.notifyOnPullRequests = true;
      changed = true;
    }
    if (!isBoolean(settings.notifyOnError)) {
      next.notifyOnError = true;
      changed = true;
    }
    if (!isBoolean(settings.notifyOnQuestion)) {
      next.notifyOnQuestion = true;
      changed = true;
    }

    const { templates, changed: templatesChanged } = normalizeNotificationTemplates(settings.notificationTemplates);
    const wasSeeded = isLegacySeededNotificationTemplates(templates);
    const nextTemplates = wasSeeded ? emptyNotificationTemplates() : templates;
    if (
      templatesChanged
      || wasSeeded
      || !settings.notificationTemplates
      || !hasFields(settings.notificationTemplates)
    ) {
      next.notificationTemplates = nextTemplates;
      changed = true;
    }

    return { settings: changed ? next : settings, changed };
  };

  const migrateSettingsFromLegacyNamedTunnelKeys = async (current: SettingsDocument) => {
    const settings = current;
    const next = { ...settings };
    let changed = false;

    if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelHostname')
      && Object.prototype.hasOwnProperty.call(next, 'namedTunnelHostname')) {
      next.managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(next.namedTunnelHostname);
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelToken')
      && Object.prototype.hasOwnProperty.call(next, 'namedTunnelToken')) {
      if (next.namedTunnelToken === null) {
        next.managedRemoteTunnelToken = null;
      } else if (isString(next.namedTunnelToken)) {
        next.managedRemoteTunnelToken = next.namedTunnelToken.trim();
      }
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelPresets')
      && Object.prototype.hasOwnProperty.call(next, 'namedTunnelPresets')) {
      next.managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(next.namedTunnelPresets);
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelPresetTokens')
      && Object.prototype.hasOwnProperty.call(next, 'namedTunnelPresetTokens')) {
      next.managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(next.namedTunnelPresetTokens);
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelSelectedPresetId')
      && Object.prototype.hasOwnProperty.call(next, 'namedTunnelSelectedPresetId')) {
      const selectedPresetId = isString(next.namedTunnelSelectedPresetId)
        ? next.namedTunnelSelectedPresetId.trim()
        : '';
      if (selectedPresetId) {
        next.managedRemoteTunnelSelectedPresetId = selectedPresetId;
      }
      changed = true;
    }

    const legacyKeys = [
      'namedTunnelHostname',
      'namedTunnelToken',
      'namedTunnelPresets',
      'namedTunnelPresetTokens',
      'namedTunnelSelectedPresetId',
    ];
    for (const key of legacyKeys) {
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
        changed = true;
      }
    }

    return { settings: changed ? next : settings, changed };
  };

  const migrateSettingsRemoveApprovedDirectories = (current: SettingsDocument) => {
    const settings = current;
    if (!Object.prototype.hasOwnProperty.call(settings, 'approvedDirectories')) {
      return { settings, changed: false };
    }
    const next = { ...settings };
    delete next.approvedDirectories;
    return { settings: next, changed: true };
  };

  const migrateSettingsScheduleToolFromControl = (settings: SettingsDocument) => {
    const chosen = settings.agentScheduleToolEnabled === true || settings.agentScheduleToolEnabled === false;
    if (settings.agentControlToolEnabled !== false || chosen) {
      return { settings, changed: false };
    }
    return { settings: { ...settings, agentScheduleToolEnabled: false }, changed: true };
  };

  const readMigratedSettings = async ({ surface = null }: SettingsReadOptions = {}) => {
    await refreshCanonicalPaths(await readSettingsFromDisk({ surface }));
    const current = await readSettingsFromDisk({ surface });
    const migration1 = await migrateSettingsFromLegacyLastDirectory(current);
    const migration2 = await migrateSettingsFromLegacyThemePreferences(migration1.settings);
    const migration3 = await migrateSettingsFromLegacyCollapsedProjects(migration2.settings);
    const migration4 = await migrateSettingsNotificationDefaults(migration3.settings);
    const migration5 = await migrateSettingsFromLegacyNamedTunnelKeys(migration4.settings);
    const migration6 = normalizeSettingsPaths(migration5.settings);
    const migration7 = await migrateSettingsToDeterministicProjectIds(migration6.settings);
    const migration8 = migrateSettingsRemoveApprovedDirectories(migration7.settings);
    const migration9 = migrateSettingsScheduleToolFromControl(migration8.settings);
    const migrated = migration1.changed || migration2.changed || migration3.changed || migration4.changed || migration5.changed || migration6.changed || migration7.changed || migration8.changed || migration9.changed;
    const sourceUnreadable = settingsFileState.isUnreadable('settings') || settingsFileState.isUnreadable('preferences');
    const externalPending = settingsFileState.hasUnreportedChanges('settings') || settingsFileState.hasUnreportedChanges('preferences');
    return { settings: migration9.settings, writable: migrated && !sourceUnreadable && !externalPending };
  };

  const applyRuntimeSettings = createRuntimeSettingsApplier({
    onManagedPluginSettingsChanged, onMessageSearchEnabledChanged,
    onMessageSearchReasoningChanged, onPermissionDefaultModeChanged, onLastDirectoryChanged,
  });

  const exclusive = createExclusiveSettingsSave({
    settingsFileState, sanitizeSettingsUpdate, writeJsonFileAtomic, applyRuntimeSettings,
    settingsFilePath: SETTINGS_FILE_PATH, preferencesFilePath: PREFERENCES_FILE_PATH,
  });

  const { readSettingsFromDiskMigrated, enqueue, updateSettingsFromDisk } = createMigratedSettingsReader({
    cleanupTempFiles: () => cleanupOrphanedSettingsTempFiles(path.dirname(SETTINGS_FILE_PATH)),
    readSettings: readSettingsFromDisk, readMigratedSettings, writeSettings: writeSettingsToDisk, exclusive,
  });
  const applyChanges = async (resolveChanges: (current: SettingsDocument) => SettingsDocument, surface: SettingsSurface | null) => {
    const { settings: current, profileUnreadable } = await readSettingsWithStatus({ surface });
    const changes = resolveChanges(current);
    console.log('[persistSettings] Updating fields:', Object.keys(changes || {}).join(', ') || '(none)');
    const sanitized = sanitizeSettingsUpdate(changes);
    const refusedKeys: string[] = [];
    for (const key of Object.keys(sanitized)) {
      if (isDeviceSettingsKey(key)) {
        Reflect.deleteProperty(sanitized, key);
      } else if (profileUnreadable && isProfileSettingsKey(key)) {
        refusedKeys.push(key);
        Reflect.deleteProperty(sanitized, key);
      }
    }
    let next = mergePersistedSettings(current, sanitized);

    const normalizedState = normalizeSettingsPaths(next);
    if (normalizedState.changed) {
      next = normalizedState.settings;
    }

    const deterministicProjectIdMigration = await migrateSettingsToDeterministicProjectIds(next);
    if (deterministicProjectIdMigration.changed) {
      next = deterministicProjectIdMigration.settings;
    }

    const approvedDirectoriesMigration = migrateSettingsRemoveApprovedDirectories(next);
    if (approvedDirectoriesMigration.changed) {
      next = approvedDirectoriesMigration.settings;
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'projects') && isList(next.projects)) {
      const validated = await validateProjectEntries(next.projects);
      next = { ...next, projects: validated };
    }

    if (isList(next.projects) && next.projects.length > 0) {
      const activeId = isString(next.activeProjectId) ? next.activeProjectId : '';
      const active = next.projects.find((project) => {
        if (!hasProjectFields(project)) throw new TypeError(`Cannot read properties of ${project === null ? 'null' : 'undefined'} (reading 'id')`);
        return project.id === activeId;
      }) || null;
      if (!active) {
        const firstProject = next.projects[0];
        if (!hasProjectFields(firstProject)) throw new TypeError(`Cannot read properties of ${firstProject === null ? 'null' : 'undefined'} (reading 'id')`);
        console.log(`[persistSettings] Active project ID ${activeId} not found, switching to ${firstProject.id}`);
        next = { ...next, activeProjectId: firstProject.id };
      }
    } else if (next.activeProjectId) {
      console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
      next = { ...next, activeProjectId: undefined };
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresets')) {
      await syncManagedRemoteTunnelConfigWithPresets(next.managedRemoteTunnelPresets);
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresetTokens') && sanitized.managedRemoteTunnelPresetTokens) {
      const presets = next.managedRemoteTunnelPresets || [];
      if (!isList(presets)) throw new TypeError('(next.managedRemoteTunnelPresets || []).map is not a function');
      const presetsById = new Map(presets.map((entry) => {
        if (!hasPresetFields(entry)) throw new TypeError(`Cannot read properties of ${entry === null ? 'null' : 'undefined'} (reading 'id')`);
        return [entry.id, entry] as const;
      }));
      const updates = Object.entries(sanitized.managedRemoteTunnelPresetTokens)
        .map(([presetId, token]) => {
          const preset = presetsById.get(presetId);
          if (!preset || !isString(token) || token.trim().length === 0) {
            return null;
          }
          return {
            id: preset.id,
            name: preset.name,
            hostname: preset.hostname,
            token: token.trim(),
          };
        })
        .filter((update) => update !== null);

      for (const update of updates) {
        await upsertManagedRemoteTunnelToken(update);
      }
    }

    const changedKeys = Object.keys(sanitized);
    await writeSettingsToDisk(next, { surface, changedKeys, profileUnreadable });
    return { current, next, changedKeys, refusedKeys };
  };

  const persistResolvedSettings = async (resolveChanges: (current: SettingsDocument) => SettingsDocument, { surface = null }: SettingsReadOptions = {}, pathsIn: SettingsDocument = {}) => {
    return enqueue(async () => {
      await refreshCanonicalPaths(await readSettingsFromDisk({ surface }), pathsIn);
      const { current, next, changedKeys, refusedKeys, retried } = await exclusive.exclusiveSave(async (attempt) => ({ ...await applyChanges(resolveChanges, surface), retried: attempt > 1 }));
      await applyRuntimeSettings(retried ? {} : current, next, changedKeys);
      if (refusedKeys.length > 0) throw new Error(`Cannot replace unreadable preferences.json; not saved: ${refusedKeys.join(', ')}`);
      return formatSettingsResponse(next);
    });
  };

  const persistSettings = (changes: SettingsDocument, options?: SettingsReadOptions) => persistResolvedSettings(() => changes, options, changes);

  const registerSessionProject = createSessionProjectRegistrar({
    save: (operation) => enqueue(async () => {
      await refreshCanonicalPaths(await readSettingsFromDisk());
      return exclusive.exclusiveSave(operation);
    }),
    settingsFileState, readSettingsStrict: readSettingsFromDiskStrict, sanitizeProjects,
    writeSettings: (text, expectedRevision) => writeJsonFileAtomic(SETTINGS_FILE_PATH, text, { expectedRevision }),
  });

  return {
    readSettingsFromDisk,
    readSettingsFromDiskStrict,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    persistSettings,
    persistResolvedSettings,
    updateSettingsFromDisk,
    registerSessionProject,
    watchSettingsFiles: settingsFileState.watch,
    reconcileExternalSettings: exclusive.createReconcile(enqueue),
    subscribeTakenInSettings: exclusive.subscribeTakenIn,
    takeSetAsideSettingsFiles: settingsFileState.takeSetAsideFiles,
  };
};
