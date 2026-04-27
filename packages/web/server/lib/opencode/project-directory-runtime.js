export const createProjectDirectoryRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    normalizeDirectoryPath,
    readSettingsFromDiskMigrated,
    getReadSettingsFromDiskMigrated,
    sanitizeProjects,
  } = dependencies;

  const getRequestedDirectory = (req) => {
    const neutralHeader = typeof req.get === 'function' ? req.get('x-openchamber-directory') : null;
    const legacyHeader = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    return neutralHeader || legacyHeader || queryDirectory || null;
  };

  const resolveDirectoryCandidate = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = normalizeDirectoryPath(trimmed);
    return path.resolve(normalized);
  };

  const validateDirectoryPath = async (candidate) => {
    const resolved = resolveDirectoryCandidate(candidate);
    if (!resolved) {
      return { ok: false, error: 'Directory parameter is required' };
    }
    try {
      const stats = await fsPromises.stat(resolved);
      if (!stats.isDirectory()) {
        return { ok: false, error: 'Specified path is not a directory' };
      }
      return { ok: true, directory: resolved };
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return { ok: false, error: 'Directory not found' };
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return { ok: false, error: 'Access to directory denied' };
      }
      return { ok: false, error: 'Failed to validate directory' };
    }
  };

  const resolveProjectDirectory = async (req) => {
    const requested = getRequestedDirectory(req);

    if (requested) {
      const validated = await validateDirectoryPath(requested);
      if (!validated.ok) {
        return { directory: null, error: validated.error };
      }
      return { directory: validated.directory, error: null };
    }

    const readSettings = typeof getReadSettingsFromDiskMigrated === 'function'
      ? getReadSettingsFromDiskMigrated()
      : readSettingsFromDiskMigrated;
    const settings = await readSettings();

    // `lastDirectory` reflects the directory the UI is currently browsing —
    // useDirectoryStore.setDirectory() persists it on every navigation.
    // Prefer it over activeProjectId, because the user may have navigated
    // away from the project that was last "clicked" in the sidebar (e.g. via
    // `go to parent`, directory picker, or a deep link), leaving
    // activeProjectId stale. Fetches scoped to the stale project would 400
    // with "Path is outside of active workspace".
    if (typeof settings.lastDirectory === 'string' && settings.lastDirectory.trim()) {
      const validated = await validateDirectoryPath(settings.lastDirectory);
      if (validated.ok) {
        return { directory: validated.directory, error: null };
      }
    }

    const projects = sanitizeProjects(settings.projects) || [];
    if (projects.length === 0) {
      return { directory: null, error: 'Directory parameter or active project is required' };
    }

    const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
    const active = projects.find((project) => project.id === activeId) || projects[0];
    if (!active || !active.path) {
      return { directory: null, error: 'Directory parameter or active project is required' };
    }

    const validated = await validateDirectoryPath(active.path);
    if (!validated.ok) {
      return { directory: null, error: validated.error };
    }

    return { directory: validated.directory, error: null };
  };

  const resolveOptionalProjectDirectory = async (req) => {
    const requested = getRequestedDirectory(req);

    if (!requested) {
      return { directory: null, error: null };
    }

    const validated = await validateDirectoryPath(requested);
    if (!validated.ok) {
      return { directory: null, error: validated.error };
    }

    return { directory: validated.directory, error: null };
  };

  return {
    resolveDirectoryCandidate,
    validateDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
  };
};
