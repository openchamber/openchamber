import { createProjectIdFromPath } from '../projects/project-id.js';

const normalizeComparablePath = (pathModule, value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = pathModule.normalize(value.trim()).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export const createCodexProjectRegistrar = ({ fsPromises, path, updateSettings, sanitizeProjects }) => {
  return async (projectPaths) => {
    const available = [];
    let unavailable = 0;

    for (const projectPath of projectPaths) {
      try {
        const stat = await fsPromises.stat(projectPath);
        if (!stat.isDirectory()) {
          unavailable += 1;
          continue;
        }
        available.push(projectPath);
      } catch {
        unavailable += 1;
      }
    }

    let added = 0;
    let existing = 0;
    await updateSettings((settings) => {
      const projects = sanitizeProjects(settings?.projects) || [];
      const knownPaths = new Set(projects.map((project) => normalizeComparablePath(path, project.path)));
      const additions = [];
      const now = Date.now();

      for (const projectPath of available) {
        const comparable = normalizeComparablePath(path, projectPath);
        if (knownPaths.has(comparable)) {
          existing += 1;
          continue;
        }
        additions.push({
          id: createProjectIdFromPath(projectPath),
          path: projectPath,
          addedAt: now,
          lastOpenedAt: now,
        });
        knownPaths.add(comparable);
        added += 1;
      }

      return additions.length > 0 ? { projects: [...projects, ...additions] } : null;
    });

    return { added, existing, unavailable };
  };
};
