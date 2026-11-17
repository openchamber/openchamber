import { createRealpathCache } from '../path-realpath-cache.js';

const safeDecodeMarkedURIComponent = (value, encoding) => {
  if (encoding !== 'uri') return value;
  try { return decodeURIComponent(value); } catch { return value; }
};

export const createProjectDirectoryRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    normalizeDirectoryPath,
    readSettingsFromDiskMigrated,
    getReadSettingsFromDiskMigrated,
    sanitizeProjects,
    refuseDirectory = () => null,
  } = dependencies;
  const realpathCache = createRealpathCache({
    realpath: fsPromises.realpath.bind(fsPromises),
  });

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
    const refusal = refuseDirectory(resolved);
    if (typeof refusal === 'string' && refusal.length > 0) {
      return { ok: false, error: refusal };
    }
    try {
      const stats = await fsPromises.stat(resolved);
      if (!stats.isDirectory()) {
        return { ok: false, error: 'Specified path is not a directory' };
      }
      const realPath = await realpathCache.resolve(resolved);
      return { ok: true, directory: realPath, requestedDirectory: resolved };
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
    const rawHeaderDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const headerEncoding = typeof req.get === 'function' ? req.get('x-opencode-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requested = [headerDirectory, queryDirectory].filter(Boolean);

    if (requested.length > 0) {
      let lastError = null;
      for (const candidate of requested) {
        const validated = await validateDirectoryPath(candidate);
        if (validated.ok) {
          return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
        }
        lastError = validated.error;
      }
      return { directory: null, requestedDirectory: null, error: lastError };
    }

    const readSettings = typeof getReadSettingsFromDiskMigrated === 'function'
      ? getReadSettingsFromDiskMigrated()
      : readSettingsFromDiskMigrated;
    const settings = await readSettings();

    if (typeof settings.lastDirectory === 'string' && settings.lastDirectory.trim()) {
      const validated = await validateDirectoryPath(settings.lastDirectory);
      if (validated.ok) {
        return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
      }
    }

    const projects = sanitizeProjects(settings.projects) || [];
    if (projects.length === 0) {
      return { directory: null, requestedDirectory: null, error: 'Directory parameter or active project is required' };
    }

    const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
    const active = projects.find((project) => project.id === activeId) || projects[0];
    if (!active || !active.path) {
      return { directory: null, requestedDirectory: null, error: 'Directory parameter or active project is required' };
    }

    const validated = await validateDirectoryPath(active.path);
    if (!validated.ok) {
      return { directory: null, requestedDirectory: null, error: validated.error };
    }

    return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
  };

  const resolveOptionalProjectDirectory = async (req) => {
    const rawHeaderDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const headerEncoding = typeof req.get === 'function' ? req.get('x-opencode-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requested = [headerDirectory, queryDirectory].filter(Boolean);

    if (requested.length === 0) {
      return { directory: null, requestedDirectory: null, error: null };
    }

    let lastError = null;
    for (const candidate of requested) {
      const validated = await validateDirectoryPath(candidate);
      if (validated.ok) {
        return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
      }
      lastError = validated.error;
    }
    return { directory: null, requestedDirectory: null, error: lastError };
  };

  return {
    resolveDirectoryCandidate,
    validateDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
  };
};
