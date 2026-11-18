import { createProjectIdFromPath, projectConfigFileStemOf } from '../projects/project-id.js';
import { isMessageSearchEnabled } from './settings-helpers.js';
import {
  buildPreferencesFields,
  flattenPreferences,
  instancePartOf,
  legacySettingsDocumentOf,
  profilePartOf,
  isDeviceSettingsKey,
  isProfileSettingsKey,
  normalizeSettingsSurface,
  parsePreferencesDocument,
  preferencesFilePathFor,
  seedPreferencesFrom,
  serializePreferencesDocument,
} from './settings-files.js';

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

const isLegacySeededNotificationTemplates = (templates) => (
  Object.keys(LEGACY_SEEDED_NOTIFICATION_TEMPLATES).every((event) => {
    const legacy = LEGACY_SEEDED_NOTIFICATION_TEMPLATES[event];
    const candidate = templates?.[event];
    return candidate?.title === legacy.title && candidate?.message === legacy.message;
  })
);

const ensureNotificationTemplateShape = (templates) => {
  const input = templates && typeof templates === 'object' ? templates : {};
  let changed = false;
  const next = {};

  for (const event of Object.keys(EMPTY_NOTIFICATION_TEMPLATES)) {
    const currentEntry = input[event];
    const base = EMPTY_NOTIFICATION_TEMPLATES[event];
    const currentTitle = typeof currentEntry?.title === 'string' ? currentEntry.title : base.title;
    const currentMessage = typeof currentEntry?.message === 'string' ? currentEntry.message : base.message;
    if (!currentEntry || typeof currentEntry.title !== 'string' || typeof currentEntry.message !== 'string') {
      changed = true;
    }
    next[event] = { title: currentTitle, message: currentMessage };
  }

  return { templates: next, changed };
};

const MANAGED_PLUGIN_SETTINGS_KEYS = new Set([
  'agentControlToolEnabled',
  'agentScheduleToolEnabled',
  'agentWebToolEnabled',
  'agentMemoryToolEnabled',
  'agentKnowledgeToolEnabled',
  'agentNotifyToolEnabled',
  'agentRenderToolEnabled',
  'agentImageToolEnabled',
  'agentSecretToolEnabled',
  'agentUsageToolEnabled',
  'agentTerminalToolEnabled',
  'agentWorkflowToolEnabled',
  'fallbackModel',
  'accountSwitchProviders',
]);

