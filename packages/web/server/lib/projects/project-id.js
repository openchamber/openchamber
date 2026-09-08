const normalizeProjectPathForId = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/g, '') || value;
};

export const createProjectIdFromPath = (projectPath) => {
  const normalized = normalizeProjectPathForId(projectPath).trim();
  if (!normalized) {
    return '';
  }

  return `path_${Buffer.from(normalized, 'utf8').toString('base64url')}`;
};

/**
 * The path a `path_<base64url>` id was made from, or `''` when the id is not
 * of that form. The projects dir names files by this id, so the server can
 * find the project's checkout (and the shared config inside it) from the id
 * alone.
 */
export const projectPathFromId = (projectId) => {
  if (typeof projectId !== 'string' || !projectId.startsWith('path_')) return '';
  const encoded = projectId.slice('path_'.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return '';
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return '';
  }
};
