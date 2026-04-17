import { toNativePath } from '../PathUtils.js';

const DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
};

const PATH_KEY_MIGRATION_VERSION = 1;

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

  const writeSettingsToDisk = async (settings) => {
    try {
      await fsPromises.mkdir(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
      await fsPromises.writeFile(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), 'utf8');
    } catch (error) {
      console.warn('Failed to write settings file:', error);
      throw error;
    }
  };

  const validateProjectEntries = async (projects) => {
    console.log(`[validateProjectEntries] Starting validation for ${projects.length} projects`);

    if (!Array.isArray(projects)) {
      console.warn('[validateProjectEntries] Input is not an array, returning empty');
      return [];
    }

    const validations = projects.map(async (project) => {
      if (!project || typeof project.path !== 'string' || project.path.length === 0) {
        console.error('[validateProjectEntries] Invalid project entry: missing or empty path', project);
        return null;
      }
      try {
        const stats = await fsPromises.stat(toNativePath(project.path));
        if (!stats.isDirectory()) {
          console.error(`[validateProjectEntries] Project path is not a directory: ${project.path}`);
          return null;
        }
        return project;
      } catch (error) {
        const err = error;
        console.error(`[validateProjectEntries] Failed to validate project "${project.path}": ${err.code || err.message || err}`);
        if (err && typeof err === 'object' && err.code === 'ENOENT') {
          console.log(`[validateProjectEntries] Removing project with ENOENT: ${project.path}`);
          return null;
        }
        console.log(`[validateProjectEntries] Keeping project despite non-ENOENT error: ${project.path}`);
        return project;
      }
    });

    const results = (await Promise.all(validations)).filter((p) => p !== null);

    console.log(`[validateProjectEntries] Validation complete: ${results.length}/${projects.length} projects valid`);
    return results;
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
            const id = crypto.randomUUID();
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

  const migrateSettingsPathKeys = async (current) => {
    const settings = current && typeof current === 'object' ? current : {};
    const currentVersion = Number.isFinite(settings.pathKeyMigrationVersion)
      ? Number(settings.pathKeyMigrationVersion)
      : 0;

    if (currentVersion >= PATH_KEY_MIGRATION_VERSION) {
      return { settings, changed: false };
    }

    const normalized = normalizeSettingsPaths(settings);
    const next = {
      ...normalized.settings,
      pathKeyMigrationVersion: PATH_KEY_MIGRATION_VERSION,
    };

    const changed = normalized.changed || next.pathKeyMigrationVersion !== settings.pathKeyMigrationVersion;
    return { settings: changed ? next : settings, changed };
  };

  const readSettingsFromDiskMigrated = async () => {
    const current = await readSettingsFromDisk();
    const migration1 = await migrateSettingsFromLegacyLastDirectory(current);
    const migration2 = await migrateSettingsFromLegacyThemePreferences(migration1.settings);
    const migration3 = await migrateSettingsFromLegacyCollapsedProjects(migration2.settings);
    const migration4 = await migrateSettingsNotificationDefaults(migration3.settings);
    const migration5 = await migrateSettingsFromLegacyNamedTunnelKeys(migration4.settings);
    const migration6 = await migrateSettingsPathKeys(migration5.settings);
    if (migration1.changed || migration2.changed || migration3.changed || migration4.changed || migration5.changed || migration6.changed) {
      await writeSettingsToDisk(migration6.settings);
    }
    return migration6.settings;
  };

  const persistSettings = async (changes) => {
    persistSettingsLock = persistSettingsLock.then(async () => {
      console.log('[persistSettings] Called with changes:', JSON.stringify(changes, null, 2));
      const current = await readSettingsFromDisk();
      console.log('[persistSettings] Current projects count:', Array.isArray(current.projects) ? current.projects.length : 'N/A');
      const sanitized = sanitizeSettingsUpdate(changes);
      let next = mergePersistedSettings(current, sanitized);

      const normalizedState = normalizeSettingsPaths(next);
      if (normalizedState.changed) {
        next = normalizedState.settings;
      }

      if (Array.isArray(next.projects)) {
        console.log(`[persistSettings] Validating ${next.projects.length} projects...`);
        const validated = await validateProjectEntries(next.projects);
        console.log(`[persistSettings] After validation: ${validated.length} projects remain`);
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
      console.log(`[persistSettings] Successfully saved ${next.projects?.length || 0} projects to disk`);
      return formatSettingsResponse(next);
    });

    return persistSettingsLock;
  };

  return {
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    persistSettings,
  };
};