export const createSettingsRuntime = (deps) => {
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
    chatRoots = [],
    onManagedPluginSettingsChanged = async () => {},
    onMessageSearchEnabledChanged = () => {},
    onMessageSearchReasoningChanged = () => {},
    onPermissionDefaultModeChanged = () => {},
    onLastDirectoryChanged = () => {},
  } = deps;

  let persistSettingsLock = Promise.resolve();

  const PREFERENCES_FILE_PATH = preferencesFilePathFor(SETTINGS_FILE_PATH, path);
  let preferencesUnavailable = false;
  let preferencesFailureLogged = false;

  let orphanRecoveryDone = false;

  const PROJECTS_ROOT_DIR = path.join(path.dirname(SETTINGS_FILE_PATH), 'projects');
  const PROJECT_ICONS_DIR = path.join(path.dirname(SETTINGS_FILE_PATH), 'project-icons');

  const sha1Hex = (value) => crypto.createHash('sha1').update(value).digest('hex');
  const projectIconBaseName = (projectId) => `project-${sha1Hex(projectId)}`;
  const PROJECT_ICON_EXTENSIONS = ['png', 'jpg', 'svg', 'webp', 'ico'];

  const readJsonFile = async (filePath) => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  const writeJsonFile = async (filePath, value) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  };

  const uniqueStrings = (values) => Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)));

  const mergeByKey = (oldItems, newItems, getKey) => {
    const result = [];
    const seen = new Set();
    for (const item of [...(Array.isArray(newItems) ? newItems : []), ...(Array.isArray(oldItems) ? oldItems : [])]) {
      if (!item || typeof item !== 'object') continue;
      const key = getKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  };

  const remapPlanPaths = (entries, fromDir, toDir) => {
    if (!Array.isArray(entries) || !fromDir || !toDir || fromDir === toDir) {
      return Array.isArray(entries) ? entries : [];
    }
    return entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
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

  const mergeProjectConfigData = ({ oldConfig, newConfig, oldStorageDir, newStorageDir, projectPath }) => {
    const oldValue = oldConfig && typeof oldConfig === 'object' ? oldConfig : {};
    const newValue = newConfig && typeof newConfig === 'object' ? newConfig : {};
    const oldPlanFiles = remapPlanPaths(oldValue.projectPlanFiles, oldStorageDir, newStorageDir);
    const newPlanFiles = remapPlanPaths(newValue.projectPlanFiles, oldStorageDir, newStorageDir);
    const oldNotes = typeof oldValue.projectNotes === 'string' ? oldValue.projectNotes : '';
    const newNotes = typeof newValue.projectNotes === 'string' ? newValue.projectNotes : '';

    return {
      ...oldValue,
      ...newValue,
      ...(typeof projectPath === 'string' && projectPath.trim().length > 0 ? { projectPath } : {}),
      ...(uniqueStrings([...(Array.isArray(oldValue['setup-worktree']) ? oldValue['setup-worktree'] : []), ...(Array.isArray(newValue['setup-worktree']) ? newValue['setup-worktree'] : [])]).length > 0
        ? { 'setup-worktree': uniqueStrings([...(Array.isArray(oldValue['setup-worktree']) ? oldValue['setup-worktree'] : []), ...(Array.isArray(newValue['setup-worktree']) ? newValue['setup-worktree'] : [])]) }
        : {}),
      ...(oldNotes || newNotes ? { projectNotes: newNotes || oldNotes } : {}),
      ...(mergeByKey(oldValue.projectTodos, newValue.projectTodos, (item) => item.id).length > 0
        ? { projectTodos: mergeByKey(oldValue.projectTodos, newValue.projectTodos, (item) => item.id) }
        : {}),
      ...(mergeByKey(oldValue.projectActions, newValue.projectActions, (item) => item.id).length > 0
        ? { projectActions: mergeByKey(oldValue.projectActions, newValue.projectActions, (item) => item.id) }
        : {}),
      ...(mergeByKey(oldValue.scheduledTasks, newValue.scheduledTasks, (item) => item.id).length > 0
        ? { scheduledTasks: mergeByKey(oldValue.scheduledTasks, newValue.scheduledTasks, (item) => item.id) }
        : {}),
      ...(mergeByKey(oldPlanFiles, newPlanFiles, (item) => item.id || item.path).length > 0
        ? { projectPlanFiles: mergeByKey(oldPlanFiles, newPlanFiles, (item) => item.id || item.path) }
        : {}),
      ...(typeof newValue.projectActionsPrimaryId === 'string' && newValue.projectActionsPrimaryId.trim().length > 0
        ? { projectActionsPrimaryId: newValue.projectActionsPrimaryId }
        : typeof oldValue.projectActionsPrimaryId === 'string' && oldValue.projectActionsPrimaryId.trim().length > 0
          ? { projectActionsPrimaryId: oldValue.projectActionsPrimaryId }
          : {}),
    };
  };

  const moveDirectoryContents = async (fromDir, toDir) => {
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
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
        throw error;
      }
    }
  };

  const migrateProjectIconFiles = async ({ oldId, newId }) => {
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
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
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

  const mergeProjectContextFiles = async (oldStorageDir, newStorageDir) => {
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

  const migrateProjectScopedStorage = async ({ oldId, newId, projectPath }) => {
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

  const migrateRawIdStorageFolder = async (projectId) => {
    const stem = projectConfigFileStemOf(projectId);
    if (stem === projectId) return;
    const rawStorageDir = path.join(PROJECTS_ROOT_DIR, projectId);
    try {
      await fsPromises.stat(rawStorageDir);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENAMETOOLONG') return;
      throw error;
    }
    const boundedStorageDir = path.join(PROJECTS_ROOT_DIR, stem);
    await mergeProjectContextFiles(rawStorageDir, boundedStorageDir);
    await moveDirectoryContents(rawStorageDir, boundedStorageDir);
  };

  const migrateSettingsToDeterministicProjectIds = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};
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

    const currentActiveId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
    const nextActiveProjectId = projectIdMap.get(currentActiveId) || currentActiveId || nextProjects[0]?.id;

    return {
      settings: {
        ...settings,
        projects: nextProjects,
        ...(nextActiveProjectId ? { activeProjectId: nextActiveProjectId } : {}),
      },
      changed: true,
    };
  };

  const recoverOrphanProjectFiles = async (canonicalProjects) => {
    let entries;
    try {
      entries = await fsPromises.readdir(PROJECTS_ROOT_DIR, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      throw error;
    }

    const canonicalIds = new Set(canonicalProjects.map((project) => project.id));
    const orphanFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .filter((id) => id && !id.startsWith('path_') && !canonicalIds.has(id));

    if (orphanFiles.length === 0) return;

    console.warn(`[projects] Found ${orphanFiles.length} orphan project config(s) without projectPath.`);

    const orphans = [];
    for (const orphanId of orphanFiles) {
      const filePath = path.join(PROJECTS_ROOT_DIR, `${orphanId}.json`);
      const content = await readJsonFile(filePath);
      if (!content) continue;
      const hasContent = [
        typeof content.projectNotes === 'string' && content.projectNotes.trim().length > 0,
        Array.isArray(content.projectTodos) && content.projectTodos.length > 0,
        Array.isArray(content.projectActions) && content.projectActions.length > 0,
        Array.isArray(content['setup-worktree']) && content['setup-worktree'].length > 0,
        Array.isArray(content.projectPlanFiles) && content.projectPlanFiles.length > 0,
      ].some(Boolean);
      if (!hasContent) continue;
      orphans.push({ orphanId, filePath, content });
    }

    if (orphans.length === 0) return;

    const basenameOf = (projectPath) => {
      if (typeof projectPath !== 'string') return '';
      const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/g, '');
      const idx = normalized.lastIndexOf('/');
      return (idx >= 0 ? normalized.slice(idx + 1) : normalized).toLowerCase();
    };

    const extractRootRelPaths = (orphan) => {
      const commands = [
        ...(Array.isArray(orphan.content['setup-worktree']) ? orphan.content['setup-worktree'] : []),
        ...(Array.isArray(orphan.content.projectActions) ? orphan.content.projectActions.map((a) => typeof a?.command === 'string' ? a.command : '') : []),
      ].filter((s) => typeof s === 'string');
      const results = new Set();
      const re = /\$(?:\{)?ROOT_(?:PROJECT|WORKTREE)_PATH\}?\/([A-Za-z0-9._/-]+)/g;
      for (const cmd of commands) {
        let match;
        while ((match = re.exec(cmd)) !== null) {
          results.add(match[1]);
        }
      }
      return Array.from(results);
    };

    const fileExistsInProject = async (projectPath, relPath) => {
      try {
        await fsPromises.access(path.join(projectPath, relPath));
        return true;
      } catch {
        return false;
      }
    };

    const orphanMatchesProject = async (orphan, project) => {
      if (typeof project.path !== 'string' || !project.path.trim()) return false;
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
        ...(Array.isArray(orphan.content.projectActions) ? orphan.content.projectActions.map((a) => `${a?.name || ''} ${a?.command || ''}`) : []),
      ].join(' ').toLowerCase();
      return haystacks.includes(name);
    };

    const matches = new Map();
    for (const orphan of orphans) {
      const matchedProjects = [];
      for (const project of canonicalProjects) {
        if (await orphanMatchesProject(orphan, project)) {
          matchedProjects.push(project);
        }
      }
      if (matchedProjects.length === 1) {
        const project = matchedProjects[0];
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

  const readInstanceSettingsFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(SETTINGS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      return {};
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {};
      }
      console.warn('Failed to read settings file:', error);
      return {};
    }
  };

  const readPreferenceFields = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(PREFERENCES_FILE_PATH, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { status: 'missing' };
      }
      if (!preferencesFailureLogged) {
        preferencesFailureLogged = true;
        console.warn('Failed to read preferences file:', error);
      }
      return { status: 'failed' };
    }
    const parsed = parsePreferencesDocument(raw);
    if (!parsed.ok) {
      if (!preferencesFailureLogged) {
        preferencesFailureLogged = true;
        console.warn(`Preferences file is unreadable (${parsed.reason}); profile writes are paused until it is fixed or removed.`);
      }
      return { status: 'failed' };
    }
    preferencesFailureLogged = false;
    return { status: 'ok', fields: parsed.fields };
  };

  const writePreferencesToDisk = async (fields) => {
    await writeJsonFileAtomic(PREFERENCES_FILE_PATH, serializePreferencesDocument(fields));
  };

  const readSettingsFromDisk = async ({ surface = null } = {}) => {
    const instance = await readInstanceSettingsFromDisk();
    const preferences = await readPreferenceFields();
    if (preferences.status === 'failed') {
      preferencesUnavailable = true;
      return instance;
    }
    preferencesUnavailable = false;
    if (preferences.status === 'missing') {
      const seeded = seedPreferencesFrom(instance, Date.now());
      try {
        await writePreferencesToDisk(seeded);
      } catch (error) {
        console.warn('Failed to seed preferences file:', error);
      }
      return instance;
    }
    return { ...instance, ...flattenPreferences(preferences.fields, normalizeSettingsSurface(surface)) };
  };

  const readSettingsFromDiskStrict = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(SETTINGS_FILE_PATH, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Settings file is malformed (non-object payload)');
    }
    return parsed;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isTransientWindowsReplaceError = (error) => {
    if (process.platform !== 'win32' || !error || typeof error !== 'object') {
      return false;
    }
    return error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
  };

  const replaceFile = async (tmp, target) => {
    const maxAttempts = process.platform === 'win32' ? 6 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await fsPromises.rename(tmp, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientWindowsReplaceError(error) || attempt === maxAttempts) {
          break;
        }
        await sleep(25 * attempt);
      }
    }

    if (!isTransientWindowsReplaceError(lastError)) {
      throw lastError;
    }

    try {
      await fsPromises.copyFile(tmp, target);
    } finally {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
    }
  };

  const cleanupOrphanedSettingsTempFiles = async (directory) => {
    try {
      const entries = await fsPromises.readdir(directory, { withFileTypes: true });
      const cleanupTasks = entries
        .filter((entry) => entry.isFile() && (entry.name.startsWith('settings.json.tmp-') || entry.name.startsWith('preferences.json.tmp-')))
        .map((entry) => fsPromises.rm(path.join(directory, entry.name), { force: true }).catch(() => {}));
      await Promise.all(cleanupTasks);
    } catch {
      // Best-effort cleanup: errors reading directory must not fail settings operations
    }
  };

  const writeJsonFileAtomic = async (filePath, text) => {
    const directory = path.dirname(filePath);
    const created = await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (created && process.platform !== 'win32') await fsPromises.chmod(directory, 0o700);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') await fsPromises.chmod(tmp, 0o600);
      await replaceFile(tmp, filePath);
      if (process.platform !== 'win32') await fsPromises.chmod(filePath, 0o600);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      console.warn(`Failed to write ${path.basename(filePath)}:`, error);
      throw error;
    }
  };

  const writeSettingsToDisk = async (settings, { surface = null, changedKeys = null } = {}) => {
    const current = preferencesUnavailable ? { status: 'failed' } : await readPreferenceFields();
    if (current.status === 'failed') {
      preferencesUnavailable = true;
      const onDisk = await readInstanceSettingsFromDisk();
      await writeJsonFileAtomic(SETTINGS_FILE_PATH, JSON.stringify({
        ...instancePartOf(settings),
        ...profilePartOf(onDisk),
      }, null, 2));
      return;
    }
    const previousFields = current.status === 'ok' ? current.fields : {};
    const nextFields = buildPreferencesFields(previousFields, settings, Date.now(), {
      surface: normalizeSettingsSurface(surface),
      changedKeys,
    });
    await writeJsonFileAtomic(SETTINGS_FILE_PATH, JSON.stringify(legacySettingsDocumentOf(settings, nextFields), null, 2));
    await writePreferencesToDisk(nextFields);
  };

  const validateProjectEntries = async (projects) => {
    if (!Array.isArray(projects)) {
      return [];
    }

    const validations = projects.map(async (project) => {
      if (!project || typeof project.path !== 'string' || project.path.length === 0) {
        console.warn('[validateProjectEntries] Dropping project entry with missing or empty path');
        return null;
      }
      try {
        const stats = await fsPromises.stat(project.path);
        if (!stats.isDirectory()) {
          console.warn(`[validateProjectEntries] Dropping project — path is not a directory: ${project.path}`);
          return null;
        }
        return project;
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
          console.warn(`[validateProjectEntries] Dropping project — directory no longer exists: ${project.path}`);
          return null;
        }
        return project;
      }
    });

    return (await Promise.all(validations)).filter((p) => p !== null);
  };

  const isWithinRoot = (candidate, root) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };

  const isChatDirectory = async (candidate) => {
    const roots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
    if (roots.some((root) => isWithinRoot(candidate, root))) {
      return true;
    }
    const realCandidate = await fsPromises.realpath(candidate);
    const realRoots = await Promise.all(roots.map((root) => fsPromises.realpath(root).catch(() => null)));
    return realRoots.some((root) => root && isWithinRoot(realCandidate, root));
  };

  const migrateSettingsFromLegacyLastDirectory = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};
    const now = Date.now();

    const sanitizedProjects = sanitizeProjects(settings.projects) || [];
    let nextProjects = sanitizedProjects;
    let nextActiveProjectId =
      typeof settings.activeProjectId === 'string' ? settings.activeProjectId : undefined;

    let changed = false;

    if (nextProjects.length === 0) {
      const legacy = typeof settings.lastDirectory === 'string' ? settings.lastDirectory.trim() : '';
      const candidate = legacy ? resolveDirectoryCandidate(legacy) : null;

      if (candidate) {
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
          // ignore invalid lastDirectory
        }
      }
    }

    if (nextProjects.length > 0) {
      const active = nextProjects.find((project) => project.id === nextActiveProjectId) || null;
      if (!active) {
        nextActiveProjectId = nextProjects[0].id;
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

  const migrateSettingsFromLegacyThemePreferences = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};

    const themeId = typeof settings.themeId === 'string' ? settings.themeId.trim() : '';
    const themeVariant = typeof settings.themeVariant === 'string' ? settings.themeVariant.trim() : '';

    const hasLight = typeof settings.lightThemeId === 'string' && settings.lightThemeId.trim().length > 0;
    const hasDark = typeof settings.darkThemeId === 'string' && settings.darkThemeId.trim().length > 0;

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

    const merged = mergePersistedSettings(settings, {
      ...settings,
      ...(nextLightThemeId ? { lightThemeId: nextLightThemeId } : {}),
      ...(nextDarkThemeId ? { darkThemeId: nextDarkThemeId } : {}),
    });

    return { settings: merged, changed: true };
  };

  const migrateSettingsFromLegacyCollapsedProjects = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};
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

    const next = { ...settings, projects: nextProjects };
    delete next.collapsedProjects;
    return { settings: next, changed: true };
  };

  const migrateSettingsNotificationDefaults = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};
    let changed = false;
    const next = { ...settings };

    if (typeof settings.notifyOnSubtasks !== 'boolean') {
      next.notifyOnSubtasks = true;
      changed = true;
    }
    if (typeof settings.notifyOnCompletion !== 'boolean') {
      next.notifyOnCompletion = true;
      changed = true;
    }
    if (settings.notifyOnPullRequests !== true && settings.notifyOnPullRequests !== false) {
      next.notifyOnPullRequests = true;
      changed = true;
    }
    if (typeof settings.notifyOnError !== 'boolean') {
      next.notifyOnError = true;
      changed = true;
    }
    if (typeof settings.notifyOnQuestion !== 'boolean') {
      next.notifyOnQuestion = true;
      changed = true;
    }

    const { templates, changed: templatesChanged } = ensureNotificationTemplateShape(settings.notificationTemplates);
    const wasSeeded = isLegacySeededNotificationTemplates(templates);
    const nextTemplates = wasSeeded ? emptyNotificationTemplates() : templates;
    if (
      templatesChanged
      || wasSeeded
      || !settings.notificationTemplates
      || typeof settings.notificationTemplates !== 'object'
    ) {
      next.notificationTemplates = nextTemplates;
      changed = true;
    }

    return { settings: changed ? next : settings, changed };
  };

  const migrateSettingsFromLegacyNamedTunnelKeys = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};
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
      } else if (typeof next.namedTunnelToken === 'string') {
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
      const selectedPresetId = typeof next.namedTunnelSelectedPresetId === 'string'
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

  const migrateSettingsRemoveApprovedDirectories = (current) => {
    const settings = current && typeof current === 'object' ? current : {};
    if (!Object.prototype.hasOwnProperty.call(settings, 'approvedDirectories')) {
      return { settings, changed: false };
    }
    const next = { ...settings };
    delete next.approvedDirectories;
    return { settings: next, changed: true };
  };

  const migrateSettingsScheduleToolFromControl = (settings) => {
    const chosen = settings.agentScheduleToolEnabled === true || settings.agentScheduleToolEnabled === false;
    if (settings.agentControlToolEnabled !== false || chosen) {
      return { settings, changed: false };
    }
    return { settings: { ...settings, agentScheduleToolEnabled: false }, changed: true };
  };

  let hasCleanedOrphanedTempFiles = false;

  const readSettingsFromDiskMigrated = async ({ surface = null } = {}) => {
    if (!hasCleanedOrphanedTempFiles) {
      hasCleanedOrphanedTempFiles = true;
      await cleanupOrphanedSettingsTempFiles(path.dirname(SETTINGS_FILE_PATH));
    }
    const current = await readSettingsFromDisk();
    const migration1 = await migrateSettingsFromLegacyLastDirectory(current);
    const migration2 = await migrateSettingsFromLegacyThemePreferences(migration1.settings);
    const migration3 = await migrateSettingsFromLegacyCollapsedProjects(migration2.settings);
    const migration4 = await migrateSettingsNotificationDefaults(migration3.settings);
    const migration5 = await migrateSettingsFromLegacyNamedTunnelKeys(migration4.settings);
    const migration6 = normalizeSettingsPaths(migration5.settings);
    const migration7 = await migrateSettingsToDeterministicProjectIds(migration6.settings);
    const migration8 = migrateSettingsRemoveApprovedDirectories(migration7.settings);
    const migration9 = migrateSettingsScheduleToolFromControl(migration8.settings);
    if (migration1.changed || migration2.changed || migration3.changed || migration4.changed || migration5.changed || migration6.changed || migration7.changed || migration8.changed || migration9.changed) {
      await writeSettingsToDisk(migration9.settings);
    }
    return normalizeSettingsSurface(surface) ? readSettingsFromDisk({ surface }) : migration9.settings;
  };

  const persistResolvedSettings = async (resolveChanges, { surface = null } = {}) => {
    const result = persistSettingsLock.then(async () => {
      const current = await readSettingsFromDisk({ surface });
      const changes = resolveChanges(current);
      console.log('[persistSettings] Updating fields:', Object.keys(changes || {}).join(', ') || '(none)');
      const sanitized = sanitizeSettingsUpdate(changes);
      for (const key of Object.keys(sanitized)) {
        if (isDeviceSettingsKey(key)) {
          delete sanitized[key];
        } else if (preferencesUnavailable && isProfileSettingsKey(key)) {
          console.warn(`[persistSettings] Dropping ${key}: preferences file is unreadable`);
          delete sanitized[key];
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

      if (Object.prototype.hasOwnProperty.call(sanitized, 'projects') && Array.isArray(next.projects)) {
        const validated = await validateProjectEntries(next.projects);
        next = { ...next, projects: validated };
      }

      if (Array.isArray(next.projects) && next.projects.length > 0) {
        const activeId = typeof next.activeProjectId === 'string' ? next.activeProjectId : '';
        const active = next.projects.find((project) => project.id === activeId) || null;
        if (!active) {
          console.log(`[persistSettings] Active project ID ${activeId} not found, switching to ${next.projects[0].id}`);
          next = { ...next, activeProjectId: next.projects[0].id };
        }
      } else if (next.activeProjectId) {
        console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
        next = { ...next, activeProjectId: undefined };
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresets')) {
        await syncManagedRemoteTunnelConfigWithPresets(next.managedRemoteTunnelPresets);
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresetTokens') && sanitized.managedRemoteTunnelPresetTokens) {
        const presetsById = new Map((next.managedRemoteTunnelPresets || []).map((entry) => [entry.id, entry]));
        const updates = Object.entries(sanitized.managedRemoteTunnelPresetTokens)
          .map(([presetId, token]) => {
            const preset = presetsById.get(presetId);
            if (!preset || typeof token !== 'string' || token.trim().length === 0) {
              return null;
            }
            return {
              id: preset.id,
              name: preset.name,
              hostname: preset.hostname,
              token: token.trim(),
            };
          })
          .filter(Boolean);

        for (const update of updates) {
          await upsertManagedRemoteTunnelToken(update);
        }
      }

      const changedKeys = Object.keys(sanitized);
      await writeSettingsToDisk(next, { surface, changedKeys });
      if (changedKeys.some((key) => MANAGED_PLUGIN_SETTINGS_KEYS.has(key))) {
        await Promise.resolve(onManagedPluginSettingsChanged(next)).catch((error) => {
          console.warn('Failed to refresh the managed OpenCode config:', error?.message ?? error);
        });
      }
      if (changedKeys.includes('messageSearchEnabled')) {
        onMessageSearchEnabledChanged(isMessageSearchEnabled(next));
      }
      if (changedKeys.includes('messageSearchReasoningEnabled')) {
        onMessageSearchReasoningChanged(next.messageSearchReasoningEnabled === true);
      }
      if (changedKeys.includes('permissionDefaultMode') && next.permissionDefaultMode !== current.permissionDefaultMode) {
        onPermissionDefaultModeChanged(next.permissionDefaultMode);
      }
      if (changedKeys.includes('lastDirectory') && next.lastDirectory !== current.lastDirectory) {
        onLastDirectoryChanged(next.lastDirectory);
      }
      return formatSettingsResponse(next);
    });
    persistSettingsLock = result.catch(() => {});
    return result;
  };

  const persistSettings = (changes, options) => persistResolvedSettings(() => changes, options);

  const registerSessionProject = (resolveProject) => {
    const result = persistSettingsLock.then(async () => {
      const current = await readSettingsFromDiskStrict();
      if (Array.isArray(current) || (current.projects !== undefined && !Array.isArray(current.projects))) {
        throw new Error('Project registry is malformed');
      }
      const projects = sanitizeProjects(current.projects) || [];
      const project = await resolveProject(projects);
      if (!projects.some((entry) => entry.id === project.id)) {
        await writeJsonFileAtomic(SETTINGS_FILE_PATH, JSON.stringify({ ...current, projects: [...(current.projects || []), project] }, null, 2));
      }
      return project;
    });
    persistSettingsLock = result.catch(() => {});
    return result;
  };

  return {
    readSettingsFromDisk,
    readSettingsFromDiskStrict,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    persistSettings,
    persistResolvedSettings,
    registerSessionProject,
  };
};
