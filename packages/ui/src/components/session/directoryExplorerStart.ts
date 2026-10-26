const toSlashes = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Where the add-project picker starts: the folder holding the most recently
 * added project, since a new project usually sits beside the previous ones.
 * Home when there is none, shown as `~/...` when it lies under home.
 */
export const initialBrowseQuery = (
  projects: ReadonlyArray<{ path: string; addedAt?: number }>,
  homeDirectory: string,
): string => {
  let latest: { path: string; addedAt?: number } | null = null;
  for (const project of projects) {
    if (!project.path.trim()) continue;
    if (!latest || (project.addedAt ?? 0) >= (latest.addedAt ?? 0)) latest = project;
  }
  if (!latest) return '~/';
  const path = toSlashes(latest.path);
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (!parent) return '~/';
  const home = toSlashes(homeDirectory);
  if (home && parent === home) return '~/';
  if (home && parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}/`;
  return `${parent}/`;
};
