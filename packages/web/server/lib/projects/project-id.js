import crypto from 'node:crypto';

// The longest stem `<stem>.json` may have and still leave room, inside the
// 255-byte file name limit, for the atomic-write `.tmp-<pid>-<ms>-<random>`
// suffix and the `.json.lock` sibling. Ids are ASCII, so characters are bytes.
const MAX_PROJECT_CONFIG_FILE_STEM_LENGTH = 200;
const HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX = 'path_sha256_';

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

/**
 * The stem of everything a project owns in the projects dir: the per-user
 * config file `<projectsDir>/<stem>.json` and the sibling folder
 * `<projectsDir>/<stem>/` (context, plans, memory). It is the id itself while
 * that fits a file name. A `path_<base64url>` id grows with the checkout path,
 * so a deeply nested project would otherwise get a name the filesystem
 * rejects (ENAMETOOLONG); such an id maps to a fixed-length digest instead.
 * The digest keeps the `path_` prefix so the orphan recovery in
 * `opencode/settings-runtime.js` never mistakes the file for a leftover of the
 * random-id era. The VS Code extension host applies the same rule
 * (`packages/vscode/src/bridge-project-setup-runtime.ts`); keep the two in sync.
 */
export const projectConfigFileStemOf = (projectId) => {
  if (projectId.length <= MAX_PROJECT_CONFIG_FILE_STEM_LENGTH) return projectId;
  const digest = crypto.createHash('sha256').update(projectId, 'utf8').digest('hex');
  return `${HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX}${digest}`;
};
