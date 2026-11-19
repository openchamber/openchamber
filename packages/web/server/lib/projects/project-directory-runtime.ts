import { createRealpathCache } from '../path-realpath-cache.js';
import type { promises as nodeFsPromises } from 'node:fs';
import type { PlatformPath } from 'node:path';
import type { Request } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { DirectoryValidation, SessionProject } from './contracts.js';

type ReadDirectorySettings = () => Promise<JsonObject>;
type DirectorySettingsSource =
  | { readSettingsFromDiskMigrated: ReadDirectorySettings; getReadSettingsFromDiskMigrated?: never }
  | { readSettingsFromDiskMigrated?: ReadDirectorySettings; getReadSettingsFromDiskMigrated: () => ReadDirectorySettings };

export type ProjectDirectoryDependencies = DirectorySettingsSource & {
  fsPromises: Pick<typeof nodeFsPromises, 'realpath' | 'stat'>;
  path: Pick<PlatformPath, 'resolve'>;
  normalizeDirectoryPath: (value: string) => string;
  sanitizeProjects: (value: JsonValue | undefined) => SessionProject[] | null | undefined;
  refuseDirectory?: (candidate: string) => string | null;
};

export type ProjectDirectoryRequest = Partial<Pick<Request, 'get' | 'query'>>;
export type ProjectDirectoryValidation =
  | (DirectoryValidation & { ok: true; requestedDirectory: string })
  | Extract<DirectoryValidation, { ok: false }>;
export interface ProjectDirectoryResolution {
  directory: string | null;
  requestedDirectory: string | null;
  error: string | null;
}

const isDirectoryString = (value: unknown): value is string => typeof value === 'string';
const isDirectoryError = (value: unknown): value is { code?: unknown } => Boolean(value && typeof value === 'object');

const safeDecodeMarkedURIComponent = (value: string, encoding: string | null | undefined) => {
  if (encoding !== 'uri') return value;
  try { return decodeURIComponent(value); } catch { return value; }
};

export const createProjectDirectoryRuntime = (dependencies: ProjectDirectoryDependencies) => {
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

  const resolveDirectoryCandidate = (value: JsonValue | undefined) => {
    if (!isDirectoryString(value)) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = normalizeDirectoryPath(trimmed);
    return path.resolve(normalized);
  };

  const validateDirectoryPath = async (candidate: JsonValue | undefined): Promise<ProjectDirectoryValidation> => {
    const resolved = resolveDirectoryCandidate(candidate);
    if (!resolved) {
      return { ok: false, error: 'Directory parameter is required' };
    }
    const refusal = refuseDirectory(resolved);
    if (refusal !== null && refusal.length > 0) {
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
      if (isDirectoryError(err) && err.code === 'ENOENT') {
        return { ok: false, error: 'Directory not found' };
      }
      if (isDirectoryError(err) && err.code === 'EACCES') {
        return { ok: false, error: 'Access to directory denied' };
      }
      return { ok: false, error: 'Failed to validate directory' };
    }
  };

  const resolveProjectDirectory = async (req: ProjectDirectoryRequest): Promise<ProjectDirectoryResolution> => {
    const rawHeaderDirectory = req.get ? req.get('x-opencode-directory') : null;
    const headerEncoding = req.get ? req.get('x-opencode-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requested = [headerDirectory, queryDirectory].filter(Boolean);

    if (requested.length > 0) {
      let lastError: string | null = null;
      for (const candidate of requested) {
        const validated = await validateDirectoryPath(candidate);
        if (validated.ok) {
          return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
        }
        lastError = validated.error;
      }
      return { directory: null, requestedDirectory: null, error: lastError };
    }

    const readSettings = getReadSettingsFromDiskMigrated
      ? getReadSettingsFromDiskMigrated()
      : readSettingsFromDiskMigrated;
    const settings = await readSettings();

    if (isDirectoryString(settings.lastDirectory) && settings.lastDirectory.trim()) {
      const validated = await validateDirectoryPath(settings.lastDirectory);
      if (validated.ok) {
        return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
      }
    }

    const projects = sanitizeProjects(settings.projects) || [];
    if (projects.length === 0) {
      return { directory: null, requestedDirectory: null, error: 'Directory parameter or active project is required' };
    }

    const activeId = isDirectoryString(settings.activeProjectId) ? settings.activeProjectId : '';
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

  const resolveOptionalProjectDirectory = async (req: ProjectDirectoryRequest): Promise<ProjectDirectoryResolution> => {
    const rawHeaderDirectory = req.get ? req.get('x-opencode-directory') : null;
    const headerEncoding = req.get ? req.get('x-opencode-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requested = [headerDirectory, queryDirectory].filter(Boolean);

    if (requested.length === 0) {
      return { directory: null, requestedDirectory: null, error: null };
    }

    let lastError: string | null = null;
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
