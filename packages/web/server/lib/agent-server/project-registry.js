import path from 'node:path';
import { z } from 'zod';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';

const refusal = (code) => Object.assign(new Error(code), { code });
const SPACE_ROOTS = ['/spaces', '/var/lib/openchamber-spaces', '/var/lib/private/openchamber-spaces', '/var/lib/openchamber-hostd/spaces'];

// A project folder as the registry keeps it: absolute, normalized, trimmed and free of control characters.
const registryPathSchema = z.string().min(1).max(4096).refine((value) => value === value.trim()
  && !/[\x00-\x1f\x7f\\]/.test(value) && path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && value !== '/' && !value.endsWith('/'));
// A registry entry names its project with an id that is not blank.
const registryEntrySchema = z.object({ id: z.string().refine((id) => id.trim() !== '') });

/** No stat, realpath, home expansion, or agent-provided ownership claim. */
export const normalizeRegistryProjectPath = (value) => {
  if (!registryPathSchema.safeParse(value).success) throw refusal('project_path_invalid');
  if (SPACE_ROOTS.some((root) => value === root || value.startsWith(`${root}/`))) {
    throw refusal('space_project_refused');
  }
  return value;
};

// Reuse the normal record projection without either filesystem dependency.
const lexical = createSettingsNormalizationRuntime({
  path: path.posix,
  os: { homedir: () => { throw refusal('project_path_invalid'); } },
  processLike: { platform: 'linux' },
});

export const sanitizeRegistryProjects = (projects) => {
  if (!Array.isArray(projects)) throw refusal('project_registry_invalid');
  const ids = new Set();
  const paths = new Set();
  for (const project of projects) {
    if (!registryEntrySchema.safeParse(project).success) throw refusal('project_registry_invalid');
    normalizeRegistryProjectPath(project.path);
    const id = project.id.trim();
    if (ids.has(id) || paths.has(project.path)) throw refusal('project_registry_invalid');
    ids.add(id);
    paths.add(project.path);
  }
  return lexical.sanitizeProjects(projects);
};

export const createProjectRegistry = ({
  ownsProject = async () => false,
  shareProject = async () => { throw refusal('share_project_unavailable'); },
} = {}) => {
  const authorizeProject = async (value) => {
    const directory = normalizeRegistryProjectPath(value);
    if (await ownsProject(directory) !== true) await shareProject(directory);
    return directory;
  };

  // The settings runtime calls this inside its write lock, before any write.
  const beforeProjectsSave = async (projects, currentProjects = []) => {
    const next = sanitizeRegistryProjects(projects);
    const knownPaths = new Set(currentProjects.map((project) => project?.path));
    for (const project of next) {
      if (knownPaths.has(project.path)) continue;
      await authorizeProject(project.path);
      knownPaths.add(project.path);
    }
  };

  return { authorizeProject, beforeProjectsSave };
};
