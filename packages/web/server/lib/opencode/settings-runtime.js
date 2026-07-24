import { createProjectIdFromPath } from '../projects/project-id.js';

const DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
};

const ensureNotificationTemplateShape = (templates) => {
  const input = templates && typeof templates === 'object' ? templates : {};
  let changed = false;
  const next = {};

  for (const event of Object.keys(DEFAULT_NOTIFICATION_TEMPLATES)) {
    const currentEntry = input[event];
    const base = DEFAULT_NOTIFICATION_TEMPLATES[event];
    const currentTitle = typeof currentEntry?.title === 'string' ? currentEntry.title : base.title;
    const currentMessage = typeof currentEntry?.message === 'string' ? currentEntry.message : base.message;
    if (!currentEntry || typeof currentEntry.title !== 'string' || typeof currentEntry.message !== 'string') {
      changed = true;
    }
    next[event] = { title: currentTitle, message: currentMessage };
  }

  return { templates: next, changed };
};

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
  } = deps;

  let persistSettingsLock = Promise.resolve();

  // Orphan recovery is a one-shot best-effort scan: when orphans can't be
  // matched on first pass they stay on disk and every subsequent settings
  // read would re-scan them. In-process (Electron) this runs in the main
  // event loop, so hitting it 3+ times/second from fs/list, path, etc.
  // turns into perceptible UI jank for ~10-15 seconds after launch.
  // Cache the outcome for this process lifetime.
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

  const migrateProjectScopedStorage = async ({ oldId, newId, projectPath }) => {
    if (!oldId || !newId || oldId === newId) {
      return;
    }

    const oldConfigPath = path.join(PROJECTS_ROOT_DIR, `${oldId}.json`);
    const newConfigPath = path.join(PROJECTS_ROOT_DIR, `${newId}.json`);
    const oldStorageDir = path.join(PROJECTS_ROOT_DIR, oldId);
    const newStorageDir = path.join(PROJECTS_ROOT_DIR, newId);

    const [oldConfig, newConfig] = await Promise.all([
      readJsonFile(oldConfigPath),
      readJsonFile(newConfigPath),
    ]);

    if (oldConfig || newConfig) {
      const merged = mergeProjectConfigData({ oldConfig, newConfig, oldStorageDir, newStorageDir, projectPath });
      await writeJsonFile(newConfigPath, merged);
    }

    await moveDirectoryContents(oldStorageDir, newStorageDir);
    await fsPromises.rm(oldConfigPath, { force: true });
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
      nextProjects.push({ ...project, id: nextId });
    }

    if (!orphanRecoveryDone) {
      orphanRecoveryDone = true; // set before await to close races under concurrent settings reads
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

  // Orphan files are project jsons left behind from earlier random-UUID project
  // ids (they have no projectPath field and are not referenced by settings).
  // For each canonical project whose current config is empty (lost during the
  // earlier id churn), try to find a single orphan whose setup-worktree command
  // patterns uniquely match the project's basename and merge it in.
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
      const targetPath = path.join(PROJECTS_ROOT_DIR, `${project.id}.json`);

      for (const orphan of orphansForProject) {
        const targetExisting = (await readJsonFile(targetPath)) || {};
        const merged = mergeProjectConfigData({
          oldConfig: orphan.content,
          newConfig: targetExisting,
          oldStorageDir: path.join(PROJECTS_ROOT_DIR, orphan.orphanId),
          newStorageDir: path.join(PROJECTS_ROOT_DIR, project.id),
          projectPath: project.path,
        });
        await writeJsonFile(targetPath, merged);
        await moveDirectoryContents(path.join(PROJECTS_ROOT_DIR, orphan.orphanId), path.join(PROJECTS_ROOT_DIR, project.id));
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

  const readSettingsFromDisk = async () => {
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

  // Strict variant for callers that REGENERATE persisted identity when a key is
  // absent (relay signing/encryption keys). The lenient reader above maps every
  // failure — corrupt JSON, EACCES, transient I/O — to `{}`, which such callers
  // cannot distinguish from "first run": they would mint a NEW identity, orphan
  // every paired device and push binding, and overwrite the settings file with
  // the empty spread. Here only a genuinely missing file means "no settings";
  // any other failure (including a non-object payload) throws.
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

    throw lastError;
  };

  const writeSettingsToDisk = async (settings) => {
    const tmp = `${SETTINGS_FILE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let handle;
    try {
      const settingsDirectory = path.dirname(SETTINGS_FILE_PATH);
      await fsPromises.mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await fsPromises.chmod(settingsDirectory, 0o700);
      // Atomic write: Electron main and ssh-manager read this file via plain
      // readFile + JSON.parse and silently coerce parse errors to {}. A
      // partial read during a non-atomic writeFile would make their next
      // read-modify-write wipe the settings file.
      handle = await fsPromises.open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(settings, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await replaceFile(tmp, SETTINGS_FILE_PATH);
      if (process.platform !== 'win32') await fsPromises.chmod(SETTINGS_FILE_PATH, 0o600);
      try {
        const directoryHandle = await fsPromises.open(path.dirname(SETTINGS_FILE_PATH), 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch {
        // Directory fsync is not supported by every platform/filesystem.
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      console.warn('Failed to write settings file:', error);
      throw error;
    }
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
        // Permission or transient fs error — keep the project rather than
        // silently losing it from the user's list.
        return project;
      }
    });

    return (await Promise.all(validations)).filter((p) => p !== null);
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
          if (stats.isDirectory()) {
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

    const defaultLight = 'flexoki-light';
    const defaultDark = 'flexoki-dark';

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
    if (typeof settings.notifyOnError !== 'boolean') {
      next.notifyOnError = true;
      changed = true;
    }
    if (typeof settings.notifyOnQuestion !== 'boolean') {
      next.notifyOnQuestion = true;
      changed = true;
    }

    const { templates, changed: templatesChanged } = ensureNotificationTemplateShape(settings.notificationTemplates);
    if (templatesChanged || !settings.notificationTemplates || typeof settings.notificationTemplates !== 'object') {
      next.notificationTemplates = templates;
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

  // `approvedDirectories` was a write-only registry: every project path and
  // visited directory was appended forever, but nothing ever read it. Strip
  // the stale key from persisted settings on upgrade.
  const migrateSettingsRemoveApprovedDirectories = (current) => {
    const settings = current && typeof current === 'object' ? current : {};
    if (!Object.prototype.hasOwnProperty.call(settings, 'approvedDirectories')) {
      return { settings, changed: false };
    }
    const next = { ...settings };
    delete next.approvedDirectories;
    return { settings: next, changed: true };
  };

  const readSettingsFromDiskMigrated = async () => {
    const current = await readSettingsFromDisk();
    const migration1 = await migrateSettingsFromLegacyLastDirectory(current);
    const migration2 = await migrateSettingsFromLegacyThemePreferences(migration1.settings);
    const migration3 = await migrateSettingsFromLegacyCollapsedProjects(migration2.settings);
    const migration4 = await migrateSettingsNotificationDefaults(migration3.settings);
    const migration5 = await migrateSettingsFromLegacyNamedTunnelKeys(migration4.settings);
    const migration6 = normalizeSettingsPaths(migration5.settings);
    const migration7 = await migrateSettingsToDeterministicProjectIds(migration6.settings);
    const migration8 = migrateSettingsRemoveApprovedDirectories(migration7.settings);
    if (migration1.changed || migration2.changed || migration3.changed || migration4.changed || migration5.changed || migration6.changed || migration7.changed || migration8.changed) {
      await writeSettingsToDisk(migration8.settings);
    }
    return migration8.settings;
  };

  const persistSettings = async (changes) => {
    persistSettingsLock = persistSettingsLock.then(async () => {
      // Log field names only — changes can carry credentials (UI password,
      // client tokens, tunnel tokens) that must never reach the log file.
      console.log('[persistSettings] Updating fields:', Object.keys(changes || {}).join(', ') || '(none)');
      const current = await readSettingsFromDisk();
      const sanitized = sanitizeSettingsUpdate(changes);
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

      // Validating project paths hits the filesystem for every entry, so only
      // do it when the incoming update actually touches the projects list —
      // not on every theme/window-state/etc. save.
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

      await writeSettingsToDisk(next);
      return formatSettingsResponse(next);
    });

    return persistSettingsLock;
  };

  const restoreSettingsFields = async (settings, keyPrefix) => {
    persistSettingsLock = persistSettingsLock.then(async () => {
      const current = await readSettingsFromDiskStrict();
      const restored = { ...current };
      for (const key of Object.keys(restored)) {
        if (key.startsWith(keyPrefix)) delete restored[key];
      }
      for (const [key, value] of Object.entries(settings)) {
        if (key.startsWith(keyPrefix)) restored[key] = value;
      }
      await writeSettingsToDisk(restored);
      return formatSettingsResponse(restored);
    });
    return persistSettingsLock;
  };

  return {
    readSettingsFromDisk,
    readSettingsFromDiskStrict,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    persistSettings,
    restoreSettingsFields,
  };
};
