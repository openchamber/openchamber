import crypto from 'node:crypto';

const MAX_PROJECT_CONFIG_FILE_STEM_LENGTH = 200;
const HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX = 'path_sha256_';

const normalizeProjectPathForId = (value: string) => {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '') || value;
};

export const createProjectIdFromPath = (projectPath: string) => {
  const normalized = normalizeProjectPathForId(projectPath).trim();
  if (!normalized) {
    return '';
  }

  return `path_${Buffer.from(normalized, 'utf8').toString('base64url')}`;
};

export const projectPathFromId = (projectId: string) => {
  if (!projectId.startsWith('path_')) return '';
  const encoded = projectId.slice('path_'.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return '';
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return '';
  }
};

export const projectConfigFileStemOf = (projectId: string) => {
  if (projectId.length <= MAX_PROJECT_CONFIG_FILE_STEM_LENGTH) return projectId;
  const digest = crypto.createHash('sha256').update(projectId, 'utf8').digest('hex');
  return `${HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX}${digest}`;
};
